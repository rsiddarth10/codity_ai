import type { Pool, PoolClient } from '@codity/db';
import { withTransaction, logTransition } from './tx.js';
import type { JobRow } from './types.js';

/**
 * Job lifecycle transitions AFTER claiming (see claim.ts for claim). Every transition:
 *   - is guarded by an atomic conditional UPDATE (WHERE status=<expected> AND owner),
 *     so a stale worker whose job was reaped can't clobber a newer state,
 *   - writes to job_executions (one row per attempt) and job_state_transitions (audit).
 *
 * NOTE: failJob here records the failure only (status -> 'failed'). The retry/backoff
 * decision and Dead Letter Queue move are added in Phase 5; this phase proves the
 * claim/run/complete/fail/heartbeat/reap machinery under real concurrency.
 */

/** Update the most recent execution row for a job (the current attempt). */
async function finishLatestExecution(
  client: PoolClient,
  jobId: string,
  status: 'succeeded' | 'failed',
  fields: { result?: Record<string, unknown> | null; error?: Error | string | null } = {},
): Promise<void> {
  const errorMessage =
    fields.error instanceof Error ? fields.error.message : (fields.error ?? null);
  const errorStack = fields.error instanceof Error ? (fields.error.stack ?? null) : null;
  await client.query(
    `UPDATE job_executions
        SET status = $2,
            finished_at = now(),
            duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
            result = $3,
            error_message = $4,
            error_stack = $5
      WHERE id = (
        SELECT id FROM job_executions
         WHERE job_id = $1
         ORDER BY attempt_number DESC
         LIMIT 1
      )`,
    [jobId, status, fields.result ?? null, errorMessage, errorStack],
  );
}

export interface StartResult {
  job: JobRow;
  executionId: string;
}

/**
 * claimed -> running. Increments attempts and opens a job_executions row for this
 * attempt. Returns null if the job is no longer claimed by this worker (e.g. reaped).
 */
export async function startJob(
  pool: Pool,
  jobId: string,
  workerId: string,
): Promise<StartResult | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<JobRow>(
      `UPDATE jobs
          SET status = 'running',
              started_at = now(),
              attempts = attempts + 1,
              updated_at = now()
        WHERE id = $1 AND status = 'claimed' AND claimed_by = $2
        RETURNING *`,
      [jobId, workerId],
    );
    const job = rows[0];
    if (!job) return null;

    const exec = await client.query<{ id: string }>(
      `INSERT INTO job_executions (job_id, attempt_number, worker_id, status)
       VALUES ($1, $2, $3, 'running')
       RETURNING id`,
      [jobId, job.attempts, workerId],
    );
    await logTransition(client, jobId, 'claimed', 'running', workerId, `attempt ${job.attempts}`);
    return { job, executionId: exec.rows[0]!.id };
  });
}

/** running -> completed. Records the successful execution + result. */
export async function completeJob(
  pool: Pool,
  jobId: string,
  workerId: string,
  result: Record<string, unknown> | null = null,
): Promise<JobRow | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<JobRow>(
      `UPDATE jobs
          SET status = 'completed',
              completed_at = now(),
              result = $3,
              lock_expires_at = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'running' AND claimed_by = $2
        RETURNING *`,
      [jobId, workerId, result],
    );
    const job = rows[0];
    if (!job) return null;
    await finishLatestExecution(client, jobId, 'succeeded', { result });
    await logTransition(client, jobId, 'running', 'completed', workerId, 'succeeded');
    return job;
  });
}

/**
 * running -> failed (Phase 2: terminal failure record only; Phase 5 adds retry/DLQ).
 * Returns null if the job is no longer running under this worker.
 */
export async function failJob(
  pool: Pool,
  jobId: string,
  workerId: string,
  error: Error | string,
): Promise<JobRow | null> {
  const message = error instanceof Error ? error.message : error;
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<JobRow>(
      `UPDATE jobs
          SET status = 'failed',
              last_error = $3,
              lock_expires_at = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'running' AND claimed_by = $2
        RETURNING *`,
      [jobId, workerId, message],
    );
    const job = rows[0];
    if (!job) return null;
    await finishLatestExecution(client, jobId, 'failed', { error });
    await logTransition(client, jobId, 'running', 'failed', workerId, message);
    return job;
  });
}

/**
 * Extend the lock on a worker's in-flight jobs. Only touches jobs still owned by this
 * worker and in a live state — a reaped/stolen job silently won't be extended.
 * Returns the number of jobs whose lock was refreshed.
 */
export async function heartbeatJobs(
  pool: Pool,
  workerId: string,
  jobIds: string[],
  lockDurationMs: number,
): Promise<number> {
  if (jobIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `UPDATE jobs
        SET lock_expires_at = now() + ($3::numeric * interval '1 millisecond'),
            updated_at = now()
      WHERE id = ANY($1::uuid[])
        AND claimed_by = $2
        AND status IN ('claimed', 'running')`,
    [jobIds, workerId, lockDurationMs],
  );
  return rowCount ?? 0;
}

export interface ReapResult {
  requeuedJobIds: string[];
}

/**
 * REAPER: recover jobs from crashed/hung workers. Finds claimed/running jobs whose lock
 * has expired (heartbeats stopped extending it), fails their orphaned execution row, and
 * returns them to 'queued' for another worker to pick up. Idempotent and safe to run
 * concurrently (FOR UPDATE SKIP LOCKED on the candidate scan).
 *
 * Phase 2 always requeues; Phase 5 will dead-letter when attempts are exhausted.
 */
export async function requeueExpiredJobs(pool: Pool, limit = 100): Promise<ReapResult> {
  return withTransaction(pool, async (client) => {
    const candidates = await client.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM jobs
        WHERE status IN ('claimed', 'running')
          AND lock_expires_at IS NOT NULL
          AND lock_expires_at < now()
        ORDER BY lock_expires_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );

    const requeuedJobIds: string[] = [];
    for (const row of candidates.rows) {
      // Close out the abandoned attempt (only matters if it had reached 'running').
      if (row.status === 'running') {
        await finishLatestExecution(client, row.id, 'failed', {
          error: 'worker lost: lock expired before completion',
        });
      }
      await client.query(
        `UPDATE jobs
            SET status = 'queued',
                claimed_by = NULL,
                claimed_at = NULL,
                started_at = NULL,
                lock_expires_at = NULL,
                run_at = now(),
                last_error = 'reaped: worker lock expired',
                updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      await logTransition(client, row.id, row.status, 'queued', null, 'reaped: lock expired');
      requeuedJobIds.push(row.id);
    }
    return { requeuedJobIds };
  });
}
