import type { Pool } from '@codity/db';
import { markStaleWorkersDead, requeueExpiredJobs, promoteRetriableJobs } from '@codity/core';
import type { Logger } from '@codity/shared';

export interface ReaperConfig {
  intervalMs: number;
  /** A worker silent for longer than this is marked dead. */
  deadAfterMs: number;
  /** Max jobs to requeue per tick (bounds the transaction). */
  batchLimit?: number;
}

/**
 * The scheduler sweep is a SINGLETON loop (runs in the scheduler process, not the
 * horizontally-scaled workers — see docs/architecture.md). Each tick:
 *   1. marks workers that stopped heartbeating as 'dead' (dashboard signal),
 *   2. requeues jobs whose lock expired — recovering work from crashed/hung workers
 *      (or dead-lettering them if attempts are exhausted),
 *   3. promotes retriable jobs whose backoff has elapsed ('failed' + due -> 'queued').
 *
 * Ticks never overlap (guarded), and each step is safe to run concurrently with other
 * instances anyway (FOR UPDATE SKIP LOCKED), so this is robust even if the singleton
 * assumption is temporarily violated during a deploy. Phase 6 adds cron promotion here.
 */
export class Reaper {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly config: ReaperConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.logger.info({ intervalMs: this.config.intervalMs, deadAfterMs: this.config.deadAfterMs }, 'reaper started');
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const dead = await markStaleWorkersDead(this.pool, this.config.deadAfterMs);
      if (dead.length > 0) {
        this.logger.warn({ workerIds: dead }, 'marked stale workers dead');
      }
      const { requeuedJobIds, deadLetteredJobIds } = await requeueExpiredJobs(
        this.pool,
        this.config.batchLimit ?? 100,
      );
      if (requeuedJobIds.length > 0) {
        this.logger.warn({ count: requeuedJobIds.length }, 'requeued jobs from expired locks');
      }
      if (deadLetteredJobIds.length > 0) {
        this.logger.warn({ count: deadLetteredJobIds.length }, 'dead-lettered jobs (attempts exhausted)');
      }

      const promoted = await promoteRetriableJobs(this.pool, this.config.batchLimit ?? 100);
      if (promoted.length > 0) {
        this.logger.info({ count: promoted.length }, 'promoted retriable jobs (backoff elapsed)');
      }
    } catch (err) {
      this.logger.error({ err }, 'reaper tick failed');
    } finally {
      this.ticking = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.logger.info('reaper stopped');
  }
}
