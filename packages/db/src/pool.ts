import pg from 'pg';

const { Pool } = pg;

// Postgres BIGINT (int8) arrives as a string via node-postgres to avoid precision
// loss. Our bigserial ids (job_logs, worker_heartbeats) fit safely in a JS number,
// and the app treats them as numbers, so parse int8 -> number globally.
pg.types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

let defaultPool: pg.Pool | undefined;

export interface CreatePoolOptions {
  connectionString?: string;
  max?: number;
}

export function createPool(options: CreatePoolOptions = {}): pg.Pool {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (and no connectionString provided).');
  }
  return new Pool({
    connectionString,
    max: options.max ?? 10,
    // Fail fast rather than hanging forever if Postgres is unreachable.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}

/** Process-wide singleton pool, created lazily from DATABASE_URL. */
export function getPool(): pg.Pool {
  if (!defaultPool) {
    defaultPool = createPool();
  }
  return defaultPool;
}

export async function closePool(): Promise<void> {
  if (defaultPool) {
    await defaultPool.end();
    defaultPool = undefined;
  }
}
