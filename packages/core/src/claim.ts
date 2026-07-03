import type { Pool } from '@codity/db';
import { withTransaction, logTransition } from './tx.js';
import type { JobRow } from './types.js';

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE CLAIM QUERY — the heart of the scheduler.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Two safety properties, two mechanisms:
 *
 *  (1) NO TWO WORKERS EVER CLAIM THE SAME JOB.
 *      Guaranteed by `FOR UPDATE SKIP LOCKED` on the `claimable` CTE: each concurrent
 *      claimer row-locks the candidate jobs it selects and SKIPS any row already locked
 *      by another in-flight claim. Locked rows are invisible, not blocking — so N
 *      claimers partition the queue into disjoint sets with zero coordination and zero
 *      double-delivery. This holds with or without mechanism (2).
 *
 *  (2) THE QUEUE CONCURRENCY LIMIT IS NEVER EXCEEDED.
 *      "max running across ALL workers" requires an EXACT count of in-flight
 *      (claimed+running) jobs at claim time. A bare count is a read that races with
 *      other claimers' commits. We serialize the claim critical section PER QUEUE with a
 *      transaction-scoped advisory lock keyed by the queue id (see claimJobs). Within
 *      that lock the in-flight count is exact, so `capacity = limit - inflight` is
 *      correct and we can never overcommit. Different queues use different advisory keys
 *      and claim fully in parallel; execution is always concurrent. Claims are just fast
 *      row updates, so serializing them per queue is cheap. (Trade-off discussed in
 *      DESIGN.md §2.)
 *
 * Ordering: priority DESC (higher first), then oldest run_at, then FIFO by created_at.
 * Eligibility: status='queued' AND run_at<=now(); a paused queue yields capacity 0.
 * Matches the partial index idx_jobs_claim(queue_id, priority DESC, run_at, created_at)
 * WHERE status='queued'.
 */
export const CLAIM_JOBS_SQL = `
WITH cfg AS (
  SELECT concurrency_limit, is_paused, rate_limit_per_sec
  FROM queues
  WHERE id = $1
),
inflight AS (
  SELECT count(*)::int AS n
  FROM jobs
  WHERE queue_id = $1
    AND status IN ('claimed', 'running')
),
-- Jobs claimed within the last rolling second (for rate limiting). Exact because claims
-- for a queue are serialized by the advisory lock in claimJobs().
recent AS (
  SELECT count(*)::int AS n
  FROM jobs
  WHERE queue_id = $1
    AND claimed_at > now() - interval '1 second'
),
capacity AS (
  SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM cfg)          THEN 0
           WHEN (SELECT is_paused FROM cfg)             THEN 0
           ELSE LEAST(
                  $2::int,
                  -- concurrency headroom
                  GREATEST(0, (SELECT concurrency_limit FROM cfg) - (SELECT n FROM inflight)),
                  -- rate-limit headroom (NULL => unlimited)
                  CASE WHEN (SELECT rate_limit_per_sec FROM cfg) IS NULL THEN $2::int
                       ELSE GREATEST(0, (SELECT rate_limit_per_sec FROM cfg) - (SELECT n FROM recent))
                  END
                )
         END AS lim
),
claimable AS (
  SELECT j.id
  FROM jobs j
  WHERE j.queue_id = $1
    AND j.status = 'queued'
    AND j.run_at <= now()
  ORDER BY j.priority DESC, j.run_at ASC, j.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT (SELECT lim FROM capacity)
)
UPDATE jobs
   SET status = 'claimed',
       claimed_by = $3,
       claimed_at = now(),
       lock_expires_at = now() + ($4::numeric * interval '1 millisecond'),
       updated_at = now()
  FROM claimable
 WHERE jobs.id = claimable.id
 RETURNING jobs.*;
`;

export interface ClaimJobsInput {
  queueId: string;
  workerId: string;
  /** Upper bound on how many jobs to claim this poll (further capped by capacity). */
  batchSize: number;
  /** How long the claim lock is valid before the reaper may reclaim it. */
  lockDurationMs: number;
}

/**
 * Atomically claim up to `batchSize` jobs from a queue for a worker, respecting the
 * queue's concurrency limit and pause state. Returns the claimed job rows (possibly
 * empty). Each claim runs in its own transaction under a per-queue advisory lock.
 */
export async function claimJobs(pool: Pool, input: ClaimJobsInput): Promise<JobRow[]> {
  return withTransaction(pool, async (client) => {
    // Serialize the claim critical section for THIS queue only (mechanism 2 above).
    // hashtextextended(uuid::text) -> stable bigint advisory key.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
      input.queueId,
    ]);

    const { rows } = await client.query<JobRow>(CLAIM_JOBS_SQL, [
      input.queueId,
      input.batchSize,
      input.workerId,
      input.lockDurationMs,
    ]);

    for (const job of rows) {
      await logTransition(client, job.id, 'queued', 'claimed', input.workerId, 'claimed by worker');
    }
    return rows;
  });
}
