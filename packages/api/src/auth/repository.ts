import type { Pool } from '@codity/db';
import { withTransaction } from '@codity/core';

export interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: Date;
  updated_at: Date;
}

/** Create an organization and its owner user atomically (signup). */
export async function createUserWithOrg(
  pool: Pool,
  input: { email: string; passwordHash: string; organizationName: string },
): Promise<UserRow> {
  return withTransaction(pool, async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      [input.organizationName],
    );
    const user = await client.query<UserRow>(
      `INSERT INTO users (organization_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'owner')
       RETURNING *`,
      [org.rows[0]!.id, input.email, input.passwordHash],
    );
    return user.rows[0]!;
  });
}

export async function findUserByEmail(pool: Pool, email: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0] ?? null;
}

export async function getUserById(pool: Pool, id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertRefreshToken(
  pool: Pool,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/** A refresh token row that is neither revoked nor expired, or null. */
export async function findValidRefreshToken(pool: Pool, tokenHash: string): Promise<RefreshTokenRow | null> {
  const { rows } = await pool.query<RefreshTokenRow>(
    `SELECT * FROM refresh_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function revokeRefreshToken(pool: Pool, tokenHash: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
}
