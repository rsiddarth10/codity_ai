/* eslint-disable camelcase */

/**
 * Phase 1 — migration 4/8: workers and their heartbeat history.
 *
 *  - workers.last_heartbeat is a DENORMALIZED "latest" value kept for the reaper's hot
 *    path: "find workers with status='active' and last_heartbeat < now() - timeout".
 *    A partial index on (status, last_heartbeat) makes that a cheap scan.
 *  - worker_heartbeats is the append-only history (one row per beat) for observability
 *    / the dashboard's worker view. It is intentionally separate so the high-write
 *    history table does not bloat the small, hot workers table.
 *
 * Workers are infrastructure, not tenant data — they are not scoped to an organization.
 * Which queues a worker polls is stored in metadata (informational); claiming is driven
 * by the queue ids the worker asks for at runtime.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('workers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "status IN ('active', 'draining', 'dead')",
    },
    concurrency: { type: 'integer', notNull: true, default: 1, check: 'concurrency >= 1' },
    // Informational: host, pid, polled queue ids, version, etc.
    metadata: { type: 'jsonb', notNull: true, default: '{}' },
    last_heartbeat: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    registered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Reaper hot path: only alive workers matter, so index them partially.
  pgm.createIndex('workers', ['status', 'last_heartbeat'], {
    name: 'idx_workers_liveness',
    where: "status = 'active'",
  });

  pgm.createTable('worker_heartbeats', {
    id: { type: 'bigserial', primaryKey: true },
    worker_id: {
      type: 'uuid',
      notNull: true,
      references: 'workers(id)',
      onDelete: 'CASCADE',
    },
    running_jobs: { type: 'integer', notNull: true, default: 0 },
    heartbeat_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('worker_heartbeats', [
    { name: 'worker_id' },
    { name: 'heartbeat_at', sort: 'DESC' },
  ]);
};

exports.down = (pgm) => {
  pgm.dropTable('worker_heartbeats');
  pgm.dropTable('workers');
};
