import type { Pool } from '@codity/db';
import {
  markStaleWorkersDead,
  requeueExpiredJobs,
  promoteRetriableJobs,
  promoteScheduledJobs,
  promoteDueSchedules,
  resolveJobDependencies,
} from '@codity/core';
import type { Logger } from '@codity/shared';

export interface SchedulerLoopConfig {
  intervalMs: number;
  /** A worker silent for longer than this is marked dead. */
  deadAfterMs: number;
  /** Max rows processed per step per tick (bounds each transaction). */
  batchLimit?: number;
}

/**
 * The scheduler sweep — a SINGLETON periodic loop (runs in the scheduler process, not the
 * horizontally-scaled workers). Each non-overlapping tick performs all time-based
 * maintenance, in order:
 *   1. mark workers that stopped heartbeating as 'dead',
 *   2. reap expired locks: requeue crashed jobs (or dead-letter if exhausted),
 *   3. promote retriable jobs whose backoff elapsed ('failed' + due -> 'queued'),
 *   4. promote one-shot delayed jobs that are due ('scheduled' + due -> 'queued'),
 *   5. fire due cron schedules (scheduled_jobs -> new job instances),
 *   6. resolve workflow dependencies ('blocked' -> 'queued' when parents complete, or
 *      -> 'cancelled' when a parent dead-letters/cancels).
 *
 * Every step uses FOR UPDATE SKIP LOCKED, so even if two loops briefly overlap during a
 * deploy nothing double-fires or double-recovers.
 */
export class SchedulerLoop {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly config: SchedulerLoopConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.logger.info(
      { intervalMs: this.config.intervalMs, deadAfterMs: this.config.deadAfterMs },
      'scheduler loop started',
    );
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    const limit = this.config.batchLimit ?? 100;
    try {
      const dead = await markStaleWorkersDead(this.pool, this.config.deadAfterMs);
      if (dead.length > 0) this.logger.warn({ workerIds: dead }, 'marked stale workers dead');

      const { requeuedJobIds, deadLetteredJobIds } = await requeueExpiredJobs(this.pool, limit);
      if (requeuedJobIds.length > 0) this.logger.warn({ count: requeuedJobIds.length }, 'requeued jobs from expired locks');
      if (deadLetteredJobIds.length > 0) this.logger.warn({ count: deadLetteredJobIds.length }, 'dead-lettered jobs (attempts exhausted)');

      const retried = await promoteRetriableJobs(this.pool, limit);
      if (retried.length > 0) this.logger.info({ count: retried.length }, 'promoted retriable jobs (backoff elapsed)');

      const delayed = await promoteScheduledJobs(this.pool, limit);
      if (delayed.length > 0) this.logger.info({ count: delayed.length }, 'promoted delayed jobs (run_at reached)');

      const fired = await promoteDueSchedules(this.pool, limit);
      if (fired.length > 0) this.logger.info({ count: fired.length }, 'fired cron schedules');

      const deps = await resolveJobDependencies(this.pool, limit * 2);
      if (deps.promotedJobIds.length > 0) this.logger.info({ count: deps.promotedJobIds.length }, 'unblocked jobs (dependencies met)');
      if (deps.cancelledJobIds.length > 0) this.logger.warn({ count: deps.cancelledJobIds.length }, 'cancelled jobs (dependency failed)');
    } catch (err) {
      this.logger.error({ err }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.logger.info('scheduler loop stopped');
  }
}
