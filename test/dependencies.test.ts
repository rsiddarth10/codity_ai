import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Pool } from '@codity/db';
import {
  createOrganization,
  createProject,
  createRetryPolicy,
  createQueue,
  enqueueJob,
  claimJobs,
  startJob,
  completeJob,
  failJob,
  registerWorker,
  getJob,
  resolveJobDependencies,
} from '@codity/core';
import { testPool, resetDb } from './helpers.js';

describe('workflow dependencies (job B waits on job A)', () => {
  const pool: Pool = testPool(15);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  async function seed(maxAttempts = 3) {
    const org = await createOrganization(pool, 'o');
    const project = await createProject(pool, org.id, 'p');
    const policy = await createRetryPolicy(pool, project.id, { name: 'r', strategy: 'fixed', maxAttempts, baseDelayMs: 10 });
    const queue = await createQueue(pool, project.id, { name: 'q', concurrencyLimit: 10, retryPolicyId: policy.id });
    const worker = await registerWorker(pool, { name: 'w', concurrency: 2 });
    return { queueId: queue.id, workerId: worker.id };
  }

  it('a job with an unfinished parent starts blocked and is not claimable', async () => {
    const { queueId, workerId } = await seed();
    const parent = await enqueueJob(pool, { queueId, payload: { n: 'A' } });
    const child = await enqueueJob(pool, { queueId, payload: { n: 'B' }, dependsOn: [parent.job.id] });

    expect(parent.job.status).toBe('queued');
    expect(child.job.status).toBe('blocked');

    // Only the parent is claimable; the blocked child is invisible to the claim query.
    const claimed = await claimJobs(pool, { queueId, workerId, batchSize: 10, lockDurationMs: 30_000 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe(parent.job.id);
  });

  it('promotes the child to queued once the parent completes', async () => {
    const { queueId, workerId } = await seed();
    const parent = await enqueueJob(pool, { queueId, payload: { n: 'A' } });
    const child = await enqueueJob(pool, { queueId, dependsOn: [parent.job.id] });

    // Not ready yet.
    expect((await resolveJobDependencies(pool)).promotedJobIds).toHaveLength(0);

    await claimJobs(pool, { queueId, workerId, batchSize: 10, lockDurationMs: 30_000 });
    await startJob(pool, parent.job.id, workerId);
    await completeJob(pool, parent.job.id, workerId, {});

    const res = await resolveJobDependencies(pool);
    expect(res.promotedJobIds).toContain(child.job.id);
    expect((await getJob(pool, child.job.id))!.status).toBe('queued');
  });

  it('cancels the child if a parent dead-letters (dependency can never be met)', async () => {
    const { queueId, workerId } = await seed(1); // 1 attempt -> straight to DLQ on failure
    const parent = await enqueueJob(pool, { queueId });
    const child = await enqueueJob(pool, { queueId, dependsOn: [parent.job.id] });

    await claimJobs(pool, { queueId, workerId, batchSize: 10, lockDurationMs: 30_000 });
    await startJob(pool, parent.job.id, workerId);
    const outcome = await failJob(pool, parent.job.id, workerId, new Error('boom'));
    expect(outcome!.outcome).toBe('dead_lettered');

    const res = await resolveJobDependencies(pool);
    expect(res.cancelledJobIds).toContain(child.job.id);
    expect((await getJob(pool, child.job.id))!.status).toBe('cancelled');
  });

  it('waits for ALL parents before unblocking', async () => {
    const { queueId, workerId } = await seed();
    const a = await enqueueJob(pool, { queueId });
    const b = await enqueueJob(pool, { queueId });
    const c = await enqueueJob(pool, { queueId, dependsOn: [a.job.id, b.job.id] });

    const drive = async (id: string) => {
      await claimJobs(pool, { queueId, workerId, batchSize: 10, lockDurationMs: 30_000 });
      await startJob(pool, id, workerId);
      await completeJob(pool, id, workerId, {});
    };

    await drive(a.job.id);
    await resolveJobDependencies(pool);
    expect((await getJob(pool, c.job.id))!.status).toBe('blocked'); // b still pending

    await drive(b.job.id);
    await resolveJobDependencies(pool);
    expect((await getJob(pool, c.job.id))!.status).toBe('queued');
  });

  it('an already-completed parent means the child is not blocked', async () => {
    const { queueId, workerId } = await seed();
    const parent = await enqueueJob(pool, { queueId });
    await claimJobs(pool, { queueId, workerId, batchSize: 10, lockDurationMs: 30_000 });
    await startJob(pool, parent.job.id, workerId);
    await completeJob(pool, parent.job.id, workerId, {});

    const child = await enqueueJob(pool, { queueId, dependsOn: [parent.job.id] });
    expect(child.job.status).toBe('queued');
  });
});
