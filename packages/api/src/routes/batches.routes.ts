import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '@codity/db';
import { enqueueBatch, getQueue, getBatchStatus, batchOrganizationId } from '@codity/core';
import { asyncHandler } from '../http.js';
import { validate, body, params } from '../validate.js';
import { authOf } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { assertQueue } from '../scoping.js';

const queueIdParam = z.object({ queueId: z.string().uuid() });
const batchIdParam = z.object({ batchId: z.string().uuid() });

const jobItem = z.object({
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
  idempotencyKey: z.string().min(1).max(255).nullish(),
  runAt: z.string().datetime().optional(),
});
const createBody = z.object({
  name: z.string().min(1).max(200),
  jobs: z.array(jobItem).min(1).max(1000),
});

export function batchRoutes(pool: Pool): Router {
  const r = Router();

  // Submit N jobs to a queue as one logical batch.
  r.post(
    '/queues/:queueId/batches',
    validate({ params: queueIdParam, body: createBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      const queue = await getQueue(pool, queueId);
      const b = body<typeof createBody>(req);
      const { batchId, jobs } = await enqueueBatch(
        pool,
        queue!.project_id,
        b.name,
        b.jobs.map((j) => ({
          queueId,
          payload: j.payload,
          priority: j.priority,
          idempotencyKey: j.idempotencyKey ?? null,
          runAt: j.runAt ? new Date(j.runAt) : undefined,
        })),
      );
      res.status(201).json({ batchId, count: jobs.length });
    }),
  );

  // Batch-level status rollup.
  r.get(
    '/batches/:batchId',
    validate({ params: batchIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { batchId } = params<typeof batchIdParam>(req);
      if ((await batchOrganizationId(pool, batchId)) !== organizationId) throw notFound('Batch not found');
      res.json(await getBatchStatus(pool, batchId));
    }),
  );

  return r;
}
