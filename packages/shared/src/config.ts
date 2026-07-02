import { z } from 'zod';

/**
 * Centralized, validated environment config. Every process parses the same schema and
 * reads the fields it needs; invalid/missing values fail fast at startup with a clear
 * error rather than surfacing as a mysterious runtime bug.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ── API ──
  API_PORT: z.coerce.number().int().positive().default(4000),
  JWT_ACCESS_SECRET: z.string().min(1).default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(1).default('dev-refresh-secret-change-me'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1_209_600),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  // ── Worker ──
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_POLL_JITTER_MS: z.coerce.number().int().min(0).default(250),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  JOB_LOCK_DURATION_MS: z.coerce.number().int().positive().default(30_000),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  /** Comma-separated queue ids to poll; empty = discover & poll all queues. */
  WORKER_QUEUES: z.string().optional(),
  WORKER_NAME: z.string().optional(),

  // ── Scheduler / Reaper ──
  SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  REAPER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_DEAD_AFTER_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parse & validate the environment (defaults applied). Throws on invalid config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}

/** Parse a comma-separated list into a trimmed, non-empty string array. */
export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
