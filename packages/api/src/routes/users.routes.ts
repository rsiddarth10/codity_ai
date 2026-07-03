import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '@codity/db';
import type { AppConfig } from '../context.js';
import { asyncHandler } from '../http.js';
import { validate, body } from '../validate.js';
import { authOf, requireRole } from '../middleware/auth.js';
import { hashPassword } from '../auth/passwords.js';
import { createOrgUser, listOrgUsers } from '../auth/repository.js';

const createBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  role: z.enum(['admin', 'member']), // cannot mint another owner
});

/**
 * Team management. Only owner/admin may list or invite users, and only into their OWN
 * organization — the org id comes from the caller's token, never the request body, so a
 * user can't be created in another tenant.
 */
export function userRoutes(pool: Pool, config: AppConfig): Router {
  const r = Router();

  r.get(
    '/users',
    requireRole('owner', 'admin'),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      res.json({ data: await listOrgUsers(pool, organizationId) });
    }),
  );

  r.post(
    '/users',
    requireRole('owner', 'admin'),
    validate({ body: createBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const b = body<typeof createBody>(req);
      const passwordHash = await hashPassword(b.password, config.bcryptRounds);
      const user = await createOrgUser(pool, organizationId, b.email, passwordHash, b.role);
      res.status(201).json({ id: user.id, email: user.email, role: user.role, organizationId: user.organization_id });
    }),
  );

  return r;
}
