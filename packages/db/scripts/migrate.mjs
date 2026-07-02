#!/usr/bin/env node
/**
 * Cross-platform migration runner for node-pg-migrate.
 *
 * Loads .env, then drives the programmatic runner so behaviour is identical on
 * Windows / macOS / Linux and inside Docker (no reliance on shell PATH or the CLI
 * shim). Usage:
 *   node packages/db/scripts/migrate.mjs up            # apply all pending
 *   node packages/db/scripts/migrate.mjs down [count]  # roll back N (default 1)
 *   node packages/db/scripts/migrate.mjs redo          # down 1 then up 1
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import runner from 'node-pg-migrate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const [, , rawDirection = 'up', rawCount] = process.argv;

/**
 * We name migrations with zero-padded sequence prefixes (0001..0008) for readability
 * instead of node-pg-migrate's default 13-digit epoch-ms prefixes. The library still
 * orders them correctly (it falls back to `Number(prefix)` -> 1..8), but it emits a
 * benign `Can't determine timestamp for NNNN` on stderr for each file. This logger
 * proxies console and drops ONLY that known false-positive line; everything else
 * (the SQL echo, "No migrations to run!", real errors) passes through untouched.
 */
const migrateLogger = {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
  error: (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith("Can't determine timestamp")) {
      return;
    }
    console.error(...args);
  },
};

/** Shared options for every invocation. */
function baseOptions(direction, count) {
  return {
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count,
    migrationsTable: 'pgmigrations',
    // Each migration runs in its own transaction; a failure rolls that migration back.
    singleTransaction: true,
    // Refuse to run if migrations are out of order relative to what's recorded.
    checkOrder: true,
    verbose: true,
    logger: migrateLogger,
  };
}

async function main() {
  switch (rawDirection) {
    case 'up': {
      await runner(baseOptions('up', Infinity));
      break;
    }
    case 'down': {
      const count = rawCount ? Number.parseInt(rawCount, 10) : 1;
      await runner(baseOptions('down', count));
      break;
    }
    case 'redo': {
      await runner(baseOptions('down', 1));
      await runner(baseOptions('up', 1));
      break;
    }
    default:
      console.error(`Unknown command "${rawDirection}". Use: up | down [count] | redo`);
      process.exit(1);
  }
}

main()
  .then(() => {
    console.log('Migration command completed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
