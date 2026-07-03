import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Pool } from '@codity/db';
import { createOrganization, createProject, createQueue, enqueueJob, claimJobs, registerWorker } from '@codity/core';
import { testPool, resetDb } from './helpers.js';

describe('per-queue rate limiting', () => {
  const pool: Pool = testPool(15);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('claims at most rate_limit_per_sec jobs within a rolling second', async () => {
    const org = await createOrganization(pool, 'o');
    const project = await createProject(pool, org.id, 'p');
    // High concurrency so the RATE limit (not concurrency) is the binding constraint.
    const queue = await createQueue(pool, project.id, { name: 'q', concurrencyLimit: 100, rateLimitPerSec: 2 });
    const worker = await registerWorker(pool, { name: 'w', concurrency: 100 });
    await Promise.all(Array.from({ length: 10 }, () => enqueueJob(pool, { queueId: queue.id })));

    // First claim: capped at 2 despite asking for 10.
    const first = await claimJobs(pool, { queueId: queue.id, workerId: worker.id, batchSize: 10, lockDurationMs: 60_000 });
    expect(first).toHaveLength(2);

    // Second claim in the same second: rate window is full -> 0.
    const second = await claimJobs(pool, { queueId: queue.id, workerId: worker.id, batchSize: 10, lockDurationMs: 60_000 });
    expect(second).toHaveLength(0);

    // After the 1s window passes, more can be claimed.
    await new Promise((r) => setTimeout(r, 1100));
    const third = await claimJobs(pool, { queueId: queue.id, workerId: worker.id, batchSize: 10, lockDurationMs: 60_000 });
    expect(third).toHaveLength(2);
  });

  it('no rate limit (null) claims freely up to the concurrency limit', async () => {
    const org = await createOrganization(pool, 'o');
    const project = await createProject(pool, org.id, 'p');
    const queue = await createQueue(pool, project.id, { name: 'q', concurrencyLimit: 100 }); // rate_limit null
    const worker = await registerWorker(pool, { name: 'w', concurrency: 100 });
    await Promise.all(Array.from({ length: 10 }, () => enqueueJob(pool, { queueId: queue.id })));

    const claimed = await claimJobs(pool, { queueId: queue.id, workerId: worker.id, batchSize: 10, lockDurationMs: 60_000 });
    expect(claimed).toHaveLength(10);
  });
});
