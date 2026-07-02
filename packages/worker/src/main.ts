import 'dotenv/config';
import { runWorkerFromEnv } from './index.js';

/** Runnable worker process entrypoint (docker/`npm start`). */
runWorkerFromEnv().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('worker failed to start', err);
  process.exit(1);
});
