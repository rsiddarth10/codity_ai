/* eslint-disable camelcase */

/**
 * Phase 1 — migration 7/8: recurring/cron schedules.
 *
 * scheduled_jobs are DEFINITIONS (a cron expression + a template payload). The scheduler
 * process finds active definitions whose next_run_at <= now(), enqueues a concrete job
 * instance (jobs.scheduled_job_id points back here), and advances next_run_at using a
 * real cron parser. One-shot delayed/scheduled jobs do NOT live here — they are just a
 * job row with a future run_at.
 *
 * We also add the deferred FK jobs.scheduled_job_id -> scheduled_jobs now that the table
 * exists (ON DELETE SET NULL: deleting a schedule keeps already-generated jobs).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('scheduled_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'queues(id)',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    cron_expression: { type: 'text', notNull: true },
    timezone: { type: 'text', notNull: true, default: 'UTC' },
    payload: { type: 'jsonb', notNull: true, default: '{}' },
    priority: { type: 'integer', notNull: true, default: 0 },
    retry_policy_id: {
      type: 'uuid',
      references: 'retry_policies(id)',
      onDelete: 'SET NULL',
    },
    is_active: { type: 'boolean', notNull: true, default: true },
    last_run_at: { type: 'timestamptz' },
    next_run_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('scheduled_jobs', 'scheduled_jobs_queue_name_unique', {
    unique: ['queue_id', 'name'],
  });
  // Scheduler hot path: active schedules that are due.
  pgm.createIndex('scheduled_jobs', 'next_run_at', {
    name: 'idx_scheduled_jobs_due',
    where: 'is_active = true',
  });
  pgm.sql(`
    CREATE TRIGGER trg_scheduled_jobs_updated_at BEFORE UPDATE ON scheduled_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Deferred FK from jobs (column created in migration 0005).
  pgm.addConstraint('jobs', 'jobs_scheduled_job_id_fkey', {
    foreignKeys: {
      columns: 'scheduled_job_id',
      references: 'scheduled_jobs(id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.createIndex('jobs', 'scheduled_job_id', {
    name: 'idx_jobs_scheduled_job_id',
    where: 'scheduled_job_id IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('jobs', 'jobs_scheduled_job_id_fkey');
  pgm.dropIndex('jobs', 'scheduled_job_id', { name: 'idx_jobs_scheduled_job_id', ifExists: true });
  pgm.dropTable('scheduled_jobs');
};
