import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '@codity/db';
import type { AppConfig } from '../context.js';
import { asyncHandler } from '../http.js';
import { validate, body } from '../validate.js';
import { signup, login, refresh, logout } from '../auth/service.js';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'password must be at least 8 characters').max(200),
  organizationName: z.string().min(1).max(200),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export function authRoutes(pool: Pool, config: AppConfig): Router {
  const r = Router();

  r.post(
    '/signup',
    validate({ body: signupSchema }),
    asyncHandler(async (req, res) => {
      const tokens = await signup(pool, config, body<typeof signupSchema>(req));
      res.status(201).json(tokens);
    }),
  );

  r.post(
    '/login',
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
      res.json(await login(pool, config, body<typeof loginSchema>(req)));
    }),
  );

  r.post(
    '/refresh',
    validate({ body: refreshSchema }),
    asyncHandler(async (req, res) => {
      res.json(await refresh(pool, config, body<typeof refreshSchema>(req).refreshToken));
    }),
  );

  r.post(
    '/logout',
    validate({ body: refreshSchema }),
    asyncHandler(async (req, res) => {
      await logout(pool, body<typeof refreshSchema>(req).refreshToken);
      res.status(204).end();
    }),
  );

  return r;
}
