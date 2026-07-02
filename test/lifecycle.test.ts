import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Pool } from '@codity/db';
import {
  enqueueJob,
  enqueueBatch,
  claimJobs,
  startJob,
  completeJob,
  failJob,
  registerWorker,
  getJob,
} from '@codity/core';
import { testPool, resetDb, seedQueue } from './helpers.js';

describe('job lifecycle + audit trail', () => {
  const pool: Pool = testPool(10);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('queued -> claimed -> running -> completed with execution + transition rows', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    const { job } = await enqueueJob(pool, { queueId, payload: { x: 1 } });
    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });

    const [claimed] = await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 1, lockDurationMs: 30_000 });
    expect(claimed!.status).toBe('claimed');
    expect(claimed!.claimed_by).toBe(worker.id);

    const started = await startJob(pool, job.id, worker.id);
    expect(started).not.toBeNull();
    expect(started!.job.status).toBe('running');
    expect(started!.job.attempts).toBe(1);

    const completed = await completeJob(pool, job.id, worker.id, { ok: true });
    expect(completed!.status).toBe('completed');
    expect(completed!.result).toEqual({ ok: true });

    // Exactly one execution row (attempt 1), succeeded, with a duration.
    const execs = await pool.query(
      `SELECT attempt_number, status, duration_ms FROM job_executions WHERE job_id=$1`,
      [job.id],
    );
    expect(execs.rows).toHaveLength(1);
    expect(execs.rows[0]!.status).toBe('succeeded');
    expect(execs.rows[0]!.attempt_number).toBe(1);
    expect(execs.rows[0]!.duration_ms).toBeGreaterThanOrEqual(0);

    // Full transition trail: enqueued -> claimed -> running -> completed.
    const trail = await pool.query<{ to_status: string }>(
      `SELECT to_status FROM job_state_transitions WHERE job_id=$1 ORDER BY id`,
      [job.id],
    );
    expect(trail.rows.map((r) => r.to_status)).toEqual(['queued', 'claimed', 'running', 'completed']);
  });

  it('records a failed execution on failure', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    const { job } = await enqueueJob(pool, { queueId });
    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });
    await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 1, lockDurationMs: 30_000 });
    await startJob(pool, job.id, worker.id);

    const failed = await failJob(pool, job.id, worker.id, new Error('boom'));
    expect(failed!.status).toBe('failed');
    expect(failed!.last_error).toBe('boom');

    const exec = await pool.query(
      `SELECT status, error_message FROM job_executions WHERE job_id=$1 ORDER BY attempt_number DESC LIMIT 1`,
      [job.id],
    );
    expect(exec.rows[0]!.status).toBe('failed');
    expect(exec.rows[0]!.error_message).toBe('boom');
  });

  it('idempotency key returns the same job instead of enqueuing a duplicate', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    const first = await enqueueJob(pool, { queueId, idempotencyKey: 'order-42' });
    const second = await enqueueJob(pool, { queueId, idempotencyKey: 'order-42' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE queue_id=$1`,
      [queueId],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it('a future run_at enqueues the job as scheduled, not queued', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    const { job } = await enqueueJob(pool, { queueId, runAt: new Date(Date.now() + 60_000) });
    expect(job.status).toBe('scheduled');

    // Scheduled jobs are not claimable until promoted (Phase 6).
    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });
    const claimed = await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 5, lockDurationMs: 30_000 });
    expect(claimed).toHaveLength(0);
  });

  it('enqueueBatch creates a batch with N member jobs', async () => {
    const { projectId, queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    const { batchId, jobs } = await enqueueBatch(pool, projectId, 'nightly', [
      { queueId, payload: { i: 1 } },
      { queueId, payload: { i: 2 } },
      { queueId, payload: { i: 3 } },
    ]);
    expect(jobs).toHaveLength(3);
    for (const j of jobs) {
      const fresh = await getJob(pool, j.id);
      expect(fresh!.batch_id).toBe(batchId);
    }
    const rollup = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE batch_id=$1`,
      [batchId],
    );
    expect(rollup.rows[0]!.n).toBe(3);
  });
});
