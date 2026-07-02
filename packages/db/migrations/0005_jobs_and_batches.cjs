/* eslint-disable camelcase */

/**
 * Phase 1 — migration 5/8: job batches and the core jobs table.
 *
 * This is the heart of the system. Key modeling decisions:
 *
 *  Status state machine (TEXT + CHECK):
 *    queued -> claimed -> running -> completed
 *    running -> failed -> queued (retry, run_at pushed into the future)
 *    failed -> dead_letter (max attempts exhausted)
 *    scheduled -> queued (a delayed/one-shot future job becomes eligible)
 *    any -> cancelled (manual)
 *
 *  Eligibility gating: the claim query selects status='queued' AND run_at <= now().
 *    - Immediate jobs: status='queued', run_at=now().
 *    - Delayed / one-shot scheduled jobs: status='scheduled', run_at in the future;
 *      the scheduler promotes them to 'queued' when due (explicit state, clean claim).
 *
 *  Retry snapshot: max_attempts + retry_config are SNAPSHOTTED onto the job at enqueue
 *    from the effective policy (job override > queue policy > system default). Editing a
 *    policy afterwards never changes in-flight jobs — retries are deterministic.
 *
 *  Lock / visibility timeout: lock_expires_at is set when a job is claimed and extended
 *    by worker heartbeats. The reaper requeues any claimed/running job whose lock has
 *    expired — this recovers jobs from hard-crashed workers without needing to first
 *    detect the worker is dead.
 *
 *  Idempotency: (queue_id, idempotency_key) is unique among non-null keys, so a repeated
 *    submission with the same key returns the existing job instead of enqueuing a
 *    duplicate. "Idempotent" here = at-most-once *enqueue* per key; see DESIGN.md.
 */

exports.shorthands = undefined;

const JOB_STATUSES = [
  'scheduled',
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'dead_letter',
  'cancelled',
];

exports.up = (pgm) => {
  pgm.createTable('job_batches', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: {
      type: 'uuid',
      notNull: true,
      references: 'projects(id)',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    total_jobs: { type: 'integer', notNull: true, default: 0, check: 'total_jobs >= 0' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('job_batches', 'project_id');

  pgm.createTable('jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    queue_id: {
      type: 'uuid',
      notNull: true,
      references: 'queues(id)',
      onDelete: 'CASCADE',
    },
    // Batch membership is optional; if a batch is deleted, jobs survive (SET NULL).
    batch_id: {
      type: 'uuid',
      references: 'job_batches(id)',
      onDelete: 'SET NULL',
    },
    // FK to scheduled_jobs is added in migration 0007 (table created there).
    scheduled_job_id: { type: 'uuid' },
    status: {
      type: 'text',
      notNull: true,
      default: 'queued',
      check: `status IN (${JOB_STATUSES.map((s) => `'${s}'`).join(', ')})`,
    },
    priority: { type: 'integer', notNull: true, default: 0 },
    payload: { type: 'jsonb', notNull: true, default: '{}' },
    idempotency_key: { type: 'text' },
    attempts: { type: 'integer', notNull: true, default: 0, check: 'attempts >= 0' },
    max_attempts: { type: 'integer', notNull: true, default: 3, check: 'max_attempts >= 1' },
    // Snapshotted effective retry policy: { strategy, base_delay_ms, max_delay_ms, multiplier, jitter }.
    retry_config: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(
        `'{"strategy":"exponential","base_delay_ms":1000,"max_delay_ms":60000,"multiplier":2,"jitter":true}'::jsonb`,
      ),
    },
    // Provenance only; effective values live in retry_config/max_attempts.
    retry_policy_id: {
      type: 'uuid',
      references: 'retry_policies(id)',
      onDelete: 'SET NULL',
    },
    run_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    claimed_by: {
      type: 'uuid',
      references: 'workers(id)',
      onDelete: 'SET NULL',
    },
    claimed_at: { type: 'timestamptz' },
    started_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    lock_expires_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    result: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // --- Indexes on the hot paths ---

  // 1) THE CLAIM INDEX. Matches the claim query exactly:
  //    WHERE queue_id=$1 AND status='queued' AND run_at<=now()
  //    ORDER BY priority DESC, run_at ASC, created_at ASC
  //    Partial on status='queued' keeps it small and cache-hot.
  pgm.createIndex(
    'jobs',
    [
      { name: 'queue_id' },
      { name: 'priority', sort: 'DESC' },
      { name: 'run_at', sort: 'ASC' },
      { name: 'created_at', sort: 'ASC' },
    ],
    { name: 'idx_jobs_claim', where: "status = 'queued'" },
  );

  // 2) REAPER INDEX: find claimed/running jobs whose lock has expired.
  pgm.createIndex('jobs', 'lock_expires_at', {
    name: 'idx_jobs_reaper',
    where: "status IN ('claimed', 'running')",
  });

  // 3) SCHEDULER PROMOTION: find scheduled jobs that are now due.
  pgm.createIndex('jobs', 'run_at', {
    name: 'idx_jobs_scheduled_due',
    where: "status = 'scheduled'",
  });

  // 4) IDEMPOTENCY: at most one live job per (queue, key).
  pgm.createIndex('jobs', ['queue_id', 'idempotency_key'], {
    name: 'idx_jobs_idempotency',
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  });

  // 5) DASHBOARD list/filter/paginate by queue + status, newest first.
  pgm.createIndex('jobs', [{ name: 'queue_id' }, { name: 'status' }, { name: 'created_at', sort: 'DESC' }], {
    name: 'idx_jobs_queue_status_created',
  });

  // 6) BATCH rollups.
  pgm.createIndex('jobs', 'batch_id', {
    name: 'idx_jobs_batch',
    where: 'batch_id IS NOT NULL',
  });

  pgm.sql(`
    CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('jobs');
  pgm.dropTable('job_batches');
};
