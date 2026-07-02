import bcrypt from 'bcryptjs';

/**
 * bcryptjs (pure-JS) so tests and local dev need no native toolchain. Salt is generated
 * and embedded by bcrypt; `rounds` is the cost factor.
 */
export function hashPassword(plain: string, rounds: number): Promise<string> {
  return bcrypt.hash(plain, rounds);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
