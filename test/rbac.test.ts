import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import type { Express } from 'express';
import type { Pool } from '@codity/db';
import { buildApp, type AppConfig } from '@codity/api';
import { testPool, resetDb } from './helpers.js';

const config: AppConfig = {
  jwtAccessSecret: 'test-access',
  jwtRefreshSecret: 'test-refresh',
  jwtAccessTtlSec: 900,
  jwtRefreshTtlSec: 3600,
  bcryptRounds: 4,
};

describe('RBAC', () => {
  const pool: Pool = testPool(15);
  let app: Express;
  beforeAll(() => {
    app = buildApp(pool, config, pino({ level: 'silent' }));
  });
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  async function ownerSignup() {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: `owner${Math.random()}@ex.com`, password: 'password123', organizationName: 'Acme' });
    return `Bearer ${res.body.accessToken}`;
  }

  it('owner can invite a member; member reads but cannot mutate config', async () => {
    const owner = await ownerSignup();
    const memberEmail = `member${Math.random()}@ex.com`;

    // Owner invites a member.
    const invite = await request(app)
      .post('/api/v1/users')
      .set('Authorization', owner)
      .send({ email: memberEmail, password: 'password123', role: 'member' });
    expect(invite.status).toBe(201);
    expect(invite.body.role).toBe('member');

    // Owner creates a project + queue for the member to use.
    const project = await request(app).post('/api/v1/projects').set('Authorization', owner).send({ name: 'p' });
    const queue = await request(app)
      .post(`/api/v1/projects/${project.body.id}/queues`)
      .set('Authorization', owner)
      .send({ name: 'q' });

    // Member logs in.
    const login = await request(app).post('/api/v1/auth/login').send({ email: memberEmail, password: 'password123' });
    const member = `Bearer ${login.body.accessToken}`;

    // Member CAN read.
    expect((await request(app).get('/api/v1/projects').set('Authorization', member)).status).toBe(200);
    // Member CAN operate jobs.
    const enqueue = await request(app).post(`/api/v1/queues/${queue.body.id}/jobs`).set('Authorization', member).send({});
    expect(enqueue.status).toBe(201);

    // Member CANNOT create projects, queues, or invite users.
    expect((await request(app).post('/api/v1/projects').set('Authorization', member).send({ name: 'x' })).status).toBe(403);
    expect(
      (await request(app).post(`/api/v1/projects/${project.body.id}/queues`).set('Authorization', member).send({ name: 'z' })).status,
    ).toBe(403);
    expect(
      (await request(app).post('/api/v1/users').set('Authorization', member).send({ email: 'no@ex.com', password: 'password123', role: 'member' })).status,
    ).toBe(403);
  });

  it('cannot mint another owner via the invite endpoint (validation 400)', async () => {
    const owner = await ownerSignup();
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', owner)
      .send({ email: 'x@ex.com', password: 'password123', role: 'owner' });
    expect(res.status).toBe(400);
  });
});
