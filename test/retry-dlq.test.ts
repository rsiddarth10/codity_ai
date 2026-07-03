import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import type { Express } from 'express';
import type { Pool } from '@codity/db';
import {
  createOrganization,
  createProject,
  createRetryPolicy,
  createQueue,
  enqueueJob,
  claimJobs,
  startJob,
  failJob,
  registerWorker,
  getJob,
  requeueExpiredJobs,
  promoteRetriableJobs,
  listDeadLetter,
  retryJob,
} from '@codity/core';
import { buildApp, type AppConfig } from '@codity/api';
import { testPool, resetDb } from './helpers.js';

const config: AppConfig = {
  jwtAccessSecret: 'test-access',
  jwtRefreshSecret: 'test-refresh',
  jwtAccessTtlSec: 900,
  jwtRefreshTtlSec: 3600,
  bcryptRounds: 4,
};

describe('retries + dead letter queue', () => {
  const pool: Pool = testPool(20);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  /** Claim + start + fail one attempt; returns the fail outcome. */
  async function attemptAndFail(queueId: string, jobId: string, workerId: string) {
    await claimJobs(pool, { queueId, workerId, batchSize: 1, lockDurationMs: 30_000 });
    await startJob(pool, jobId, workerId);
    return failJob(pool, jobId, workerId, new Error('boom'));
  }

  /** Force the backoff to elapse and promote the job back to queued. */
  async function promoteNow(jobId: string) {
    await pool.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [jobId]);
    await promoteRetriableJobs(pool);
  }

  it('retries with backoff until attempts exhausted, then dead-letters', async () => {
    const org = await createOrganization(pool, 'o');
    const project = await createProject(pool, org.id, 'p');
    const policy = await createRetryPolicy(pool, project.id, {
      name: 'r',
      strategy: 'fixed',
      maxAttempts: 3,
      baseDelayMs: 10,
      jitter: false,
    });
    const queue = await createQueue(pool, project.id, { name: 'q', concurrencyLimit: 5, retryPolicyId: policy.id });
    const { job } = await enqueueJob(pool, { queueId: queue.id });
    expect(job.max_attempts).toBe(3); // snapshotted from the policy
    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });

    // Attempt 1 -> retry scheduled (in backoff), then promoted back to queued.
    let outcome = await attemptAndFail(queue.id, job.id, worker.id);
    expect(outcome!.outcome).toBe('retry_scheduled');
    expect((await getJob(pool, job.id))!.status).toBe('failed');
    await promoteNow(job.id);
    expect((await getJob(pool, job.id))!.status).toBe('queued');

    // Attempt 2 -> retry scheduled.
    outcome = await attemptAndFail(queue.id, job.id, worker.id);
    expect(outcome!.outcome).toBe('retry_scheduled');
    await promoteNow(job.id);

    // Attempt 3 (== max_attempts) -> dead-lettered.
    outcome = await attemptAndFail(queue.id, job.id, worker.id);
    expect(outcome!.outcome).toBe('dead_lettered');
    const dead = await getJob(pool, job.id);
    expect(dead!.status).toBe('dead_letter');
    expect(dead!.attempts).toBe(3);

    // DLQ row captured the snapshot.
    const dlq = await listDeadLetter(pool, queue.id, { limit: 10, offset: 0 });
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.attempts_made).toBe(3);
    expect(dlq[0]!.reason).toMatch(/exhausted/i);

    // Three failed execution rows (one per attempt = full retry history).
    const execs = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_executions WHERE job_id=$1 AND status='failed'`,
      [job.id],
    );
    expect(execs.rows[0]!.n).toBe(3);

    // Manual retry from DLQ: attempts reset, DLQ row removed.
    const revived = await retryJob(pool, job.id);
    expect(revived!.status).toBe('queued');
    expect(revived!.attempts).toBe(0);
    expect(await listDeadLetter(pool, queue.id, { limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('reaper dead-letters a crashed job that has exhausted its attempts', async () => {
    const org = await createOrganization(pool, 'o');
    const project = await createProject(pool, org.id, 'p');
    const policy = await createRetryPolicy(pool, project.id, {
      name: 'once',
      strategy: 'fixed',
      maxAttempts: 1,
      baseDelayMs: 10,
    });
    const queue = await createQueue(pool, project.id, { name: 'q', concurrencyLimit: 5, retryPolicyId: policy.id });
    const { job } = await enqueueJob(pool, { queueId: queue.id });
    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });

    await claimJobs(pool, { queueId: queue.id, workerId: worker.id, batchSize: 1, lockDurationMs: 30_000 });
    await startJob(pool, job.id, worker.id); // attempt 1 == max_attempts
    await pool.query(`UPDATE jobs SET lock_expires_at = now() - interval '1 minute' WHERE id=$1`, [job.id]);

    const result = await requeueExpiredJobs(pool);
    expect(result.deadLetteredJobIds).toContain(job.id);
    expect(result.requeuedJobIds).not.toContain(job.id);
    expect((await getJob(pool, job.id))!.status).toBe('dead_letter');
    expect(await listDeadLetter(pool, queue.id, { limit: 10, offset: 0 })).toHaveLength(1);
  });

  describe('DLQ + retry via API', () => {
    let app: Express;
    beforeAll(() => {
      app = buildApp(pool, config, pino({ level: 'silent' }));
    });

    it('lists the DLQ and retries a dead-lettered job over HTTP', async () => {
      // Sign up and build a queue (with a 1-attempt policy) via the API, in the user's org.
      const signup = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: `dlq${Math.random()}@ex.com`, password: 'password123', organizationName: 'Acme' });
      const auth = `Bearer ${signup.body.accessToken}`;
      const project = await request(app).post('/api/v1/projects').set('Authorization', auth).send({ name: 'p' });
      const policy = await request(app)
        .post(`/api/v1/projects/${project.body.id}/retry-policies`)
        .set('Authorization', auth)
        .send({ name: 'once', strategy: 'fixed', maxAttempts: 1, baseDelayMs: 10 });
      const queue = await request(app)
        .post(`/api/v1/projects/${project.body.id}/queues`)
        .set('Authorization', auth)
        .send({ name: 'q', retryPolicyId: policy.body.id });
      const queueId = queue.body.id;
      const job = await request(app).post(`/api/v1/queues/${queueId}/jobs`).set('Authorization', auth).send({});
      const jobId = job.body.job.id;

      // Drive it to the DLQ via the core layer (a worker failing its only attempt).
      const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });
      await claimJobs(pool, { queueId, workerId: worker.id, batchSize: 1, lockDurationMs: 30_000 });
      await startJob(pool, jobId, worker.id);
      const outcome = await failJob(pool, jobId, worker.id, new Error('nope'));
      expect(outcome!.outcome).toBe('dead_lettered');

      // API: DLQ contains it.
      const dlq = await request(app).get(`/api/v1/queues/${queueId}/dead-letter`).set('Authorization', auth);
      expect(dlq.status).toBe(200);
      expect(dlq.body.data).toHaveLength(1);
      expect(dlq.body.pagination.total).toBe(1);

      // API: retry it -> back to queued, DLQ emptied.
      const retry = await request(app).post(`/api/v1/jobs/${jobId}/retry`).set('Authorization', auth);
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe('queued');

      const dlqAfter = await request(app).get(`/api/v1/queues/${queueId}/dead-letter`).set('Authorization', auth);
      expect(dlqAfter.body.data).toHaveLength(0);

      // Retrying a now-queued job is a 409.
      const badRetry = await request(app).post(`/api/v1/jobs/${jobId}/retry`).set('Authorization', auth);
      expect(badRetry.status).toBe(409);
    });
  });
});
