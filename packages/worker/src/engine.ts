import type { Pool } from '@codity/db';
import {
  claimJobs,
  startJob,
  completeJob,
  failJob,
  heartbeatJobs,
  heartbeatWorker,
  registerWorker,
  setWorkerStatus,
  listQueueIdsByPriority,
  addJobLog,
  type JobRow,
} from '@codity/core';
import type { Logger } from '@codity/shared';
import { type HandlerRegistry, type JobContext } from './handlers.js';

export interface WorkerEngineConfig {
  /** Explicit queue ids to poll. If omitted/empty, discover all non-paused queues. */
  queueIds?: string[];
  /** Max jobs this worker runs concurrently (the in-process semaphore size). */
  concurrency: number;
  pollIntervalMs: number;
  pollJitterMs: number;
  heartbeatIntervalMs: number;
  lockDurationMs: number;
  shutdownTimeoutMs: number;
  workerName: string;
}

export type StopOutcome = 'drained' | 'timeout';

/**
 * A single worker process's engine. Responsibilities:
 *   - poll assigned queues on an interval WITH JITTER (avoid thundering herd),
 *   - claim only up to the free semaphore slots (never overcommit),
 *   - execute jobs CONCURRENTLY (bounded by `concurrency`), not one-at-a-time,
 *   - heartbeat the worker AND extend in-flight job locks so the reaper leaves them be,
 *   - shut down gracefully: stop polling, drain in-flight up to a timeout, then exit.
 *
 * The engine is deliberately transport-free and injectable (pool, handlers, logger) so it
 * can be unit/integration-tested in-process; `index.ts` is the thin env-driven entrypoint.
 */
export class WorkerEngine {
  private workerId = '';
  /** jobId -> in-flight execution promise (its size IS the semaphore counter). */
  private readonly inFlight = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly abortController = new AbortController();

  constructor(
    private readonly pool: Pool,
    private readonly config: WorkerEngineConfig,
    private readonly handlers: HandlerRegistry,
    private readonly logger: Logger,
  ) {}

  get id(): string {
    return this.workerId;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  async start(): Promise<void> {
    const worker = await registerWorker(this.pool, {
      name: this.config.workerName,
      concurrency: this.config.concurrency,
      metadata: {
        host: process.env.HOSTNAME ?? 'local',
        pid: process.pid,
        queues: this.config.queueIds ?? 'all',
      },
    });
    this.workerId = worker.id;
    this.logger.info({ workerId: this.workerId, concurrency: this.config.concurrency }, 'worker started');

    this.startHeartbeat();
    this.scheduleNextPoll(0); // first poll immediately
  }

  private availableSlots(): number {
    return this.config.concurrency - this.inFlight.size;
  }

  /** One poll cycle: fill free slots by claiming across queues (priority order). */
  private async pollOnce(): Promise<void> {
    if (this.shuttingDown) return;
    let slots = this.availableSlots();
    if (slots <= 0) return;

    const queueIds =
      this.config.queueIds && this.config.queueIds.length > 0
        ? this.config.queueIds
        : await listQueueIdsByPriority(this.pool);

    for (const queueId of queueIds) {
      if (slots <= 0 || this.shuttingDown) break;
      const claimed = await claimJobs(this.pool, {
        queueId,
        workerId: this.workerId,
        batchSize: slots,
        lockDurationMs: this.config.lockDurationMs,
      });
      for (const job of claimed) {
        slots -= 1;
        this.launch(job);
      }
    }
  }

  /** Begin executing a claimed job; tracks it in the semaphore until settled. */
  private launch(job: JobRow): void {
    const promise = this.execute(job).finally(() => {
      this.inFlight.delete(job.id);
    });
    this.inFlight.set(job.id, promise);
  }

  private async execute(job: JobRow): Promise<void> {
    let executionId: string | null = null;
    try {
      const started = await startJob(this.pool, job.id, this.workerId);
      if (!started) {
        // Lost the job between claim and start (e.g. reaped). Nothing to do.
        this.logger.warn({ jobId: job.id }, 'could not start job (no longer owned)');
        return;
      }
      executionId = started.executionId;
      const ctx: JobContext = {
        job: started.job,
        signal: this.abortController.signal,
        log: (level, message, metadata) =>
          addJobLog(this.pool, { jobId: job.id, executionId, level, message, metadata }),
      };

      const handler = this.handlers.resolve(started.job);
      const result = await handler(ctx);
      await completeJob(this.pool, job.id, this.workerId, result ?? null);
      this.logger.debug({ jobId: job.id }, 'job completed');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await failJob(this.pool, job.id, this.workerId, error).catch((e) =>
        this.logger.error({ jobId: job.id, err: e }, 'failed to record job failure'),
      );
      if (executionId) {
        await addJobLog(this.pool, {
          jobId: job.id,
          executionId,
          level: 'error',
          message: error.message,
          metadata: { stack: error.stack },
        }).catch(() => {});
      }
      this.logger.warn({ jobId: job.id, err: error.message }, 'job failed');
    }
  }

  private scheduleNextPoll(delayMs?: number): void {
    if (this.shuttingDown) return;
    const wait =
      delayMs !== undefined
        ? delayMs
        : this.config.pollIntervalMs + (Math.random() * 2 - 1) * this.config.pollJitterMs;
    this.pollTimer = setTimeout(() => {
      void this.pollOnce()
        .catch((err) => this.logger.error({ err }, 'poll cycle error'))
        .finally(() => this.scheduleNextPoll());
    }, Math.max(0, wait));
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.beat().catch((err) => this.logger.error({ err }, 'heartbeat error'));
    }, this.config.heartbeatIntervalMs);
  }

  /** Refresh the worker heartbeat and extend locks on all in-flight jobs. */
  private async beat(): Promise<void> {
    const jobIds = [...this.inFlight.keys()];
    await heartbeatWorker(this.pool, this.workerId, jobIds.length);
    if (jobIds.length > 0) {
      await heartbeatJobs(this.pool, this.workerId, jobIds, this.config.lockDurationMs);
    }
  }

  /**
   * Graceful shutdown: stop claiming, let in-flight jobs finish (up to the timeout),
   * then stop heartbeating and mark the worker stopped. Jobs still running past the
   * timeout are abandoned and recovered by the reaper via lock expiry — never lost.
   */
  async stop(): Promise<StopOutcome> {
    if (this.shuttingDown) return 'drained';
    this.shuttingDown = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    await setWorkerStatus(this.pool, this.workerId, 'draining').catch(() => {});

    const outcome = await this.drain();

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await setWorkerStatus(this.pool, this.workerId, 'dead').catch(() => {});
    this.logger.info({ outcome, remaining: this.inFlight.size }, 'worker stopped');
    return outcome;
  }

  private async drain(): Promise<StopOutcome> {
    const drained = Promise.allSettled([...this.inFlight.values()]).then<StopOutcome>(() => 'drained');
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<StopOutcome>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.config.shutdownTimeoutMs);
    });
    const outcome = await Promise.race([drained, timedOut]);
    clearTimeout(timer!);
    if (outcome === 'timeout') {
      // Signal cooperative handlers to abort; leftovers will be reaped via lock expiry.
      this.abortController.abort();
      this.logger.warn({ remaining: this.inFlight.size }, 'drain timed out; leftovers will be reaped');
    }
    return outcome;
  }
}
