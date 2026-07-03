import type { Pool, PoolClient } from '@codity/db';
import { withTransaction, logTransition } from './tx.js';
import { computeBackoffMs } from './retry.js';
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

/** Insert a Dead Letter Queue row for a job (idempotent on job_id). */
async function insertDeadLetter(
  client: PoolClient,
  job: Pick<JobRow, 'id' | 'queue_id' | 'attempts' | 'payload'>,
  reason: string,
  lastError: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO dead_letter_queue (job_id, queue_id, reason, attempts_made, last_error, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id) DO NOTHING`,
    [job.id, job.queue_id, reason, job.attempts, lastError, job.payload],
  );
}

export interface FailOutcome {
  job: JobRow;
  outcome: 'retry_scheduled' | 'dead_lettered';
  /** Backoff delay applied before the retry (only when outcome is retry_scheduled). */
  retryDelayMs?: number;
}

/**
 * running -> failed. Applies the job's SNAPSHOTTED retry policy:
 *   - attempts remaining  -> status 'failed' with run_at pushed out by the computed
 *     backoff (a resting "in-backoff" state; the scheduler's promoter later flips it back
 *     to 'queued' when run_at elapses).
 *   - attempts exhausted  -> status 'dead_letter' + a dead_letter_queue row.
 * Returns null if the job is no longer running under this worker (e.g. it was reaped).
 */
export async function failJob(
  pool: Pool,
  jobId: string,
  workerId: string,
  error: Error | string,
  rng: () => number = Math.random,
): Promise<FailOutcome | null> {
  const message = error instanceof Error ? error.message : error;
  return withTransaction(pool, async (client) => {
    // Guarded claim of the transition; also locks the row for the rest of the tx.
    const { rows } = await client.query<JobRow>(
      `UPDATE jobs SET last_error = $3, updated_at = now()
        WHERE id = $1 AND status = 'running' AND claimed_by = $2
        RETURNING *`,
      [jobId, workerId, message],
    );
    const job = rows[0];
    if (!job) return null;
    await finishLatestExecution(client, jobId, 'failed', { error });

    if (job.attempts < job.max_attempts) {
      const delay = computeBackoffMs(job.retry_config, job.attempts, rng);
      const updated = await client.query<JobRow>(
        `UPDATE jobs
            SET status = 'failed',
                claimed_by = NULL, claimed_at = NULL, started_at = NULL, lock_expires_at = NULL,
                run_at = now() + ($2::numeric * interval '1 millisecond'),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [jobId, delay],
      );
      await logTransition(
        client,
        jobId,
        'running',
        'failed',
        workerId,
        `attempt ${job.attempts}/${job.max_attempts} failed; retry in ${delay}ms`,
      );
      return { job: updated.rows[0]!, outcome: 'retry_scheduled', retryDelayMs: delay };
    }

    // Attempts exhausted -> Dead Letter Queue.
    const updated = await client.query<JobRow>(
      `UPDATE jobs
          SET status = 'dead_letter',
              claimed_by = NULL, claimed_at = NULL, started_at = NULL, lock_expires_at = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [jobId],
    );
    await insertDeadLetter(client, job, 'max attempts exhausted', message);
    await logTransition(
      client,
      jobId,
      'running',
      'dead_letter',
      workerId,
      `attempt ${job.attempts}/${job.max_attempts} failed; moved to DLQ`,
    );
    return { job: updated.rows[0]!, outcome: 'dead_lettered' };
  });
}

/**
 * Promote jobs whose retry backoff has elapsed: status 'failed' with run_at<=now() ->
 * 'queued'. Runs in the scheduler. Returns the promoted job ids.
 */
export async function promoteRetriableJobs(pool: Pool, limit = 100): Promise<string[]> {
  const { rows } = await pool.query<{ job_id: string }>(
    `WITH due AS (
        SELECT id FROM jobs
         WHERE status = 'failed' AND run_at <= now()
         ORDER BY run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
     ),
     promoted AS (
        UPDATE jobs SET status = 'queued', updated_at = now()
         WHERE id IN (SELECT id FROM due)
         RETURNING id
     )
     INSERT INTO job_state_transitions (job_id, from_status, to_status, reason)
     SELECT id, 'failed', 'queued', 'retry backoff elapsed' FROM promoted
     RETURNING job_id`,
    [limit],
  );
  return rows.map((r) => r.job_id);
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
  deadLetteredJobIds: string[];
}

/**
 * REAPER: recover jobs from crashed/hung workers. Finds claimed/running jobs whose lock
 * has expired (heartbeats stopped extending it), fails their orphaned execution row, and
 * either returns them to 'queued' for immediate re-pickup (crash = infra fault, no backoff
 * penalty) or, if attempts are exhausted, moves them to the Dead Letter Queue — so a
 * "poison" job that keeps crashing workers can't loop forever. Idempotent and safe to run
 * concurrently (FOR UPDATE SKIP LOCKED on the candidate scan).
 */
export async function requeueExpiredJobs(pool: Pool, limit = 100): Promise<ReapResult> {
  return withTransaction(pool, async (client) => {
    const candidates = await client.query<
      Pick<JobRow, 'id' | 'status' | 'attempts' | 'max_attempts' | 'queue_id' | 'payload' | 'last_error'>
    >(
      `SELECT id, status, attempts, max_attempts, queue_id, payload, last_error
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
    const deadLetteredJobIds: string[] = [];
    for (const row of candidates.rows) {
      // Close out the abandoned attempt (only matters if it had reached 'running').
      if (row.status === 'running') {
        await finishLatestExecution(client, row.id, 'failed', {
          error: 'worker lost: lock expired before completion',
        });
      }

      if (row.attempts < row.max_attempts) {
        await client.query(
          `UPDATE jobs
              SET status = 'queued',
                  claimed_by = NULL, claimed_at = NULL, started_at = NULL, lock_expires_at = NULL,
                  run_at = now(),
                  last_error = 'reaped: worker lock expired',
                  updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        await logTransition(client, row.id, row.status, 'queued', null, 'reaped: lock expired');
        requeuedJobIds.push(row.id);
      } else {
        await client.query(
          `UPDATE jobs
              SET status = 'dead_letter',
                  claimed_by = NULL, claimed_at = NULL, started_at = NULL, lock_expires_at = NULL,
                  updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        await insertDeadLetter(
          client,
          row,
          'reaped: max attempts exhausted',
          row.last_error ?? 'worker lock expired',
        );
        await logTransition(client, row.id, row.status, 'dead_letter', null, 'reaped: max attempts exhausted');
        deadLetteredJobIds.push(row.id);
      }
    }
    return { requeuedJobIds, deadLetteredJobIds };
  });
}
