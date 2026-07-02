/* eslint-disable camelcase */

/**
 * Phase 1 — migration 1/8: extensions, identity, and the shared updated_at trigger.
 *
 * Design notes:
 *  - We use TEXT + CHECK constraints for enum-like columns (role, statuses) rather
 *    than native PG ENUM types. Adding a value to a CHECK is a cheap, transactional
 *    ALTER; adding to an ENUM (ALTER TYPE ... ADD VALUE) cannot run inside a
 *    transaction and is harder to reverse. This keeps migrations reversible.
 *  - citext gives case-insensitive, unique emails without lower() index gymnastics.
 *  - gen_random_uuid() comes from pgcrypto (built-in on PG13+, enabled explicitly).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
  pgm.createExtension('citext', { ifNotExists: true });

  // One trigger function, reused by every table that has updated_at.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.createTable('organizations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // A user belongs to exactly one organization. Deleting an org removes its users.
    organization_id: {
      type: 'uuid',
      notNull: true,
      references: 'organizations(id)',
      onDelete: 'CASCADE',
    },
    email: { type: 'citext', notNull: true },
    password_hash: { type: 'text', notNull: true },
    role: {
      type: 'text',
      notNull: true,
      default: 'member',
      check: "role IN ('owner', 'admin', 'member')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Email is globally unique (login identifier).
  pgm.addConstraint('users', 'users_email_unique', { unique: ['email'] });
  pgm.createIndex('users', 'organization_id');
  pgm.sql(`
    CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Refresh tokens: we store only a SHA-256 hash of the opaque token, never the raw
  // value, so a DB leak cannot be replayed. Rotation revokes the old row.
  pgm.createTable('refresh_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('refresh_tokens', 'refresh_tokens_hash_unique', { unique: ['token_hash'] });
  pgm.createIndex('refresh_tokens', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens');
  pgm.dropTable('users');
  pgm.dropTable('organizations');
  pgm.sql('DROP FUNCTION IF EXISTS set_updated_at();');
  // Extensions are left in place; other schemas may rely on them.
};
