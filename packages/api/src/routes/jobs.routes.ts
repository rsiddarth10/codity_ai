import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '@codity/db';
import {
  enqueueJob,
  getJob,
  listJobs,
  countJobs,
  listJobExecutions,
  listJobLogs,
  listJobTransitions,
  cancelJob,
  retryJob,
  listDeadLetter,
  countDeadLetter,
  listJobDependencies,
} from '@codity/core';
import { asyncHandler, paginationQuery, toPagination, paginated } from '../http.js';
import { validate, body, query, params } from '../validate.js';
import { authOf } from '../middleware/auth.js';
import { notFound, conflict } from '../errors.js';
import { assertQueue, assertJob } from '../scoping.js';

const JOB_STATUSES = [
  'scheduled',
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'dead_letter',
  'cancelled',
] as const;

const queueIdParam = z.object({ queueId: z.string().uuid() });
const jobIdParam = z.object({ jobId: z.string().uuid() });

const createBody = z.object({
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
  idempotencyKey: z.string().min(1).max(255).nullish(),
  runAt: z.string().datetime().optional(),
  dependsOn: z.array(z.string().uuid()).max(100).optional(),
});
const listQuery = paginationQuery.extend({ status: z.enum(JOB_STATUSES).optional() });

export function jobRoutes(pool: Pool): Router {
  const r = Router();

  r.post(
    '/queues/:queueId/jobs',
    validate({ params: queueIdParam, body: createBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      const b = body<typeof createBody>(req);
      const { job, created } = await enqueueJob(pool, {
        queueId,
        payload: b.payload,
        priority: b.priority,
        idempotencyKey: b.idempotencyKey ?? null,
        runAt: b.runAt ? new Date(b.runAt) : undefined,
        dependsOn: b.dependsOn,
      });
      // 201 when a job was created; 200 when an idempotency key returned the existing one.
      res.status(created ? 201 : 200).json({ job, idempotent: !created });
    }),
  );

  r.get(
    '/queues/:queueId/jobs',
    validate({ params: queueIdParam, query: listQuery }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      const q = query<typeof listQuery>(req);
      const p = toPagination(q);
      const [items, total] = await Promise.all([
        listJobs(pool, queueId, { ...p, status: q.status }),
        countJobs(pool, queueId, q.status),
      ]);
      res.json(paginated(items, total, q));
    }),
  );

  r.get(
    '/jobs/:jobId',
    validate({ params: jobIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { jobId } = params<typeof jobIdParam>(req);
      await assertJob(pool, jobId, organizationId);
      res.json(await getJob(pool, jobId));
    }),
  );

  r.get(
    '/jobs/:jobId/executions',
    validate({ params: jobIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { jobId } = params<typeof jobIdParam>(req);
      await assertJob(pool, jobId, organizationId);
      res.json({ data: await listJobExecutions(pool, jobId) });
    }),
  );

  r.get(
    '/jobs/:jobId/logs',
    validate({ params: jobIdParam, query: paginationQuery }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { jobId } = params<typeof jobIdParam>(req);
      await assertJob(pool, jobId, organizationId);
      const q = query<typeof paginationQuery>(req);
      res.json({ data: await listJobLogs(pool, jobId, toPagination(q)) });
    }),
  );

  r.get(
    '/jobs/:jobId/transitions',
    validate({ params: jobIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { jobId } = params<typeof jobIdParam>(req);
      await assertJob(pool, jobId, organizationId);
      res.json({ data: await listJobTransitions(pool, jobId) });
    }),
  );

  r.get(
    '/jobs/:jobId/dependencies',
    validate({ params: jobIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { jobId } = params<typeof jobIdParam>(req);
      await assertJob(pool, jobId, organizationId);
      res.json({ data: await listJobDependencies(pool, jobId) });
    }),
  );

  r.post(
    '/jobs/:jobId/cancel',
    validate({ params: jobIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { jobId } = params<typeof jobIdParam>(req);
      await assertJob(pool, jobId, organizationId);
      const cancelled = await cancelJob(pool, jobId);
      if (!cancelled) throw conflict('Job cannot be cancelled in its current state');
      res.json(cancelled);
    }),
  );

  // Manual retry of a failed (in-backoff) or dead-lettered job.
  r.post(
    '/jobs/:jobId/retry',
    validate({ params: jobIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { jobId } = params<typeof jobIdParam>(req);
      await assertJob(pool, jobId, organizationId);
      const retried = await retryJob(pool, jobId);
      if (!retried) throw conflict('Job is not in a retriable state (must be failed or dead_letter)');
      res.json(retried);
    }),
  );

  // Dead Letter Queue for a queue.
  r.get(
    '/queues/:queueId/dead-letter',
    validate({ params: queueIdParam, query: paginationQuery }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      const q = query<typeof paginationQuery>(req);
      const p = toPagination(q);
      const [items, total] = await Promise.all([
        listDeadLetter(pool, queueId, p),
        countDeadLetter(pool, queueId),
      ]);
      res.json(paginated(items, total, q));
    }),
  );

  return r;
}
