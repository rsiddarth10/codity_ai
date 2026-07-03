import type { Pool } from '@codity/db';
import type { Queryable } from './tx.js';
import type { QueueRow, WorkerRow, RetryStrategy } from './types.js';

/**
 * Config / ownership data-access: organizations, projects, retry policies, queues,
 * workers. These are the building blocks the API (Phase 4) will expose and that the
 * tests use to set up scenarios. Kept as small, explicit INSERT/SELECT helpers.
 */

export async function createOrganization(db: Queryable, name: string): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return rows[0]!;
}

export async function createProject(
  db: Queryable,
  organizationId: string,
  name: string,
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO projects (organization_id, name) VALUES ($1, $2) RETURNING id`,
    [organizationId, name],
  );
  return rows[0]!;
}

export interface CreateRetryPolicyInput {
  name: string;
  strategy: RetryStrategy;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number | null;
  backoffMultiplier?: number;
  jitter?: boolean;
}

export async function createRetryPolicy(
  db: Queryable,
  projectId: string,
  input: CreateRetryPolicyInput,
): Promise<{ id: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO retry_policies
       (project_id, name, strategy, max_attempts, base_delay_ms, max_delay_ms, backoff_multiplier, jitter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      projectId,
      input.name,
      input.strategy,
      input.maxAttempts,
      input.baseDelayMs,
      input.maxDelayMs ?? null,
      input.backoffMultiplier ?? 2,
      input.jitter ?? true,
    ],
  );
  return rows[0]!;
}

export interface CreateQueueInput {
  name: string;
  priority?: number;
  concurrencyLimit?: number;
  retryPolicyId?: string | null;
  isPaused?: boolean;
  rateLimitPerSec?: number | null;
}

export async function createQueue(
  db: Queryable,
  projectId: string,
  input: CreateQueueInput,
): Promise<QueueRow> {
  const { rows } = await db.query<QueueRow>(
    `INSERT INTO queues (project_id, name, priority, concurrency_limit, retry_policy_id, is_paused, rate_limit_per_sec)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      projectId,
      input.name,
      input.priority ?? 0,
      input.concurrencyLimit ?? 10,
      input.retryPolicyId ?? null,
      input.isPaused ?? false,
      input.rateLimitPerSec ?? null,
    ],
  );
  return rows[0]!;
}

export async function setQueuePaused(db: Queryable, queueId: string, paused: boolean): Promise<void> {
  await db.query(`UPDATE queues SET is_paused = $2 WHERE id = $1`, [queueId, paused]);
}

export async function getQueue(db: Queryable, queueId: string): Promise<QueueRow | null> {
  const { rows } = await db.query<QueueRow>(`SELECT * FROM queues WHERE id = $1`, [queueId]);
  return rows[0] ?? null;
}

export interface RegisterWorkerInput {
  name: string;
  concurrency: number;
  metadata?: Record<string, unknown>;
}

export async function registerWorker(db: Queryable, input: RegisterWorkerInput): Promise<WorkerRow> {
  const { rows } = await db.query<WorkerRow>(
    `INSERT INTO workers (name, concurrency, metadata)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.name, input.concurrency, input.metadata ?? {}],
  );
  return rows[0]!;
}

/** Update the worker's latest heartbeat and append a history row (observability). */
export async function heartbeatWorker(
  db: Queryable,
  workerId: string,
  runningJobs: number,
): Promise<void> {
  await db.query(`UPDATE workers SET last_heartbeat = now() WHERE id = $1`, [workerId]);
  await db.query(
    `INSERT INTO worker_heartbeats (worker_id, running_jobs) VALUES ($1, $2)`,
    [workerId, runningJobs],
  );
}

export async function setWorkerStatus(
  db: Queryable,
  workerId: string,
  status: 'active' | 'draining' | 'dead',
): Promise<void> {
  await db.query(`UPDATE workers SET status = $2 WHERE id = $1`, [workerId, status]);
}

/** Ids of all non-paused queues, highest priority first (worker queue discovery). */
export async function listQueueIdsByPriority(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM queues WHERE is_paused = false ORDER BY priority DESC, created_at ASC`,
  );
  return rows.map((r) => r.id);
}

/** Mark workers dead if they have not heartbeat within `deadAfterMs` (reaper support). */
export async function markStaleWorkersDead(
  db: Pool,
  deadAfterMs: number,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE workers
        SET status = 'dead'
      WHERE status = 'active'
        AND last_heartbeat < now() - ($1::numeric * interval '1 millisecond')
      RETURNING id`,
    [deadAfterMs],
  );
  return rows.map((r) => r.id);
}
