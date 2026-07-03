import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '@codity/db';
import {
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  scheduleOrganizationId,
  isValidCron,
} from '@codity/core';
import { asyncHandler } from '../http.js';
import { validate, body, params } from '../validate.js';
import { authOf } from '../middleware/auth.js';
import { badRequest, notFound } from '../errors.js';
import { assertQueue } from '../scoping.js';

const queueIdParam = z.object({ queueId: z.string().uuid() });
const scheduleIdParam = z.object({ scheduleId: z.string().uuid() });
const createBody = z.object({
  name: z.string().min(1).max(200),
  cronExpression: z.string().min(1),
  timezone: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
  retryPolicyId: z.string().uuid().nullish(),
});
const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  cronExpression: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

async function assertSchedule(pool: Pool, scheduleId: string, orgId: string): Promise<void> {
  if ((await scheduleOrganizationId(pool, scheduleId)) !== orgId) throw notFound('Schedule not found');
}

export function scheduleRoutes(pool: Pool): Router {
  const r = Router();

  r.post(
    '/queues/:queueId/schedules',
    validate({ params: queueIdParam, body: createBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      const b = body<typeof createBody>(req);
      if (!isValidCron(b.cronExpression, b.timezone ?? 'UTC')) {
        throw badRequest('Invalid cron expression');
      }
      const schedule = await createSchedule(pool, {
        queueId,
        name: b.name,
        cronExpression: b.cronExpression,
        timezone: b.timezone,
        payload: b.payload,
        priority: b.priority,
        retryPolicyId: b.retryPolicyId ?? null,
      });
      res.status(201).json(schedule);
    }),
  );

  r.get(
    '/queues/:queueId/schedules',
    validate({ params: queueIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { queueId } = params<typeof queueIdParam>(req);
      await assertQueue(pool, queueId, organizationId);
      res.json({ data: await listSchedules(pool, queueId) });
    }),
  );

  r.get(
    '/schedules/:scheduleId',
    validate({ params: scheduleIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { scheduleId } = params<typeof scheduleIdParam>(req);
      await assertSchedule(pool, scheduleId, organizationId);
      res.json(await getSchedule(pool, scheduleId));
    }),
  );

  r.patch(
    '/schedules/:scheduleId',
    validate({ params: scheduleIdParam, body: patchBody }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { scheduleId } = params<typeof scheduleIdParam>(req);
      await assertSchedule(pool, scheduleId, organizationId);
      const b = body<typeof patchBody>(req);
      if (b.cronExpression && !isValidCron(b.cronExpression, b.timezone ?? 'UTC')) {
        throw badRequest('Invalid cron expression');
      }
      const updated = await updateSchedule(pool, scheduleId, b);
      res.json(updated);
    }),
  );

  r.delete(
    '/schedules/:scheduleId',
    validate({ params: scheduleIdParam }),
    asyncHandler(async (req, res) => {
      const { organizationId } = authOf(req);
      const { scheduleId } = params<typeof scheduleIdParam>(req);
      await assertSchedule(pool, scheduleId, organizationId);
      await deleteSchedule(pool, scheduleId);
      res.status(204).end();
    }),
  );

  return r;
}
