import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '@codity/db';
import {
  createProject,
  getProject,
  updateProject,
  deleteProject,
  listProjects,
  countProjects,
  createRetryPolicy,
  listRetryPolicies,
  deleteRetryPolicy,
} from '@codity/core';
import { asyncHandler, paginationQuery, toPagination, paginated } from '../http.js';
import { validate, body, query, params } from '../validate.js';
import { authOf, requireRole } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { assertProject } from '../scoping.js';

const adminOnly = requireRole('owner', 'admin');
const projectIdParam = z.object({ projectId: z.string().uuid() });
const nameBody = z.object({ name: z.string().min(1).max(200) });
const retryPolicyBody = z.object({
  name: z.string().min(1).max(200),
  strategy: z.enum(['fixed', 'linear', 'exponential']),
  maxAttempts: z.number().int().min(1).max(100),
  baseDelayMs: z.number().int().min(0),
  maxDelayMs: z.number().int().min(0).nullish(),
  backoffMultiplier: z.number().min(1).optional(),
  jitter: z.boolean().optional(),
});
const policyIdParam = z.object({ projectId: z.string().uuid(), policyId: z.string().uuid() });

export function projectRoutes(pool: Pool): Router {
  const r = Router();

  r.get(
    '/projects',
    validate({ query: paginationQuery }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const q = query<typeof paginationQuery>(req);
      const p = toPagination(q);
      const [items, total] = await Promise.all([
        listProjects(pool, organizationId, p),
        countProjects(pool, organizationId),
      ]);
      res.json(paginated(items, total, q));
    }),
  );

  r.post(
    '/projects',
    adminOnly,
    validate({ body: nameBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { id } = await createProject(pool, organizationId, body<typeof nameBody>(req).name);
      res.status(201).json(await getProject(pool, id, organizationId));
    }),
  );

  r.get(
    '/projects/:projectId',
    validate({ params: projectIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { projectId } = params<typeof projectIdParam>(req);
      res.json(await assertProject(pool, projectId, organizationId));
    }),
  );

  r.patch(
    '/projects/:projectId',
    adminOnly,
    validate({ params: projectIdParam, body: nameBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { projectId } = params<typeof projectIdParam>(req);
      const updated = await updateProject(pool, projectId, organizationId, body<typeof nameBody>(req).name);
      if (!updated) throw notFound('Project not found');
      res.json(updated);
    }),
  );

  r.delete(
    '/projects/:projectId',
    adminOnly,
    validate({ params: projectIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { projectId } = params<typeof projectIdParam>(req);
      if (!(await deleteProject(pool, projectId, organizationId))) throw notFound('Project not found');
      res.status(204).end();
    }),
  );

  // ── Retry policies (nested under a project) ──
  r.get(
    '/projects/:projectId/retry-policies',
    validate({ params: projectIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { projectId } = params<typeof projectIdParam>(req);
      await assertProject(pool, projectId, organizationId);
      res.json({ data: await listRetryPolicies(pool, projectId) });
    }),
  );

  r.post(
    '/projects/:projectId/retry-policies',
    adminOnly,
    validate({ params: projectIdParam, body: retryPolicyBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { projectId } = params<typeof projectIdParam>(req);
      await assertProject(pool, projectId, organizationId);
      const b = body<typeof retryPolicyBody>(req);
      const created = await createRetryPolicy(pool, projectId, {
        name: b.name,
        strategy: b.strategy,
        maxAttempts: b.maxAttempts,
        baseDelayMs: b.baseDelayMs,
        maxDelayMs: b.maxDelayMs ?? null,
        backoffMultiplier: b.backoffMultiplier,
        jitter: b.jitter,
      });
      res.status(201).json({ id: created.id });
    }),
  );

  r.delete(
    '/projects/:projectId/retry-policies/:policyId',
    adminOnly,
    validate({ params: policyIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { projectId, policyId } = params<typeof policyIdParam>(req);
      await assertProject(pool, projectId, organizationId);
      if (!(await deleteRetryPolicy(pool, policyId, projectId))) throw notFound('Retry policy not found');
      res.status(204).end();
    }),
  );

  return r;
}
