import jwt from 'jsonwebtoken';

export interface AccessClaims {
  sub: string; // user id
  org: string; // organization id
  role: string;
}

/** Sign a short-lived access JWT. */
export function signAccessToken(claims: AccessClaims, secret: string, ttlSec: number): string {
  return jwt.sign({ org: claims.org, role: claims.role }, secret, {
    subject: claims.sub,
    expiresIn: ttlSec,
  });
}

/** Verify & decode an access JWT. Throws if invalid/expired. */
export function verifyAccessToken(token: string, secret: string): AccessClaims {
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
  return {
    sub: String(decoded.sub),
    org: String(decoded.org),
    role: String(decoded.role),
  };
}
