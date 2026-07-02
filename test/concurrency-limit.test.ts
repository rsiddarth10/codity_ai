import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Pool } from '@codity/db';
import {
  enqueueJob,
  claimJobs,
  startJob,
  completeJob,
  registerWorker,
  countInFlight,
  setQueuePaused,
} from '@codity/core';
import { testPool, resetDb, seedQueue } from './helpers.js';

/**
 * The queue concurrency limit must hold ACROSS ALL WORKERS under load — never more than
 * `concurrency_limit` jobs in flight (claimed+running) at once.
 */
describe('queue concurrency limit enforcement', () => {
  const pool: Pool = testPool(40);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('never exceeds the limit even with many concurrent claimers', async () => {
    const LIMIT = 5;
    const JOBS = 60;
    const CLAIMERS = 20;
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: LIMIT });
    await Promise.all(Array.from({ length: JOBS }, () => enqueueJob(pool, { queueId })));

    let maxObservedInFlight = 0;

    // Claimers try repeatedly to grab a slot; they DO NOT complete jobs, so slots stay
    // occupied. The queue must hand out at most LIMIT slots total.
    async function grabber(name: string): Promise<void> {
      const worker = await registerWorker(pool, { name, concurrency: LIMIT });
      for (let attempt = 0; attempt < 10; attempt++) {
        await claimJobs(pool, { queueId, workerId: worker.id, batchSize: LIMIT, lockDurationMs: 60_000 });
        const inflight = await countInFlight(pool, queueId);
        maxObservedInFlight = Math.max(maxObservedInFlight, inflight);
      }
    }

    await Promise.all(Array.from({ length: CLAIMERS }, (_, i) => grabber(`w${i}`)));

    // Invariant: in-flight count never crossed the limit...
    expect(maxObservedInFlight).toBeLessThanOrEqual(LIMIT);
    // ...and exactly LIMIT jobs ended up claimed, the rest remain queued.
    expect(await countInFlight(pool, queueId)).toBe(LIMIT);
    const queued = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE queue_id=$1 AND status='queued'`,
      [queueId],
    );
    expect(queued.rows[0]!.n).toBe(JOBS - LIMIT);
  });

  it('frees a slot on completion, letting the next job be claimed', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 1 });
    await enqueueJob(pool, { queueId, payload: { n: 1 } });
    await enqueueJob(pool, { queueId, payload: { n: 2 } });
    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });

    // Claim + run the first job; the single slot is now occupied.
    const [first] = await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 5, lockDurationMs: 60_000 });
    expect(first).toBeDefined();
    await startJob(pool, first!.id, worker.id);

    // No slot free -> a second claim returns nothing.
    const none = await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 5, lockDurationMs: 60_000 });
    expect(none).toHaveLength(0);

    // Complete the first -> slot frees -> second job now claimable.
    await completeJob(pool, first!.id, worker.id, { ok: true });
    const [second] = await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 5, lockDurationMs: 60_000 });
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
  });

  it('a paused queue yields no claims (running jobs are unaffected)', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 10 });
    await enqueueJob(pool, { queueId });
    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });

    await setQueuePaused(pool, queueId, true);
    const claimed = await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 5, lockDurationMs: 60_000 });
    expect(claimed).toHaveLength(0);

    await setQueuePaused(pool, queueId, false);
    const resumed = await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 5, lockDurationMs: 60_000 });
    expect(resumed).toHaveLength(1);
  });
});
