import { Router } from 'express';
import type { Pool } from '@codity/db';
import { listWorkers } from '@codity/core';
import { asyncHandler } from '../http.js';

/**
 * Workers are infrastructure (not tenant-scoped), so any authenticated user can view the
 * fleet. In a hardened multi-tenant deployment you'd scope workers per organization.
 */
export function workerRoutes(pool: Pool): Router {
  const r = Router();
  r.get(
    '/workers',
    asyncHandler(async (_req, res) => {
      res.json({ data: await listWorkers(pool) });
    }),
  );
  return r;
}
