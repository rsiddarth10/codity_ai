import type { Pool } from '@codity/db';
import { withTransaction, logTransition, type Queryable } from './tx.js';
import type {
  ProjectRow,
  QueueRow,
  RetryPolicyRow,
  JobRow,
  JobStatus,
  JobExecutionRow,
  JobLogRow,
  WorkerRow,
  QueueStats,
} from './types.js';

/**
 * Read/query + update/delete data-access used by the REST API. All raw, reviewable SQL.
 * Every "belongs to org" helper below powers tenant isolation in the API middleware —
 * a resource outside the caller's org resolves to null and the API returns 404.
 */

export interface Page {
  limit: number;
  offset: number;
}

// ── Tenant-scoping resolvers ──────────────────────────────────────────────────

/** organization_id that owns a queue, or null if it doesn't exist. */
export async function queueOrganizationId(db: Queryable, queueId: string): Promise<string | null> {
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT p.organization_id
       FROM queues q JOIN projects p ON p.id = q.project_id
      WHERE q.id = $1`,
    [queueId],
  );
  return rows[0]?.organization_id ?? null;
}

/** organization_id that owns a job, or null. */
export async function jobOrganizationId(db: Queryable, jobId: string): Promise<string | null> {
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT p.organization_id
       FROM jobs j
       JOIN queues q ON q.id = j.queue_id
       JOIN projects p ON p.id = q.project_id
      WHERE j.id = $1`,
    [jobId],
  );
  return rows[0]?.organization_id ?? null;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export async function listProjects(db: Queryable, orgId: string, page: Page): Promise<ProjectRow[]> {
  const { rows } = await db.query<ProjectRow>(
    `SELECT * FROM projects WHERE organization_id = $1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [orgId, page.limit, page.offset],
  );
  return rows;
}

export async function countProjects(db: Queryable, orgId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM projects WHERE organization_id = $1`,
    [orgId],
  );
  return rows[0]!.n;
}

export async function getProject(db: Queryable, projectId: string, orgId: string): Promise<ProjectRow | null> {
  const { rows } = await db.query<ProjectRow>(
    `SELECT * FROM projects WHERE id = $1 AND organization_id = $2`,
    [projectId, orgId],
  );
  return rows[0] ?? null;
}

export async function updateProject(
  db: Queryable,
  projectId: string,
  orgId: string,
  name: string,
): Promise<ProjectRow | null> {
  const { rows } = await db.query<ProjectRow>(
    `UPDATE projects SET name = $3 WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [projectId, orgId, name],
  );
  return rows[0] ?? null;
}

export async function deleteProject(db: Queryable, projectId: string, orgId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM projects WHERE id = $1 AND organization_id = $2`,
    [projectId, orgId],
  );
  return (rowCount ?? 0) > 0;
}

// ── Retry policies ──────────────────────────────────────────────────────────────

export async function listRetryPolicies(db: Queryable, projectId: string): Promise<RetryPolicyRow[]> {
  const { rows } = await db.query<RetryPolicyRow>(
    `SELECT * FROM retry_policies WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
  return rows;
}

export async function deleteRetryPolicy(db: Queryable, policyId: string, projectId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM retry_policies WHERE id = $1 AND project_id = $2`,
    [policyId, projectId],
  );
  return (rowCount ?? 0) > 0;
}

// ── Queues ──────────────────────────────────────────────────────────────────────

export async function listQueues(db: Queryable, projectId: string): Promise<QueueRow[]> {
  const { rows } = await db.query<QueueRow>(
    `SELECT * FROM queues WHERE project_id = $1 ORDER BY priority DESC, created_at ASC`,
    [projectId],
  );
  return rows;
}

export interface UpdateQueuePatch {
  name?: string;
  priority?: number;
  concurrencyLimit?: number;
  retryPolicyId?: string | null;
  isPaused?: boolean;
}

/** Partial update of a queue's config (only provided fields change). */
export async function updateQueue(db: Queryable, queueId: string, patch: UpdateQueuePatch): Promise<QueueRow | null> {
  const { rows } = await db.query<QueueRow>(
    `UPDATE queues SET
        name = COALESCE($2, name),
        priority = COALESCE($3, priority),
        concurrency_limit = COALESCE($4, concurrency_limit),
        retry_policy_id = CASE WHEN $5::boolean THEN $6 ELSE retry_policy_id END,
        is_paused = COALESCE($7, is_paused)
      WHERE id = $1
      RETURNING *`,
    [
      queueId,
      patch.name ?? null,
      patch.priority ?? null,
      patch.concurrencyLimit ?? null,
      patch.retryPolicyId !== undefined, // whether to touch retry_policy_id
      patch.retryPolicyId ?? null,
      patch.isPaused ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteQueue(db: Queryable, queueId: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM queues WHERE id = $1`, [queueId]);
  return (rowCount ?? 0) > 0;
}

/** Aggregate stats for a queue's dashboard card. */
export async function getQueueStats(db: Queryable, queueId: string): Promise<QueueStats> {
  const counts = await db.query<Omit<QueueStats, 'avg_duration_ms' | 'succeeded_executions'>>(
    `SELECT
        count(*) FILTER (WHERE status='queued')::int      AS queued,
        count(*) FILTER (WHERE status='scheduled')::int   AS scheduled,
        count(*) FILTER (WHERE status IN ('claimed','running'))::int AS running,
        count(*) FILTER (WHERE status='completed')::int   AS completed,
        count(*) FILTER (WHERE status='failed')::int      AS failed,
        count(*) FILTER (WHERE status='dead_letter')::int AS dead_letter,
        count(*) FILTER (WHERE status='cancelled')::int   AS cancelled,
        count(*)::int AS total
       FROM jobs WHERE queue_id = $1`,
    [queueId],
  );
  const exec = await db.query<{ avg_duration_ms: number; succeeded_executions: number }>(
    `SELECT COALESCE(avg(je.duration_ms), 0)::float AS avg_duration_ms,
            count(*)::int AS succeeded_executions
       FROM job_executions je
       JOIN jobs j ON j.id = je.job_id
      WHERE j.queue_id = $1 AND je.status = 'succeeded'`,
    [queueId],
  );
  return { ...counts.rows[0]!, ...exec.rows[0]! };
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export interface JobFilter extends Page {
  status?: JobStatus;
}

export async function listJobs(db: Queryable, queueId: string, filter: JobFilter): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `SELECT * FROM jobs
      WHERE queue_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [queueId, filter.status ?? null, filter.limit, filter.offset],
  );
  return rows;
}

export async function countJobs(db: Queryable, queueId: string, status?: JobStatus): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs
      WHERE queue_id = $1 AND ($2::text IS NULL OR status = $2)`,
    [queueId, status ?? null],
  );
  return rows[0]!.n;
}

export async function listJobExecutions(db: Queryable, jobId: string): Promise<JobExecutionRow[]> {
  const { rows } = await db.query<JobExecutionRow>(
    `SELECT * FROM job_executions WHERE job_id = $1 ORDER BY attempt_number ASC`,
    [jobId],
  );
  return rows;
}

export async function listJobLogs(db: Queryable, jobId: string, page: Page): Promise<JobLogRow[]> {
  const { rows } = await db.query<JobLogRow>(
    `SELECT * FROM job_logs WHERE job_id = $1 ORDER BY logged_at ASC, id ASC LIMIT $2 OFFSET $3`,
    [jobId, page.limit, page.offset],
  );
  return rows;
}

/** Full lifecycle timeline for a job's detail view. */
export async function listJobTransitions(db: Queryable, jobId: string): Promise<
  { id: number; from_status: string | null; to_status: string; worker_id: string | null; reason: string | null; created_at: Date }[]
> {
  const { rows } = await db.query(
    `SELECT id, from_status, to_status, worker_id, reason, created_at
       FROM job_state_transitions WHERE job_id = $1 ORDER BY id ASC`,
    [jobId],
  );
  return rows as never;
}

/** Cancel a job that hasn't started yet (queued/scheduled -> cancelled). */
export async function cancelJob(db: Queryable, jobId: string): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'scheduled')
      RETURNING *`,
    [jobId],
  );
  return rows[0] ?? null;
}

// ── Workers ──────────────────────────────────────────────────────────────────

/** All workers with their current in-flight job count (dashboard worker view). */
export async function listWorkers(db: Queryable): Promise<(WorkerRow & { running_jobs: number })[]> {
  const { rows } = await db.query<WorkerRow & { running_jobs: number }>(
    `SELECT w.*,
            (SELECT count(*)::int FROM jobs j
              WHERE j.claimed_by = w.id AND j.status IN ('claimed','running')) AS running_jobs
       FROM workers w
      ORDER BY w.last_heartbeat DESC`,
  );
  return rows;
}

// ── Dead Letter Queue ──────────────────────────────────────────────────────────

export interface DeadLetterRow {
  id: string;
  job_id: string;
  queue_id: string;
  reason: string;
  attempts_made: number;
  last_error: string | null;
  payload: Record<string, unknown>;
  moved_at: Date;
}

export async function listDeadLetter(db: Queryable, queueId: string, page: Page): Promise<DeadLetterRow[]> {
  const { rows } = await db.query<DeadLetterRow>(
    `SELECT * FROM dead_letter_queue WHERE queue_id = $1
      ORDER BY moved_at DESC LIMIT $2 OFFSET $3`,
    [queueId, page.limit, page.offset],
  );
  return rows;
}

export async function countDeadLetter(db: Queryable, queueId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dead_letter_queue WHERE queue_id = $1`,
    [queueId],
  );
  return rows[0]!.n;
}

/**
 * Manually retry a job:
 *   - dead_letter -> queued, attempts RESET to 0 (fresh retry budget), DLQ row removed.
 *   - failed (in backoff) -> queued now (skip the remaining backoff).
 * Returns null if the job isn't in a retriable state.
 */
export async function retryJob(pool: Pool, jobId: string): Promise<JobRow | null> {
  return withTransaction(pool, async (client) => {
    const current = await client.query<JobRow>(`SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [jobId]);
    const job = current.rows[0];
    if (!job) return null;

    if (job.status === 'dead_letter') {
      await client.query(`DELETE FROM dead_letter_queue WHERE job_id = $1`, [jobId]);
      const updated = await client.query<JobRow>(
        `UPDATE jobs
            SET status = 'queued', attempts = 0, last_error = NULL, run_at = now(),
                claimed_by = NULL, claimed_at = NULL, started_at = NULL, lock_expires_at = NULL,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [jobId],
      );
      await logTransition(client, jobId, 'dead_letter', 'queued', null, 'manual retry from DLQ (attempts reset)');
      return updated.rows[0]!;
    }

    if (job.status === 'failed') {
      const updated = await client.query<JobRow>(
        `UPDATE jobs SET status = 'queued', run_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [jobId],
      );
      await logTransition(client, jobId, 'failed', 'queued', null, 'manual retry (backoff skipped)');
      return updated.rows[0]!;
    }

    return null; // not retriable from its current state
  });
}
