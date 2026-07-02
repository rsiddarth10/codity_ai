import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@codity/shared';
import type { RequestHandler } from 'express';

/**
 * Structured request logging (method, path, status, latency, request id). Assigns a
 * request id (honoring an inbound x-request-id) and echoes it on the response, so logs
 * and clients can correlate a request end-to-end.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Don't log Authorization headers.
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
  }) as unknown as RequestHandler;
}
