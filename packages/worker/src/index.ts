import os from 'node:os';
import { getPool, closePool } from '@codity/db';
import { loadEnv, parseList, createLogger, registerShutdown } from '@codity/shared';
import { WorkerEngine } from './engine.js';
import { defaultHandlers, HandlerRegistry } from './handlers.js';

export { WorkerEngine, type WorkerEngineConfig, type StopOutcome } from './engine.js';
export { HandlerRegistry, defaultHandlers, type JobHandler, type JobContext } from './handlers.js';

/**
 * Build a worker engine from environment config and start it, wiring graceful shutdown.
 * Kept as an exported function (no top-level side effects) so importing this package is
 * safe; `main.ts` is the actual runnable entrypoint.
 */
export async function runWorkerFromEnv(handlers: HandlerRegistry = defaultHandlers()): Promise<WorkerEngine> {
  const env = loadEnv();
  const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });
  const pool = getPool();

  const engine = new WorkerEngine(
    pool,
    {
      queueIds: parseList(env.WORKER_QUEUES),
      concurrency: env.WORKER_CONCURRENCY,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      pollJitterMs: env.WORKER_POLL_JITTER_MS,
      heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
      lockDurationMs: env.JOB_LOCK_DURATION_MS,
      shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
      workerName: env.WORKER_NAME ?? `worker@${os.hostname()}:${process.pid}`,
    },
    handlers,
    logger,
  );

  registerShutdown(async () => {
    await engine.stop();
    await closePool();
  }, logger);

  await engine.start();
  return engine;
}
