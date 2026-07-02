import 'dotenv/config';
import { getPool, closePool } from '@codity/db';
import { createOrganization, createProject, createQueue, enqueueJob } from '@codity/core';

/**
 * Seed a demo org/project/queue and enqueue COUNT jobs, for exercising the worker
 * end-to-end. Usage:
 *   COUNT=20 tsx scripts/demo-seed.ts                  # echo jobs
 *   COUNT=6 JOB_TYPE=sleep JOB_MS=2000 tsx scripts/demo-seed.ts
 */
const pool = getPool();
const count = Number(process.env.COUNT ?? 10);
const type = process.env.JOB_TYPE ?? 'echo';
const ms = Number(process.env.JOB_MS ?? 100);

const org = await createOrganization(pool, 'demo-org');
const project = await createProject(pool, org.id, 'demo-project');
const queue = await createQueue(pool, project.id, {
  name: `demo-${Date.now()}`,
  concurrencyLimit: 20,
});

for (let i = 0; i < count; i++) {
  await enqueueJob(pool, { queueId: queue.id, payload: { type, ms, i } });
}

console.log(JSON.stringify({ seeded: count, queueId: queue.id, projectId: project.id }));
await closePool();
