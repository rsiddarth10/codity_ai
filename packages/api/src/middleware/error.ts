import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ApiError, notFound } from '../errors.js';

/** 404 for unmatched routes — forwarded to the error handler for a consistent shape. */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(notFound('Route not found'));
}

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/**
 * Centralized error handler producing a consistent envelope:
 *   { error: { code, message, details?, requestId } }
 * Maps ApiError directly, translates known Postgres errors (unique/FK/check) to 4xx, and
 * treats everything else as an opaque 500 (no leaking internals to clients).
 */
export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req.id as string | undefined) ?? undefined;

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown;

    if (err instanceof ApiError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else {
      const pg = err as PgError;
      if (pg.code === '23505') {
        status = 409;
        code = 'CONFLICT';
        message = 'Resource already exists';
        details = { constraint: pg.constraint };
      } else if (pg.code === '23503') {
        status = 400;
        code = 'FOREIGN_KEY_VIOLATION';
        message = 'Referenced resource does not exist';
        details = { constraint: pg.constraint };
      } else if (pg.code === '23514') {
        status = 400;
        code = 'CHECK_VIOLATION';
        message = 'A value violates a constraint';
        details = { constraint: pg.constraint };
      }
    }

    if (status >= 500) {
      req.log?.error({ err }, 'unhandled error');
    }

    res.status(status).json({ error: { code, message, details, requestId } });
  };
}
