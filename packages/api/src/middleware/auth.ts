import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { unauthorized, forbidden } from '../errors.js';
import { verifyAccessToken } from '../auth/jwt.js';

/**
 * Require a valid Bearer access token. Populates req.auth with the principal. Every route
 * mounted after this enforces authentication; per-resource tenant checks (does this
 * project/queue/job belong to req.auth.organizationId?) happen in the handlers via the
 * scoping helpers.
 */
export function requireAuth(accessSecret: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return next(unauthorized('Missing Bearer token'));
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const claims = verifyAccessToken(token, accessSecret);
      req.auth = { userId: claims.sub, organizationId: claims.org, role: claims.role };
      next();
    } catch {
      next(unauthorized('Invalid or expired token'));
    }
  };
}

/** Read the authenticated principal (throws if the route wasn't behind requireAuth). */
export function authOf(req: Request): { userId: string; organizationId: string; role: string } {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/**
 * RBAC guard: allow only the given roles. Members can operate on jobs (enqueue / retry /
 * cancel / read); configuration mutations (projects, queues, retry policies, schedules,
 * inviting users) require owner/admin. Mount after requireAuth.
 */
export function requireRole(...roles: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(forbidden(`This action requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

