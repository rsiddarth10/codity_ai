import type { Pool, PoolClient } from '@codity/db';
import { withTransaction, logTransition } from './tx.js';
import {
  type JobRow,
  type JobStatus,
  type RetryConfig,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_MAX_ATTEMPTS,
} from './types.js';

export interface EnqueueJobInput {
  queueId: string;
  payload?: Record<string, unknown>;
  priority?: number;
  idempotencyKey?: string | null;
  /** When the job becomes eligible. Future => enqueued as 'scheduled'. Default: now. */
  runAt?: Date;
  batchId?: string | null;
  scheduledJobId?: string | null;
  /** Per-job retry override policy id; otherwise the queue's policy (or defaults). */
  retryPolicyId?: string | null;
  /** Explicit snapshot override (skips policy resolution) — used by internal callers. */
  maxAttempts?: number;
  retryConfig?: RetryConfig;
}

export interface EnqueueResult {
  job: JobRow;
  /** false when an existing job was returned via idempotency key (no new job created). */
  created: boolean;
}

interface EffectivePolicy {
  maxAttempts: number;
  retryConfig: RetryConfig;
}

/**
 * Resolve the effective retry policy to SNAPSHOT onto the job:
 *   explicit override > per-job policy id > queue's policy > system default.
 * Snapshotting freezes retry behavior at enqueue time (see DESIGN.md §1.2).
 */
async function resolveEffectivePolicy(
  client: PoolClient,
  queueId: string,
  overridePolicyId: string | null | undefined,
): Promise<EffectivePolicy> {
  const source = overridePolicyId
    ? await client.query(`SELECT * FROM retry_policies WHERE id = $1`, [overridePolicyId])
    : await client.query(
        `SELECT rp.*
           FROM queues q
           JOIN retry_policies rp ON rp.id = q.retry_policy_id
          WHERE q.id = $1`,
        [queueId],
      );

  const p = source.rows[0];
  if (!p) {
    return { maxAttempts: DEFAULT_MAX_ATTEMPTS, retryConfig: { ...DEFAULT_RETRY_CONFIG } };
  }
  return {
    maxAttempts: p.max_attempts,
    retryConfig: {
      strategy: p.strategy,
      base_delay_ms: p.base_delay_ms,
      max_delay_ms: p.max_delay_ms,
      multiplier: Number(p.backoff_multiplier),
      jitter: p.jitter,
    },
  };
}

/** Insert one job on an existing client (so it can be composed into a batch). Honors idempotency. */
export async function enqueueJobOnClient(
  client: PoolClient,
  input: EnqueueJobInput,
): Promise<EnqueueResult> {
  const runAt = input.runAt ?? new Date();
  const status: JobStatus = runAt.getTime() > Date.now() ? 'scheduled' : 'queued';

  const effective: EffectivePolicy =
    input.maxAttempts !== undefined && input.retryConfig !== undefined
      ? { maxAttempts: input.maxAttempts, retryConfig: input.retryConfig }
      : await resolveEffectivePolicy(client, input.queueId, input.retryPolicyId);

  const inserted = await client.query<JobRow>(
    `INSERT INTO jobs
       (queue_id, batch_id, scheduled_job_id, status, priority, payload,
        idempotency_key, max_attempts, retry_config, retry_policy_id, run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.queueId,
      input.batchId ?? null,
      input.scheduledJobId ?? null,
      status,
      input.priority ?? 0,
      input.payload ?? {},
      input.idempotencyKey ?? null,
      effective.maxAttempts,
      effective.retryConfig,
      input.retryPolicyId ?? null,
      runAt,
    ],
  );

  if (inserted.rows[0]) {
    const job = inserted.rows[0];
    await logTransition(client, job.id, null, status, null, 'enqueued');
    return { job, created: true };
  }

  // Idempotency conflict: a live job with this key already exists — return it, no dup.
  const existing = await client.query<JobRow>(
    `SELECT * FROM jobs WHERE queue_id = $1 AND idempotency_key = $2`,
    [input.queueId, input.idempotencyKey],
  );
  return { job: existing.rows[0]!, created: false };
}

/** Enqueue a single job (own transaction). */
export async function enqueueJob(pool: Pool, input: EnqueueJobInput): Promise<EnqueueResult> {
  return withTransaction(pool, (client) => enqueueJobOnClient(client, input));
}

/** Enqueue N jobs as one batch in a single transaction; returns the batch id + jobs. */
export async function enqueueBatch(
  pool: Pool,
  projectId: string,
  batchName: string,
  jobs: EnqueueJobInput[],
): Promise<{ batchId: string; jobs: JobRow[] }> {
  return withTransaction(pool, async (client) => {
    const batch = await client.query<{ id: string }>(
      `INSERT INTO job_batches (project_id, name, total_jobs) VALUES ($1, $2, $3) RETURNING id`,
      [projectId, batchName, jobs.length],
    );
    const batchId = batch.rows[0]!.id;
    const created: JobRow[] = [];
    for (const j of jobs) {
      const res = await enqueueJobOnClient(client, { ...j, batchId });
      created.push(res.job);
    }
    return { batchId, jobs: created };
  });
}

// ── Read helpers (used by tests now, dashboard/API later) ──────────────────────

export async function getJob(pool: Pool, jobId: string): Promise<JobRow | null> {
  const { rows } = await pool.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  return rows[0] ?? null;
}

export async function countJobsByStatus(
  pool: Pool,
  queueId: string,
): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM jobs WHERE queue_id = $1 GROUP BY status`,
    [queueId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

export async function countInFlight(pool: Pool, queueId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs WHERE queue_id = $1 AND status IN ('claimed', 'running')`,
    [queueId],
  );
  return rows[0]!.n;
}
