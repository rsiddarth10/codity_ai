import 'dotenv/config';
import { createPool, type Pool } from '@codity/db';
import {
  createOrganization,
  createProject,
  createQueue,
  type CreateQueueInput,
} from '@codity/core';

/** A pool bound to the isolated test database. Each test file makes its own. */
export function testPool(max = 30): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL not set');
  return createPool({ connectionString, max });
}

const ALL_TABLES = [
  'organizations',
  'users',
  'refresh_tokens',
  'projects',
  'retry_policies',
  'queues',
  'workers',
  'worker_heartbeats',
  'job_batches',
  'jobs',
  'job_executions',
  'job_logs',
  'job_state_transitions',
  'scheduled_jobs',
  'dead_letter_queue',
];

/** Wipe all domain data between tests (fast, deterministic isolation). */
export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** Poll `predicate` until it returns true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Create org -> project -> queue in one call and return the queue (+ project id). */
export async function seedQueue(
  pool: Pool,
  queue: CreateQueueInput,
): Promise<{ organizationId: string; projectId: string; queueId: string }> {
  const org = await createOrganization(pool, 'test-org');
  const project = await createProject(pool, org.id, 'test-project');
  const q = await createQueue(pool, project.id, queue);
  return { organizationId: org.id, projectId: project.id, queueId: q.id };
}
