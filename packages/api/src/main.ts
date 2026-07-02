import 'dotenv/config';
import { getPool, closePool } from '@codity/db';
import { loadEnv, createLogger, registerShutdown } from '@codity/shared';
import { buildApp } from './app.js';

/** Runnable API process entrypoint. */
const env = loadEnv();
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });
const pool = getPool();

const app = buildApp(
  pool,
  {
    jwtAccessSecret: env.JWT_ACCESS_SECRET,
    jwtRefreshSecret: env.JWT_REFRESH_SECRET,
    jwtAccessTtlSec: env.JWT_ACCESS_TTL,
    jwtRefreshTtlSec: env.JWT_REFRESH_TTL,
    bcryptRounds: env.BCRYPT_ROUNDS,
  },
  logger,
);

const server = app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT }, 'api listening');
});

registerShutdown(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
}, logger);
