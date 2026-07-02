import type { Logger } from 'pino';

export type ShutdownHandler = (signal: string) => Promise<void>;

/**
 * Register a single graceful-shutdown handler for SIGTERM/SIGINT. Ensures the handler
 * runs at most once even if multiple signals arrive, and exits the process afterwards.
 * Returns a function to unregister (used by tests to avoid leaking listeners).
 */
export function registerShutdown(handler: ShutdownHandler, logger?: Logger): () => void {
  let invoked = false;

  const run = (signal: string): void => {
    if (invoked) return;
    invoked = true;
    logger?.info({ signal }, 'shutdown signal received; draining');
    handler(signal)
      .then(() => {
        logger?.info('shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        logger?.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };

  const onTerm = (): void => run('SIGTERM');
  const onInt = (): void => run('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  return () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
}
