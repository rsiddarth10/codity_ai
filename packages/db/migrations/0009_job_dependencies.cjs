/* eslint-disable camelcase */

/**
 * Phase 8 — migration 9: workflow dependencies (job B waits on job A).
 *
 *  - New status 'blocked': a job with unmet dependencies is enqueued 'blocked' and is
 *    therefore invisible to the claim query (which only takes 'queued'). This keeps the
 *    hot claim path and its partial index UNCHANGED — no correlated subquery on the
 *    crown-jewel query. The scheduler promotes 'blocked' -> 'queued' once all parents have
 *    completed (or cancels it if a parent dead-letters/cancels).
 *  - job_dependencies is the edge list (dependent -> parent). The PK prevents duplicate
 *    edges; both sides cascade with their job.
 *
 * Cycle safety by construction: a job may only depend on jobs that already exist at
 * enqueue time, and an older job cannot reference a not-yet-created newer job — so the
 * dependency graph is always a DAG.
 */

exports.shorthands = undefined;

const STATUSES_WITH_BLOCKED = [
  'scheduled', 'queued', 'claimed', 'running', 'completed', 'failed', 'dead_letter', 'cancelled', 'blocked',
];
const STATUSES_ORIGINAL = [
  'scheduled', 'queued', 'claimed', 'running', 'completed', 'failed', 'dead_letter', 'cancelled',
];

exports.up = (pgm) => {
  pgm.sql('ALTER TABLE jobs DROP CONSTRAINT jobs_status_check');
  pgm.sql(
    `ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (${STATUSES_WITH_BLOCKED.map((s) => `'${s}'`).join(', ')}))`,
  );

  pgm.createTable('job_dependencies', {
    job_id: {
      type: 'uuid',
      notNull: true,
      references: 'jobs(id)',
      onDelete: 'CASCADE',
    },
    depends_on_job_id: {
      type: 'uuid',
      notNull: true,
      references: 'jobs(id)',
      onDelete: 'CASCADE',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('job_dependencies', 'job_dependencies_pkey', {
    primaryKey: ['job_id', 'depends_on_job_id'],
  });
  // Find dependents of a parent quickly when it completes.
  pgm.createIndex('job_dependencies', 'depends_on_job_id');
  // A job cannot depend on itself.
  pgm.addConstraint('job_dependencies', 'job_dependencies_no_self', {
    check: 'job_id <> depends_on_job_id',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('job_dependencies');
  pgm.sql('ALTER TABLE jobs DROP CONSTRAINT jobs_status_check');
  pgm.sql(
    `ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (${STATUSES_ORIGINAL.map((s) => `'${s}'`).join(', ')}))`,
  );
};
