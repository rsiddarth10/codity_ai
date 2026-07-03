import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '@codity/db';
import {
  createQueue,
  getQueue,
  setQueuePaused,
  listQueues,
  updateQueue,
  deleteQueue,
  getQueueStats,
  getQueueThroughput,
} from '@codity/core';
import { asyncHandler } from '../http.js';
import { validate, body, params } from '../validate.js';
import { authOf } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { assertProject, assertQueue } from '../scoping.js';

const projectIdParam = z.object({ projectId: z.string().uuid() });
const queueIdParam = z.object({ queueId: z.string().uuid() });
const createBody = z.object({
  name: z.string().min(1).max(200),
  priority: z.number().int().optional(),
  concurrencyLimit: z.number().int().min(1).optional(),
  retryPolicyId: z.string().uuid().nullish(),
});
const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  priority: z.number().int().optional(),
  concurrencyLimit: z.number().int().min(1).optional(),
  retryPolicyId: z.string().uuid().nullish(),
  isPaused: z.boolean().optional(),
});

export function queueRoutes(pool: Pool): Router {
  const r = Router();

  r.get(
    '/projects/:projectId/queues',
    validate({ params: projectIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { projectId } = params<typeof projectIdParam>(req);
      await assertProject(pool, projectId, organizationId);
      res.json({ data: await listQueues(pool, projectId) });
    }),
  );

  r.post(
    '/projects/:projectId/queues',
    validate({ params: projectIdParam, body: createBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { projectId } = params<typeof projectIdParam>(req);
      await assertProject(pool, projectId, organizationId);
      const b = body<typeof createBody>(req);
      const queue = await createQueue(pool, projectId, {
        name: b.name,
        priority: b.priority,
        concurrencyLimit: b.concurrencyLimit,
        retryPolicyId: b.retryPolicyId ?? null,
      });
      res.status(201).json(queue);
    }),
  );

  r.get(
    '/queues/:queueId',
    validate({ params: queueIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      res.json(await getQueue(pool, queueId));
    }),
  );

  r.patch(
    '/queues/:queueId',
    validate({ params: queueIdParam, body: patchBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      const updated = await updateQueue(pool, queueId, body<typeof patchBody>(req));
      res.json(updated);
    }),
  );

  const setPaused = (paused: boolean) =>
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      await setQueuePaused(pool, queueId, paused);
      res.json(await getQueue(pool, queueId));
    });

  r.post('/queues/:queueId/pause', validate({ params: queueIdParam }), setPaused(true));
  r.post('/queues/:queueId/resume', validate({ params: queueIdParam }), setPaused(false));

  r.delete(
    '/queues/:queueId',
    validate({ params: queueIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      if (!(await deleteQueue(pool, queueId))) throw notFound('Queue not found');
      res.status(204).end();
    }),
  );

  r.get(
    '/queues/:queueId/stats',
    validate({ params: queueIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      res.json(await getQueueStats(pool, queueId));
    }),
  );

  const throughputQuery = z.object({ minutes: z.coerce.number().int().min(1).max(1440).default(60) });
  r.get(
    '/queues/:queueId/throughput',
    validate({ params: queueIdParam, query: throughputQuery }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      const { minutes } = req.validated.query as { minutes: number };
      res.json({ data: await getQueueThroughput(pool, queueId, minutes) });
    }),
  );

  return r;
}
