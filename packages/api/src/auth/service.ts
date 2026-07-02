import { randomBytes, createHash } from 'node:crypto';
import type { Pool } from '@codity/db';
import type { AppConfig } from '../context.js';
import { unauthorized } from '../errors.js';
import { signAccessToken } from './jwt.js';
import { hashPassword, verifyPassword } from './passwords.js';
import {
  createUserWithOrg,
  findUserByEmail,
  getUserById,
  insertRefreshToken,
  findValidRefreshToken,
  revokeRefreshToken,
  type UserRow,
} from './repository.js';

export interface PublicUser {
  id: string;
  email: string;
  role: string;
  organizationId: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

const toPublicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  role: u.role,
  organizationId: u.organization_id,
});

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Issue a new access JWT + a fresh opaque refresh token (stored hashed). */
async function issueTokens(pool: Pool, config: AppConfig, user: UserRow): Promise<AuthTokens> {
  const accessToken = signAccessToken(
    { sub: user.id, org: user.organization_id, role: user.role },
    config.jwtAccessSecret,
    config.jwtAccessTtlSec,
  );
  // Opaque, high-entropy refresh token; only its hash is persisted.
  const refreshToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.jwtRefreshTtlSec * 1000);
  await insertRefreshToken(pool, user.id, sha256(refreshToken), expiresAt);
  return { accessToken, refreshToken, user: toPublicUser(user) };
}

export async function signup(
  pool: Pool,
  config: AppConfig,
  input: { email: string; password: string; organizationName: string },
): Promise<AuthTokens> {
  const passwordHash = await hashPassword(input.password, config.bcryptRounds);
  const user = await createUserWithOrg(pool, {
    email: input.email,
    passwordHash,
    organizationName: input.organizationName,
  });
  return issueTokens(pool, config, user);
}

export async function login(
  pool: Pool,
  config: AppConfig,
  input: { email: string; password: string },
): Promise<AuthTokens> {
  const user = await findUserByEmail(pool, input.email);
  // Same error whether the user is missing or the password is wrong (no user enumeration).
  if (!user || !(await verifyPassword(input.password, user.password_hash))) {
    throw unauthorized('Invalid email or password');
  }
  return issueTokens(pool, config, user);
}

/** Rotate: verify the presented refresh token, revoke it, and issue a new pair. */
export async function refresh(pool: Pool, config: AppConfig, refreshToken: string): Promise<AuthTokens> {
  const hash = sha256(refreshToken);
  const row = await findValidRefreshToken(pool, hash);
  if (!row) throw unauthorized('Invalid or expired refresh token');

  await revokeRefreshToken(pool, hash);
  const user = await getUserById(pool, row.user_id);
  if (!user) throw unauthorized('User no longer exists');
  return issueTokens(pool, config, user);
}

export async function logout(pool: Pool, refreshToken: string): Promise<void> {
  await revokeRefreshToken(pool, sha256(refreshToken));
}
