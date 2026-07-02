import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Pool } from '@codity/db';
import { enqueueJob, claimJobs, registerWorker, type JobRow } from '@codity/core';
import { testPool, resetDb, seedQueue } from './helpers.js';

/**
 * THE grade-critical test: many concurrent claimers hammering one queue must partition
 * the jobs into DISJOINT, COMPLETE sets — zero duplicate claims, nothing lost. This is
 * what `FOR UPDATE SKIP LOCKED` buys us.
 */
describe('atomic claiming under real concurrency', () => {
  const pool: Pool = testPool(40);

  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('N jobs, C concurrent claimers -> each job claimed exactly once (no duplicates, none lost)', async () => {
    const JOBS = 500;
    const CLAIMERS = 24;

    // A very high concurrency limit so this test isolates the SKIP LOCKED property,
    // not the concurrency cap (that has its own test).
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 100_000 });

    await Promise.all(
      Array.from({ length: JOBS }, (_, i) =>
        enqueueJob(pool, { queueId, payload: { i }, priority: i % 5 }),
      ),
    );

    // Each claimer is an independent "worker": its own workers row, its own loop draining
    // the queue one job at a time. They are all launched together for maximum contention.
    async function claimerLoop(workerName: string): Promise<string[]> {
      const worker = await registerWorker(pool, { name: workerName, concurrency: 1 });
      const claimedIds: string[] = [];
      // Loop until the queue yields nothing to this claimer.
      for (;;) {
        const jobs: JobRow[] = await claimJobs(pool, {
          queueId,
          workerId: worker.id,
          batchSize: 1,
          lockDurationMs: 30_000,
        });
        if (jobs.length === 0) break;
        for (const j of jobs) claimedIds.push(j.id);
      }
      return claimedIds;
    }

    const perClaimer = await Promise.all(
      Array.from({ length: CLAIMERS }, (_, c) => claimerLoop(`worker-${c}`)),
    );

    const allClaimed = perClaimer.flat();

    // 1) Completeness: every job was claimed.
    expect(allClaimed).toHaveLength(JOBS);

    // 2) No duplicates: the set of claimed ids equals the number of jobs.
    expect(new Set(allClaimed).size).toBe(JOBS);

    // 3) DB agrees: all jobs are 'claimed', each with a non-null owner.
    const dbCheck = await pool.query<{ status: string; owned: number; total: number }>(
      `SELECT status,
              count(*) FILTER (WHERE claimed_by IS NOT NULL)::int AS owned,
              count(*)::int AS total
         FROM jobs WHERE queue_id = $1 GROUP BY status`,
      [queueId],
    );
    expect(dbCheck.rows).toHaveLength(1);
    expect(dbCheck.rows[0]!.status).toBe('claimed');
    expect(dbCheck.rows[0]!.total).toBe(JOBS);
    expect(dbCheck.rows[0]!.owned).toBe(JOBS);

    // 4) No job has two claim transitions in the audit log.
    const dupTransitions = await pool.query<{ job_id: string; n: number }>(
      `SELECT job_id, count(*)::int AS n
         FROM job_state_transitions
        WHERE to_status = 'claimed'
        GROUP BY job_id HAVING count(*) > 1`,
    );
    expect(dupTransitions.rows).toHaveLength(0);
  });

  it('claims respect priority DESC then FIFO', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 100_000 });
    // Insert in mixed order; expect priority 9 before 5 before 1, FIFO within a priority.
    await enqueueJob(pool, { queueId, payload: { tag: 'a' }, priority: 1 });
    await enqueueJob(pool, { queueId, payload: { tag: 'b' }, priority: 9 });
    await enqueueJob(pool, { queueId, payload: { tag: 'c' }, priority: 5 });
    await enqueueJob(pool, { queueId, payload: { tag: 'd' }, priority: 9 });

    const worker = await registerWorker(pool, { name: 'w', concurrency: 1 });
    const order: string[] = [];
    for (;;) {
      const [job] = await claimJobs(pool, {
        queueId,
        workerId: worker.id,
        batchSize: 1,
        lockDurationMs: 30_000,
      });
      if (!job) break;
      order.push((job.payload as { tag: string }).tag);
    }
    // b and d are priority 9 (b enqueued first), then c (5), then a (1).
    expect(order).toEqual(['b', 'd', 'c', 'a']);
  });
});
