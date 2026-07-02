import 'dotenv/config';
import { runSchedulerFromEnv } from './index.js';

/** Runnable scheduler process entrypoint (docker/`npm start`). */
runSchedulerFromEnv().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('scheduler failed to start', err);
  process.exit(1);
});
