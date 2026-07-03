import { getPool, closePool } from '@codity/db';
import { loadEnv, createLogger, registerShutdown } from '@codity/shared';
import { SchedulerLoop } from './loop.js';

export { SchedulerLoop, type SchedulerLoopConfig } from './loop.js';

/**
 * Build and start the scheduler process from env. Runs the singleton scheduler loop
 * (reaper + retry/delayed/cron promotion).
 */
export async function runSchedulerFromEnv(): Promise<{ loop: SchedulerLoop }> {
  const env = loadEnv();
  const logger = createLogger({ name: 'scheduler', level: env.LOG_LEVEL });
  const pool = getPool();

  const loop = new SchedulerLoop(
    pool,
    { intervalMs: env.SCHEDULER_POLL_INTERVAL_MS, deadAfterMs: env.WORKER_DEAD_AFTER_MS },
    logger,
  );

  registerShutdown(async () => {
    loop.stop();
    await closePool();
  }, logger);

  loop.start();
  return { loop };
}
