import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import type { Express } from 'express';
import type { Pool } from '@codity/db';
import { buildApp, type AppConfig } from '@codity/api';
import { testPool, resetDb } from './helpers.js';

const config: AppConfig = {
  jwtAccessSecret: 'test-access-secret',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtAccessTtlSec: 900,
  jwtRefreshTtlSec: 3600,
  bcryptRounds: 4, // fast for tests
};

/** Sign up a fresh user and return an auth header + ids. */
async function signup(app: Express, email = `u${Date.now()}${Math.random()}@ex.com`) {
  const res = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'password123', organizationName: 'Acme' });
  expect(res.status).toBe(201);
  return {
    auth: `Bearer ${res.body.accessToken}`,
    refreshToken: res.body.refreshToken,
    userId: res.body.user.id,
    orgId: res.body.user.organizationId,
    email,
  };
}

describe('REST API', () => {
  const pool: Pool = testPool(20);
  let app: Express;

  beforeAll(() => {
    app = buildApp(pool, config, pino({ level: 'silent' }));
  });
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  describe('auth', () => {
    it('signup returns tokens and a user', async () => {
      const res = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: 'a@b.com', password: 'password123', organizationName: 'Acme' });
      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.user.email).toBe('a@b.com');
      expect(res.body.user.role).toBe('owner');
    });

    it('rejects signup with a short password (400, structured error)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: 'a@b.com', password: 'short', organizationName: 'Acme' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.details).toBeTruthy();
    });

    it('duplicate email -> 409', async () => {
      await signup(app, 'dupe@b.com');
      const res = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: 'dupe@b.com', password: 'password123', organizationName: 'Other' });
      expect(res.status).toBe(409);
    });

    it('login with wrong password -> 401 (no user enumeration)', async () => {
      await signup(app, 'login@b.com');
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'login@b.com', password: 'wrongpass' });
      expect(res.status).toBe(401);
    });

    it('refresh rotates: old refresh token is invalidated', async () => {
      const { refreshToken } = await signup(app);
      const first = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
      expect(first.status).toBe(200);
      expect(first.body.accessToken).toBeTruthy();
      // Re-using the old (now rotated) refresh token must fail.
      const reuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
      expect(reuse.status).toBe(401);
    });

    it('protected route without token -> 401', async () => {
      const res = await request(app).get('/api/v1/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('GET /me returns the current user', async () => {
      const { auth, email } = await signup(app);
      const res = await request(app).get('/api/v1/me').set('Authorization', auth);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(email);
    });
  });

  describe('projects & tenant isolation', () => {
    it('CRUD a project', async () => {
      const { auth } = await signup(app);
      const created = await request(app).post('/api/v1/projects').set('Authorization', auth).send({ name: 'P1' });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const list = await request(app).get('/api/v1/projects').set('Authorization', auth);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.pagination.total).toBe(1);

      const patched = await request(app).patch(`/api/v1/projects/${id}`).set('Authorization', auth).send({ name: 'P1-renamed' });
      expect(patched.body.name).toBe('P1-renamed');

      const del = await request(app).delete(`/api/v1/projects/${id}`).set('Authorization', auth);
      expect(del.status).toBe(204);
    });

    it('duplicate project name -> 409', async () => {
      const { auth } = await signup(app);
      await request(app).post('/api/v1/projects').set('Authorization', auth).send({ name: 'dup' });
      const again = await request(app).post('/api/v1/projects').set('Authorization', auth).send({ name: 'dup' });
      expect(again.status).toBe(409);
    });

    it("cannot access another organization's project (404, not 403)", async () => {
      const a = await signup(app, 'orgA@b.com');
      const b = await signup(app, 'orgB@b.com');
      const created = await request(app).post('/api/v1/projects').set('Authorization', a.auth).send({ name: 'secret' });
      const projectId = created.body.id;

      const asB = await request(app).get(`/api/v1/projects/${projectId}`).set('Authorization', b.auth);
      expect(asB.status).toBe(404);
    });
  });

  describe('queues & jobs', () => {
    async function setupQueue(auth: string) {
      const project = await request(app).post('/api/v1/projects').set('Authorization', auth).send({ name: `proj-${Math.random()}` });
      const queue = await request(app)
        .post(`/api/v1/projects/${project.body.id}/queues`)
        .set('Authorization', auth)
        .send({ name: 'q', concurrencyLimit: 5 });
      return { projectId: project.body.id, queueId: queue.body.id };
    }

    it('creates a queue, enqueues a job, and reads it back', async () => {
      const { auth } = await signup(app);
      const { queueId } = await setupQueue(auth);

      const job = await request(app)
        .post(`/api/v1/queues/${queueId}/jobs`)
        .set('Authorization', auth)
        .send({ payload: { type: 'echo' }, priority: 3 });
      expect(job.status).toBe(201);
      expect(job.body.job.status).toBe('queued');
      const jobId = job.body.job.id;

      const fetched = await request(app).get(`/api/v1/jobs/${jobId}`).set('Authorization', auth);
      expect(fetched.status).toBe(200);
      expect(fetched.body.priority).toBe(3);

      const transitions = await request(app).get(`/api/v1/jobs/${jobId}/transitions`).set('Authorization', auth);
      expect(transitions.body.data.map((t: { to_status: string }) => t.to_status)).toContain('queued');
    });

    it('idempotency key returns the existing job with 200', async () => {
      const { auth } = await signup(app);
      const { queueId } = await setupQueue(auth);
      const first = await request(app).post(`/api/v1/queues/${queueId}/jobs`).set('Authorization', auth).send({ idempotencyKey: 'k1' });
      const second = await request(app).post(`/api/v1/queues/${queueId}/jobs`).set('Authorization', auth).send({ idempotencyKey: 'k1' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.idempotent).toBe(true);
      expect(second.body.job.id).toBe(first.body.job.id);
    });

    it('lists jobs with status filter + pagination', async () => {
      const { auth } = await signup(app);
      const { queueId } = await setupQueue(auth);
      for (let i = 0; i < 5; i++) {
        await request(app).post(`/api/v1/queues/${queueId}/jobs`).set('Authorization', auth).send({ payload: { i } });
      }
      const page1 = await request(app).get(`/api/v1/queues/${queueId}/jobs?status=queued&page=1&pageSize=2`).set('Authorization', auth);
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.pagination.total).toBe(5);
      expect(page1.body.pagination.totalPages).toBe(3);
    });

    it('cancels a queued job; a second cancel -> 409', async () => {
      const { auth } = await signup(app);
      const { queueId } = await setupQueue(auth);
      const job = await request(app).post(`/api/v1/queues/${queueId}/jobs`).set('Authorization', auth).send({});
      const jobId = job.body.job.id;

      const cancel = await request(app).post(`/api/v1/jobs/${jobId}/cancel`).set('Authorization', auth);
      expect(cancel.status).toBe(200);
      expect(cancel.body.status).toBe('cancelled');

      const again = await request(app).post(`/api/v1/jobs/${jobId}/cancel`).set('Authorization', auth);
      expect(again.status).toBe(409);
    });

    it('pause/resume and stats', async () => {
      const { auth } = await signup(app);
      const { queueId } = await setupQueue(auth);
      await request(app).post(`/api/v1/queues/${queueId}/jobs`).set('Authorization', auth).send({});

      const paused = await request(app).post(`/api/v1/queues/${queueId}/pause`).set('Authorization', auth);
      expect(paused.body.is_paused).toBe(true);
      const resumed = await request(app).post(`/api/v1/queues/${queueId}/resume`).set('Authorization', auth);
      expect(resumed.body.is_paused).toBe(false);

      const stats = await request(app).get(`/api/v1/queues/${queueId}/stats`).set('Authorization', auth);
      expect(stats.status).toBe(200);
      expect(stats.body.queued).toBe(1);
      expect(stats.body.total).toBe(1);
    });
  });

  it('serves the OpenAPI spec', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.paths['/auth/login']).toBeTruthy();
  });

  it('health check', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
