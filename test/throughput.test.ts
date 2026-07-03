import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Pool } from '@codity/db';
import {
  enqueueJob,
  claimJobs,
  startJob,
  completeJob,
  registerWorker,
  getQueueThroughput,
} from '@codity/core';
import { testPool, resetDb, seedQueue } from './helpers.js';

describe('queue throughput time series', () => {
  const pool: Pool = testPool(10);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('returns a continuous per-minute series and counts a completed job in the current bucket', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 5 });
    const { job } = await enqueueJob(pool, { queueId });
    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });
    await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 1, lockDurationMs: 30_000 });
    await startJob(pool, job.id, worker.id);
    await completeJob(pool, job.id, worker.id, { ok: true });

    const series = await getQueueThroughput(pool, queueId, 5);
    // generate_series fills every minute -> exactly `minutes` buckets.
    expect(series).toHaveLength(5);
    const totalCompleted = series.reduce((sum, b) => sum + b.completed, 0);
    expect(totalCompleted).toBe(1);
    // The completion lands in the most recent bucket.
    expect(series[series.length - 1]!.completed).toBe(1);
  });
});
