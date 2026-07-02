import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Pool } from '@codity/db';
import { enqueueJob, claimJobs, registerWorker } from '@codity/core';
import { testPool, resetDb, seedQueue } from './helpers.js';

/**
 * Isolate and prove the SKIP LOCKED primitive: a row locked by one transaction is
 * SKIPPED (not waited on) by a concurrent claimer, which therefore grabs a different
 * row. If it blocked instead, this test would hang and time out.
 */
describe('FOR UPDATE SKIP LOCKED semantics', () => {
  const pool: Pool = testPool(10);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('skips a row another transaction has locked and claims a different one', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 100 });
    const a = await enqueueJob(pool, { queueId, payload: { tag: 'a' } });
    const b = await enqueueJob(pool, { queueId, payload: { tag: 'b' } });

    // Transaction 1: manually lock exactly one queued job and HOLD the lock.
    const holder = await pool.connect();
    let lockedId: string;
    try {
      await holder.query('BEGIN');
      const locked = await holder.query<{ id: string }>(
        `SELECT id FROM jobs
          WHERE queue_id = $1 AND status = 'queued'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [queueId],
      );
      lockedId = locked.rows[0]!.id;
      expect(lockedId).toBe(a.job.id); // oldest queued row

      // Transaction 2 (the real claim): must NOT block, must skip the locked row.
      const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });
      const claimed = await claimJobs(pool, {
        queueId,
        workerId: worker.id,
        batchSize: 5,
        lockDurationMs: 30_000,
      });

      // It returned (didn't deadlock) and got only the un-locked job.
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.id).toBe(b.job.id);
      expect(claimed[0]!.id).not.toBe(lockedId);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});
