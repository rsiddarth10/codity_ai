/* eslint-disable camelcase */

/**
 * Phase 1 — migration 2/8: projects and reusable retry policies.
 *
 * Ownership hierarchy: organization -> project -> queue. Deleting a project
 * cascades to everything it owns (queues, retry policies, and transitively jobs and
 * their history). We accept losing operational history on project delete because the
 * project is gone and nothing consumes orphaned rows; a production system wanting
 * retention would soft-delete projects instead. This trade-off is documented in
 * DESIGN.md.
 *
 * Retry policies are first-class and reusable across queues within a project, but the
 * *effective* policy is snapshotted onto each job at enqueue time (see jobs migration),
 * so editing a policy never retroactively changes in-flight jobs.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('projects', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    organization_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Project names are unique within an organization.
  pgm.addConstraint('projects', 'projects_org_name_unique', {
    unique: ['organization_id', 'name'],
  });
  pgm.createIndex('projects', 'organization_id');
  pgm.sql(`
    CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.createTable('retry_policies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: {
      type: 'uuid',
      notNull: true,
      references: 'projects(id)',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    strategy: {
      type: 'text',
      notNull: true,
      default: 'exponential',
      check: "strategy IN ('fixed', 'linear', 'exponential')",
    },
    max_attempts: {
      type: 'integer',
      notNull: true,
      default: 3,
      check: 'max_attempts >= 1',
    },
    // Base unit for the backoff formula (ms).
    base_delay_ms: {
      type: 'integer',
      notNull: true,
      default: 1000,
      check: 'base_delay_ms >= 0',
    },
    // Upper bound for computed delay (mainly for exponential). NULL = uncapped.
    max_delay_ms: { type: 'integer', check: 'max_delay_ms IS NULL OR max_delay_ms >= 0' },
    // Growth factor for exponential; also usable as linear step multiplier.
    backoff_multiplier: {
      type: 'numeric(6,2)',
      notNull: true,
      default: 2.0,
      check: 'backoff_multiplier >= 1',
    },
    // Adds randomization to spread retry storms.
    jitter: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('retry_policies', 'retry_policies_project_name_unique', {
    unique: ['project_id', 'name'],
  });
  pgm.createIndex('retry_policies', 'project_id');
  pgm.sql(`
    CREATE TRIGGER trg_retry_policies_updated_at BEFORE UPDATE ON retry_policies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('retry_policies');
  pgm.dropTable('projects');
};
