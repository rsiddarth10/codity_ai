/* eslint-disable camelcase */

/**
 * Phase 1 — migration 8/8: the Dead Letter Queue.
 *
 * When a job exhausts its attempts, its status becomes 'dead_letter' AND a row is
 * written here. Keeping a dedicated DLQ table (rather than only a status) gives us:
 *   - a clean, cheap-to-query "what died and why" surface for the dashboard,
 *   - a snapshot of the payload/error at death time, decoupled from later job mutation,
 *   - an obvious target for the manual "retry from DLQ" action.
 *
 * unique(job_id) — a job can be dead-lettered at most once. Requeuing from the DLQ
 * deletes the row and returns the job to 'queued'.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('dead_letter_queue', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    job_id: {
      type: 'uuid',
      notNull: true,
      references: 'jobs(id)',
      onDelete: 'CASCADE',
    },
    queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'queues(id)',
      onDelete: 'CASCADE',
    },
    reason: { type: 'text', notNull: true },
    attempts_made: { type: 'integer', notNull: true },
    last_error: { type: 'text' },
    payload: { type: 'jsonb', notNull: true, default: '{}' },
    moved_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('dead_letter_queue', 'dead_letter_queue_job_unique', { unique: ['job_id'] });
  // Dashboard: DLQ contents per queue, newest first; also drives "DLQ size over time".
  pgm.createIndex('dead_letter_queue', [{ name: 'queue_id' }, { name: 'moved_at', sort: 'DESC' }]);
};

exports.down = (pgm) => {
  pgm.dropTable('dead_letter_queue');
};
