import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Pool } from '@codity/db';
import {
  enqueueJob,
  claimJobs,
  startJob,
  heartbeatJobs,
  requeueExpiredJobs,
  registerWorker,
  getJob,
} from '@codity/core';
import { testPool, resetDb, seedQueue } from './helpers.js';

/** Simulate missed heartbeats by pushing the job's lock into the past. */
async function expireLock(pool: Pool, jobId: string): Promise<void> {
  await pool.query(`UPDATE jobs SET lock_expires_at = now() - interval '1 minute' WHERE id=$1`, [jobId]);
}

describe('reaper: crash recovery via lock expiry', () => {
  const pool: Pool = testPool(10);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('requeues a job whose worker died mid-execution', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    const { job } = await enqueueJob(pool, { queueId });
    const worker = await registerWorker(pool, { name: 'dying-worker', concurrency: 1 });

    await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 1, lockDurationMs: 30_000 });
    await startJob(pool, job.id, worker.id); // now 'running', attempt 1

    // Worker "crashes": heartbeats stop, lock expires.
    await expireLock(pool, job.id);

    const { requeuedJobIds } = await requeueExpiredJobs(pool);
    expect(requeuedJobIds).toContain(job.id);

    const fresh = await getJob(pool, job.id);
    expect(fresh!.status).toBe('queued');
    expect(fresh!.claimed_by).toBeNull();
    expect(fresh!.lock_expires_at).toBeNull();
    // The attempt that was in flight is closed out as failed.
    const exec = await pool.query<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM job_executions WHERE job_id=$1 ORDER BY attempt_number DESC LIMIT 1`,
      [job.id],
    );
    expect(exec.rows[0]!.status).toBe('failed');
    expect(exec.rows[0]!.error_message).toMatch(/lock expired/i);

    // A reaped transition was audited.
    const reapTransition = await pool.query(
      `SELECT 1 FROM job_state_transitions WHERE job_id=$1 AND to_status='queued' AND reason ILIKE '%reap%'`,
      [job.id],
    );
    expect(reapTransition.rowCount).toBe(1);

    // It can be claimed and run again — attempt 2.
    const worker2 = await registerWorker(pool, { name: 'survivor', concurrency: 1 });
    await claimJobs(pool, { queueId, workerId: worker2.id, batchSize: 1, lockDurationMs: 30_000 });
    const started2 = await startJob(pool, job.id, worker2.id);
    expect(started2!.job.attempts).toBe(2);
  });

  it('does NOT requeue a job whose lock is still fresh (heartbeat working)', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    const { job } = await enqueueJob(pool, { queueId });
    const worker = await registerWorker(pool, { name: 'healthy', concurrency: 1 });

    await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 1, lockDurationMs: 30_000 });
    await startJob(pool, job.id, worker.id);

    // Heartbeat keeps the lock alive.
    const refreshed = await heartbeatJobs(pool, worker.id, [job.id], 30_000);
    expect(refreshed).toBe(1);

    const { requeuedJobIds } = await requeueExpiredJobs(pool);
    expect(requeuedJobIds).not.toContain(job.id);

    const fresh = await getJob(pool, job.id);
    expect(fresh!.status).toBe('running');
  });
});
