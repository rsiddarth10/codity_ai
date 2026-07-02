import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pino from 'pino';
import type { Pool } from '@codity/db';
import {
  enqueueJob,
  claimJobs,
  startJob,
  registerWorker,
  getJob,
  markStaleWorkersDead,
} from '@codity/core';
import { Reaper } from '@codity/scheduler';
import { testPool, resetDb, seedQueue, waitFor } from './helpers.js';

const silentLogger = pino({ level: 'silent' });

describe('scheduler reaper loop', () => {
  const pool: Pool = testPool(10);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('requeues a job left behind by a crashed worker', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    const { job } = await enqueueJob(pool, { queueId });
    const worker = await registerWorker(pool, { name: 'crash', concurrency: 1 });
    await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 1, lockDurationMs: 30_000 });
    await startJob(pool, job.id, worker.id);

    // Simulate the crash: lock expired.
    await pool.query(`UPDATE jobs SET lock_expires_at = now() - interval '1 minute' WHERE id=$1`, [job.id]);

    const reaper = new Reaper(pool, { intervalMs: 20, deadAfterMs: 30_000 }, silentLogger);
    reaper.start();
    try {
      await waitFor(async () => (await getJob(pool, job.id))?.status === 'queued');
    } finally {
      reaper.stop();
    }

    const fresh = await getJob(pool, job.id);
    expect(fresh!.status).toBe('queued');
    expect(fresh!.claimed_by).toBeNull();
  });

  it('marks a stale worker dead', async () => {
    const worker = await registerWorker(pool, { name: 'silent', concurrency: 1 });
    await pool.query(`UPDATE workers SET last_heartbeat = now() - interval '1 minute' WHERE id=$1`, [worker.id]);

    const dead = await markStaleWorkersDead(pool, 30_000);
    expect(dead).toContain(worker.id);
    const row = await pool.query<{ status: string }>(`SELECT status FROM workers WHERE id=$1`, [worker.id]);
    expect(row.rows[0]!.status).toBe('dead');
  });
});
