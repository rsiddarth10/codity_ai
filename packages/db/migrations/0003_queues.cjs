/* eslint-disable camelcase */

/**
 * Phase 1 — migration 3/8: queues.
 *
 *  - priority: queue-level priority used when a single worker polls multiple queues
 *    (higher = polled first). Within a queue, per-job priority orders the claim.
 *  - concurrency_limit: max jobs RUNNING at once for this queue, enforced across ALL
 *    workers (the enforcement query lives in the data-access layer, Phase 2).
 *  - retry_policy_id: default policy for jobs enqueued to this queue. Nullable with
 *    ON DELETE SET NULL — if a policy is removed, the app falls back to system defaults
 *    rather than failing enqueue. Per-job overrides are supported at enqueue time.
 *  - is_paused: paused queues are skipped by the claim query; already-running jobs
 *    finish normally.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('queues', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: {
      type: 'uuid',
      notNull: true,
      references: 'projects(id)',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    priority: { type: 'integer', notNull: true, default: 0 },
    concurrency_limit: {
      type: 'integer',
      notNull: true,
      default: 10,
      check: 'concurrency_limit >= 1',
    },
    retry_policy_id: {
      type: 'uuid',
      references: 'retry_policies(id)',
      onDelete: 'SET NULL',
    },
    is_paused: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('queues', 'queues_project_name_unique', {
    unique: ['project_id', 'name'],
  });
  pgm.createIndex('queues', 'project_id');
  pgm.sql(`
    CREATE TRIGGER trg_queues_updated_at BEFORE UPDATE ON queues
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('queues');
};
