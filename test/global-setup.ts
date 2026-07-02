import 'dotenv/config';
import pg from 'pg';
import runner from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Vitest global setup (runs once): provision an isolated test database and migrate it to
 * head, so the suite never touches the dev database. Reads TEST_DATABASE_URL (the target)
 * and DATABASE_URL (an admin connection used only to CREATE DATABASE).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'packages', 'db', 'migrations');

const quietLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith("Can't determine timestamp")) return;
    console.error(...args);
  },
};

export async function setup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;
  const adminUrl = process.env.DATABASE_URL;
  if (!testUrl || !adminUrl) {
    throw new Error('TEST_DATABASE_URL and DATABASE_URL must be set (copy .env.example to .env).');
  }

  const testDbName = new URL(testUrl).pathname.replace(/^\//, '');

  // Create the test database if it does not exist (CREATE DATABASE can't be parameterized
  // or run in a transaction, hence the identifier check + literal).
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [testDbName]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${testDbName}"`);
    }
  } finally {
    await admin.end();
  }

  await runner({
    databaseUrl: testUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    count: Infinity,
    migrationsTable: 'pgmigrations',
    singleTransaction: true,
    logger: quietLogger,
  });
}
