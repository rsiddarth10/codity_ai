/* eslint-disable camelcase */

/**
 * Phase 1 — migration 6/8: per-attempt executions, logs, and the transition audit.
 *
 *  - job_executions: ONE ROW PER ATTEMPT (never overwritten). This is the retry history:
 *    which worker ran it, when, how long, and the error if it failed. unique(job_id,
 *    attempt_number) guarantees exactly one row per attempt.
 *  - job_logs: append-only structured log lines emitted by the job handler, optionally
 *    tied to the specific execution attempt.
 *  - job_state_transitions: an explicit audit row for every status change, so the full
 *    lifecycle timeline is reconstructable ("who/what claimed it, when").
 *
 * All three cascade-delete with the job (and transitively with queue/project). They are
 * operational records with no consumer once the job is gone.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('job_executions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    job_id: {
      type: 'uuid',
      notNull: true,
      references: 'jobs(id)',
      onDelete: 'CASCADE',
    },
    attempt_number: { type: 'integer', notNull: true, check: 'attempt_number >= 1' },
    worker_id: {
      type: 'uuid',
      references: 'workers(id)',
      onDelete: 'SET NULL',
    },
    status: {
      type: 'text',
      notNull: true,
      default: 'running',
      check: "status IN ('running', 'succeeded', 'failed')",
    },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finished_at: { type: 'timestamptz' },
    duration_ms: { type: 'integer' },
    error_message: { type: 'text' },
    error_stack: { type: 'text' },
    result: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('job_executions', 'job_executions_attempt_unique', {
    unique: ['job_id', 'attempt_number'],
  });
  pgm.createIndex('job_executions', [{ name: 'job_id' }, { name: 'attempt_number', sort: 'DESC' }]);
  pgm.createIndex('job_executions', 'worker_id', { where: 'worker_id IS NOT NULL' });

  pgm.createTable('job_logs', {
    id: { type: 'bigserial', primaryKey: true },
    job_id: {
      type: 'uuid',
      notNull: true,
      references: 'jobs(id)',
      onDelete: 'CASCADE',
    },
    execution_id: {
      type: 'uuid',
      references: 'job_executions(id)',
      onDelete: 'CASCADE',
    },
    level: {
      type: 'text',
      notNull: true,
      default: 'info',
      check: "level IN ('debug', 'info', 'warn', 'error')",
    },
    message: { type: 'text', notNull: true },
    metadata: { type: 'jsonb' },
    logged_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('job_logs', [{ name: 'job_id' }, { name: 'logged_at' }]);

  pgm.createTable('job_state_transitions', {
    id: { type: 'bigserial', primaryKey: true },
    job_id: {
      type: 'uuid',
      notNull: true,
      references: 'jobs(id)',
      onDelete: 'CASCADE',
    },
    from_status: { type: 'text' },
    to_status: { type: 'text', notNull: true },
    worker_id: {
      type: 'uuid',
      references: 'workers(id)',
      onDelete: 'SET NULL',
    },
    reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('job_state_transitions', [{ name: 'job_id' }, { name: 'created_at' }]);
};

exports.down = (pgm) => {
  pgm.dropTable('job_state_transitions');
  pgm.dropTable('job_logs');
  pgm.dropTable('job_executions');
};
