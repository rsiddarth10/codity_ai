import { getPool, closePool } from '@codity/db';
import { loadEnv, createLogger, registerShutdown } from '@codity/shared';
import { Reaper } from './reaper.js';

export { Reaper, type ReaperConfig } from './reaper.js';

/**
 * Build and start the scheduler process from env. Today it runs the reaper; Phase 6 adds
 * the cron promoter (scheduled_jobs -> jobs) to this same process.
 */
export async function runSchedulerFromEnv(): Promise<{ reaper: Reaper }> {
  const env = loadEnv();
  const logger = createLogger({ name: 'scheduler', level: env.LOG_LEVEL });
  const pool = getPool();

  const reaper = new Reaper(
    pool,
    { intervalMs: env.REAPER_POLL_INTERVAL_MS, deadAfterMs: env.WORKER_DEAD_AFTER_MS },
    logger,
  );

  registerShutdown(async () => {
    reaper.stop();
    await closePool();
  }, logger);

  reaper.start();
  return { reaper };
}
