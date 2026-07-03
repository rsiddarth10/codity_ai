import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import type { Pool } from '@codity/db';
import { createLogger, type Logger } from '@codity/shared';
import type { AppConfig } from './context.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requireAuth, authOf } from './middleware/auth.js';
import { asyncHandler } from './http.js';
import { unauthorized } from './errors.js';
import { getUserById } from './auth/repository.js';
import { authRoutes } from './routes/auth.routes.js';
import { projectRoutes } from './routes/projects.routes.js';
import { queueRoutes } from './routes/queues.routes.js';
import { jobRoutes } from './routes/jobs.routes.js';
import { workerRoutes } from './routes/workers.routes.js';
import { scheduleRoutes } from './routes/schedules.routes.js';
import { batchRoutes } from './routes/batches.routes.js';
import { userRoutes } from './routes/users.routes.js';
import { buildOpenApiSpec } from './openapi.js';

/**
 * Build the Express app. Pool, config and logger are injected so integration tests can
 * supply a test pool + secrets + silent logger. Route mounting order encodes the auth
 * boundary: /auth is public; everything after `requireAuth` needs a valid token.
 */
export function buildApp(
  pool: Pool,
  config: AppConfig,
  logger: Logger = createLogger({ name: 'api' }),
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cors());
  app.use(requestLogger(logger));

  // Liveness + readiness (checks DB connectivity). Public.
  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    }),
  );

  // API docs. Public.
  const spec = buildOpenApiSpec();
  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));

  const api = express.Router();

  // Public auth endpoints.
  api.use('/auth', authRoutes(pool, config));

  // Everything below requires a valid access token.
  api.use(requireAuth(config.jwtAccessSecret));

  api.get(
    '/me',
    asyncHandler(async (req, res) => {
      const { userId } = authOf(req);
      const user = await getUserById(pool, userId);
      if (!user) throw unauthorized('User no longer exists');
      res.json({ id: user.id, email: user.email, role: user.role, organizationId: user.organization_id });
    }),
  );

  api.use(projectRoutes(pool));
  api.use(queueRoutes(pool));
  api.use(jobRoutes(pool));
  api.use(scheduleRoutes(pool));
  api.use(batchRoutes(pool));
  api.use(userRoutes(pool, config));
  api.use(workerRoutes(pool));

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler());

  return app;
}
