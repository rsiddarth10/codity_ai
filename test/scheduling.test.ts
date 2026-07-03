import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import type { Express } from 'express';
import type { Pool } from '@codity/db';
import {
  cronNextRun,
  isValidCron,
  createOrganization,
  createProject,
  createQueue,
  enqueueJob,
  enqueueBatch,
  getJob,
  createSchedule,
  promoteScheduledJobs,
  promoteDueSchedules,
  getBatchStatus,
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

describe('cron parsing (pure)', () => {
  it('computes the next run from a fixed reference time', () => {
    const next = cronNextRun('*/5 * * * *', 'UTC', new Date('2026-01-01T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });
  it('validates cron expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('not a cron')).toBe(false);
  });
});

describe('scheduling (integration)', () => {
  const pool: Pool = testPool(20);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  async function seed() {
    const org = await createOrganization(pool, 'o');
    const project = await createProject(pool, org.id, 'p');
    const queue = await createQueue(pool, project.id, { name: 'q', concurrencyLimit: 5 });
    return { orgId: org.id, projectId: project.id, queueId: queue.id };
  }

  it('promotes a delayed one-shot job when its run_at arrives', async () => {
    const { queueId } = await seed();
    const { job } = await enqueueJob(pool, { queueId, runAt: new Date(Date.now() + 60_000) });
    expect(job.status).toBe('scheduled');

    // Not due yet -> not promoted.
    expect(await promoteScheduledJobs(pool)).toHaveLength(0);

    // Its time arrives.
    await pool.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    const promoted = await promoteScheduledJobs(pool);
    expect(promoted).toContain(job.id);
    expect((await getJob(pool, job.id))!.status).toBe('queued');
  });

  it('fires a due cron schedule, links the job, and advances next_run_at (no double-fire)', async () => {
    const { queueId } = await seed();
    const schedule = await createSchedule(pool, {
      queueId,
      name: 'every-minute',
      cronExpression: '* * * * *',
      payload: { type: 'echo', from: 'cron' },
    });
    expect(schedule.next_run_at).toBeTruthy();

    // Force it due.
    await pool.query(`UPDATE scheduled_jobs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [schedule.id]);

    const created = await promoteDueSchedules(pool);
    expect(created).toHaveLength(1);

    // A concrete job instance was created, linked back to the schedule, and is claimable.
    const jobRow = await pool.query<{ status: string; scheduled_job_id: string; payload: Record<string, unknown> }>(
      `SELECT status, scheduled_job_id, payload FROM jobs WHERE id = $1`,
      [created[0]],
    );
    expect(jobRow.rows[0]!.status).toBe('queued');
    expect(jobRow.rows[0]!.scheduled_job_id).toBe(schedule.id);
    expect(jobRow.rows[0]!.payload).toEqual({ type: 'echo', from: 'cron' });

    // next_run_at advanced into the future + last_run_at recorded.
    const after = await pool.query<{ next_run_at: Date; last_run_at: Date }>(
      `SELECT next_run_at, last_run_at FROM scheduled_jobs WHERE id = $1`,
      [schedule.id],
    );
    expect(after.rows[0]!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(after.rows[0]!.last_run_at).toBeTruthy();

    // Running again immediately does NOT create a duplicate (not due anymore).
    expect(await promoteDueSchedules(pool)).toHaveLength(0);
  });

  it('rolls up batch status', async () => {
    const { projectId, queueId } = await seed();
    const { batchId } = await enqueueBatch(pool, projectId, 'nightly', [
      { queueId, payload: { i: 1 } },
      { queueId, payload: { i: 2 } },
      { queueId, payload: { i: 3 } },
    ]);

    let status = await getBatchStatus(pool, batchId);
    expect(status!.total_jobs).toBe(3);
    expect(status!.counts.queued).toBe(3);
    expect(status!.pending).toBe(3);
    expect(status!.done).toBe(false);

    // Mark all terminal -> done.
    await pool.query(`UPDATE jobs SET status = 'completed' WHERE batch_id = $1`, [batchId]);
    status = await getBatchStatus(pool, batchId);
    expect(status!.terminal).toBe(3);
    expect(status!.done).toBe(true);
  });
});

describe('scheduling (API)', () => {
  const pool: Pool = testPool(20);
  let app: Express;
  beforeAll(() => {
    app = buildApp(pool, config, pino({ level: 'silent' }));
  });
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  async function setup() {
    const signup = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: `sch${Math.random()}@ex.com`, password: 'password123', organizationName: 'Acme' });
    const auth = `Bearer ${signup.body.accessToken}`;
    const project = await request(app).post('/api/v1/projects').set('Authorization', auth).send({ name: 'p' });
    const queue = await request(app)
      .post(`/api/v1/projects/${project.body.id}/queues`)
      .set('Authorization', auth)
      .send({ name: 'q' });
    return { auth, queueId: queue.body.id };
  }

  it('creates/lists cron schedules and rejects a bad cron', async () => {
    const { auth, queueId } = await setup();

    const bad = await request(app)
      .post(`/api/v1/queues/${queueId}/schedules`)
      .set('Authorization', auth)
      .send({ name: 's', cronExpression: 'nope' });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .post(`/api/v1/queues/${queueId}/schedules`)
      .set('Authorization', auth)
      .send({ name: 'nightly', cronExpression: '0 0 * * *', payload: { type: 'echo' } });
    expect(ok.status).toBe(201);
    expect(ok.body.next_run_at).toBeTruthy();

    const list = await request(app).get(`/api/v1/queues/${queueId}/schedules`).set('Authorization', auth);
    expect(list.body.data).toHaveLength(1);
  });

  it('submits a batch and reads its rollup', async () => {
    const { auth, queueId } = await setup();
    const batch = await request(app)
      .post(`/api/v1/queues/${queueId}/batches`)
      .set('Authorization', auth)
      .send({ name: 'import', jobs: [{ payload: { i: 1 } }, { payload: { i: 2 } }, { payload: { i: 3 } }] });
    expect(batch.status).toBe(201);
    expect(batch.body.count).toBe(3);

    const rollup = await request(app).get(`/api/v1/batches/${batch.body.batchId}`).set('Authorization', auth);
    expect(rollup.status).toBe(200);
    expect(rollup.body.total_jobs).toBe(3);
    expect(rollup.body.counts.queued).toBe(3);
  });
});
