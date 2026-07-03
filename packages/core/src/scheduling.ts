import parser from 'cron-parser';
import type { Pool } from '@codity/db';
import { withTransaction, type Queryable } from './tx.js';
import { enqueueJobOnClient } from './jobs.js';

/**
 * Scheduling: one-shot delayed jobs, recurring cron schedules, and batch rollups.
 * Cron math is delegated to `cron-parser` (never hand-rolled).
 */

export interface ScheduledJobRow {
  id: string;
  queue_id: string;
  name: string;
  cron_expression: string;
  timezone: string;
  payload: Record<string, unknown>;
  priority: number;
  retry_policy_id: string | null;
  is_active: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Next fire time strictly after `from` for a cron expression in a timezone. */
export function cronNextRun(cronExpression: string, timezone = 'UTC', from: Date = new Date()): Date {
  return parser.parseExpression(cronExpression, { currentDate: from, tz: timezone }).next().toDate();
}

/** Validate a cron expression (used by the API to reject bad input with a 400). */
export function isValidCron(cronExpression: string, timezone = 'UTC'): boolean {
  try {
    parser.parseExpression(cronExpression, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

// ── Schedule CRUD ──────────────────────────────────────────────────────────────

export interface CreateScheduleInput {
  queueId: string;
  name: string;
  cronExpression: string;
  timezone?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  retryPolicyId?: string | null;
}

export async function createSchedule(db: Queryable, input: CreateScheduleInput): Promise<ScheduledJobRow> {
  const timezone = input.timezone ?? 'UTC';
  const nextRunAt = cronNextRun(input.cronExpression, timezone);
  const { rows } = await db.query<ScheduledJobRow>(
    `INSERT INTO scheduled_jobs
       (queue_id, name, cron_expression, timezone, payload, priority, retry_policy_id, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.queueId,
      input.name,
      input.cronExpression,
      timezone,
      input.payload ?? {},
      input.priority ?? 0,
      input.retryPolicyId ?? null,
      nextRunAt,
    ],
  );
  return rows[0]!;
}

export async function listSchedules(db: Queryable, queueId: string): Promise<ScheduledJobRow[]> {
  const { rows } = await db.query<ScheduledJobRow>(
    `SELECT * FROM scheduled_jobs WHERE queue_id = $1 ORDER BY created_at DESC`,
    [queueId],
  );
  return rows;
}

export async function getSchedule(db: Queryable, scheduleId: string): Promise<ScheduledJobRow | null> {
  const { rows } = await db.query<ScheduledJobRow>(`SELECT * FROM scheduled_jobs WHERE id = $1`, [scheduleId]);
  return rows[0] ?? null;
}

/** organization_id owning a schedule (via queue -> project), or null. */
export async function scheduleOrganizationId(db: Queryable, scheduleId: string): Promise<string | null> {
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT p.organization_id
       FROM scheduled_jobs s
       JOIN queues q ON q.id = s.queue_id
       JOIN projects p ON p.id = q.project_id
      WHERE s.id = $1`,
    [scheduleId],
  );
  return rows[0]?.organization_id ?? null;
}

export interface UpdateSchedulePatch {
  name?: string;
  cronExpression?: string;
  timezone?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  isActive?: boolean;
}

export async function updateSchedule(
  pool: Pool,
  scheduleId: string,
  patch: UpdateSchedulePatch,
): Promise<ScheduledJobRow | null> {
  const current = await getSchedule(pool, scheduleId);
  if (!current) return null;

  const cronExpression = patch.cronExpression ?? current.cron_expression;
  const timezone = patch.timezone ?? current.timezone;
  // Recompute the next fire time only if the schedule shape changed.
  const recompute = patch.cronExpression !== undefined || patch.timezone !== undefined;
  const nextRunAt = recompute ? cronNextRun(cronExpression, timezone) : current.next_run_at;

  const { rows } = await pool.query<ScheduledJobRow>(
    `UPDATE scheduled_jobs SET
        name = COALESCE($2, name),
        cron_expression = $3,
        timezone = $4,
        payload = COALESCE($5, payload),
        priority = COALESCE($6, priority),
        is_active = COALESCE($7, is_active),
        next_run_at = $8,
        updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      scheduleId,
      patch.name ?? null,
      cronExpression,
      timezone,
      patch.payload ?? null,
      patch.priority ?? null,
      patch.isActive ?? null,
      nextRunAt,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteSchedule(db: Queryable, scheduleId: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM scheduled_jobs WHERE id = $1`, [scheduleId]);
  return (rowCount ?? 0) > 0;
}

// ── Promoters (run by the scheduler) ─────────────────────────────────────────────

/** One-shot delayed/scheduled jobs whose run_at has arrived: 'scheduled' -> 'queued'. */
export async function promoteScheduledJobs(pool: Pool, limit = 100): Promise<string[]> {
  const { rows } = await pool.query<{ job_id: string }>(
    `WITH due AS (
        SELECT id FROM jobs
         WHERE status = 'scheduled' AND run_at <= now()
         ORDER BY run_at ASC LIMIT $1
         FOR UPDATE SKIP LOCKED
     ),
     promoted AS (
        UPDATE jobs SET status = 'queued', updated_at = now()
         WHERE id IN (SELECT id FROM due) RETURNING id
     )
     INSERT INTO job_state_transitions (job_id, from_status, to_status, reason)
     SELECT id, 'scheduled', 'queued', 'delayed run_at elapsed' FROM promoted
     RETURNING job_id`,
    [limit],
  );
  return rows.map((r) => r.job_id);
}

/**
 * Fire due cron schedules: for each active schedule with next_run_at<=now(), enqueue a
 * concrete job instance (linked via jobs.scheduled_job_id) and advance next_run_at to the
 * next occurrence AFTER now(). Advancing from now() (not from the missed slot) means a
 * scheduler that was down does not backfill a storm of missed runs — it fires once and
 * moves on. Enqueue + advance commit in one transaction per sweep.
 */
export async function promoteDueSchedules(pool: Pool, limit = 100): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    const due = await client.query<ScheduledJobRow>(
      `SELECT * FROM scheduled_jobs
        WHERE is_active = true AND next_run_at IS NOT NULL AND next_run_at <= now()
        ORDER BY next_run_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    const createdJobIds: string[] = [];
    for (const schedule of due.rows) {
      const { job } = await enqueueJobOnClient(client, {
        queueId: schedule.queue_id,
        payload: schedule.payload,
        priority: schedule.priority,
        scheduledJobId: schedule.id,
        retryPolicyId: schedule.retry_policy_id,
      });
      createdJobIds.push(job.id);

      const nextRunAt = cronNextRun(schedule.cron_expression, schedule.timezone, new Date());
      await client.query(
        `UPDATE scheduled_jobs SET last_run_at = now(), next_run_at = $2, updated_at = now() WHERE id = $1`,
        [schedule.id, nextRunAt],
      );
    }
    return createdJobIds;
  });
}

// ── Workflow dependencies ────────────────────────────────────────────────────

export interface DependencyResolution {
  promotedJobIds: string[];
  cancelledJobIds: string[];
}

/**
 * Resolve blocked jobs (run by the scheduler):
 *   - all parents 'completed'          -> promote to 'queued',
 *   - any parent 'dead_letter'/'cancelled' -> cancel (the dependency can never be met).
 * FOR UPDATE ... SKIP LOCKED keeps it safe under concurrency.
 */
export async function resolveJobDependencies(pool: Pool, limit = 200): Promise<DependencyResolution> {
  const promote = await pool.query<{ job_id: string }>(
    `WITH ready AS (
        SELECT j.id FROM jobs j
         WHERE j.status = 'blocked'
           AND NOT EXISTS (
             SELECT 1 FROM job_dependencies d JOIN jobs p ON p.id = d.depends_on_job_id
              WHERE d.job_id = j.id AND p.status <> 'completed'
           )
         ORDER BY j.created_at ASC
         LIMIT $1
         FOR UPDATE OF j SKIP LOCKED
     ),
     promoted AS (
        UPDATE jobs SET status = 'queued', updated_at = now()
         WHERE id IN (SELECT id FROM ready) RETURNING id
     )
     INSERT INTO job_state_transitions (job_id, from_status, to_status, reason)
     SELECT id, 'blocked', 'queued', 'all dependencies completed' FROM promoted
     RETURNING job_id`,
    [limit],
  );

  const cancel = await pool.query<{ job_id: string }>(
    `WITH dead AS (
        SELECT j.id FROM jobs j
         WHERE j.status = 'blocked'
           AND EXISTS (
             SELECT 1 FROM job_dependencies d JOIN jobs p ON p.id = d.depends_on_job_id
              WHERE d.job_id = j.id AND p.status IN ('dead_letter', 'cancelled')
           )
         LIMIT $1
         FOR UPDATE OF j SKIP LOCKED
     ),
     cancelled AS (
        UPDATE jobs SET status = 'cancelled', last_error = 'dependency failed', updated_at = now()
         WHERE id IN (SELECT id FROM dead) RETURNING id
     )
     INSERT INTO job_state_transitions (job_id, from_status, to_status, reason)
     SELECT id, 'blocked', 'cancelled', 'dependency failed (parent dead-lettered or cancelled)' FROM cancelled
     RETURNING job_id`,
    [limit],
  );

  return {
    promotedJobIds: promote.rows.map((r) => r.job_id),
    cancelledJobIds: cancel.rows.map((r) => r.job_id),
  };
}

/** List a job's dependency parents with their current status (for the API/detail view). */
export async function listJobDependencies(
  db: Queryable,
  jobId: string,
): Promise<{ depends_on_job_id: string; status: string }[]> {
  const { rows } = await db.query<{ depends_on_job_id: string; status: string }>(
    `SELECT d.depends_on_job_id, p.status
       FROM job_dependencies d JOIN jobs p ON p.id = d.depends_on_job_id
      WHERE d.job_id = $1
      ORDER BY d.created_at ASC`,
    [jobId],
  );
  return rows;
}

// ── Batch rollup ─────────────────────────────────────────────────────────────

export interface BatchStatus {
  id: string;
  name: string;
  total_jobs: number;
  created_at: Date;
  counts: Record<string, number>;
  terminal: number; // completed + dead_letter + cancelled
  pending: number; // total - terminal
  done: boolean;
}

export async function batchOrganizationId(db: Queryable, batchId: string): Promise<string | null> {
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT p.organization_id
       FROM job_batches b JOIN projects p ON p.id = b.project_id
      WHERE b.id = $1`,
    [batchId],
  );
  return rows[0]?.organization_id ?? null;
}

/** Batch-level status rollup (counts by status + done/pending), or null if missing. */
export async function getBatchStatus(db: Queryable, batchId: string): Promise<BatchStatus | null> {
  const meta = await db.query<{ id: string; name: string; total_jobs: number; created_at: Date }>(
    `SELECT id, name, total_jobs, created_at FROM job_batches WHERE id = $1`,
    [batchId],
  );
  const batch = meta.rows[0];
  if (!batch) return null;

  const grouped = await db.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM jobs WHERE batch_id = $1 GROUP BY status`,
    [batchId],
  );
  const counts: Record<string, number> = {};
  for (const row of grouped.rows) counts[row.status] = row.count;

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const terminal =
    (counts.completed ?? 0) + (counts.dead_letter ?? 0) + (counts.cancelled ?? 0);

  return {
    id: batch.id,
    name: batch.name,
    total_jobs: batch.total_jobs,
    created_at: batch.created_at,
    counts,
    terminal,
    pending: total - terminal,
    done: total > 0 && terminal === total,
  };
}
