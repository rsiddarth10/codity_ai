import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type infer as ZodInfer } from 'zod';
import { badRequest } from './errors.js';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validate request body/query/params against zod schemas. Parsed values land on
 * `req.validated` (we don't overwrite req.query — it's a getter in some Express setups).
 * On failure, respond with a structured 400 including the flattened zod issues.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.validated = {
        body: schemas.body ? schemas.body.parse(req.body) : req.body,
        query: schemas.query ? schemas.query.parse(req.query) : req.query,
        params: schemas.params ? schemas.params.parse(req.params) : req.params,
      };
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(badRequest('Validation failed', err.flatten()));
      } else {
        next(err);
      }
    }
  };
}

/** Typed accessors so handlers get inference from their schemas. */
export const body = <T extends ZodTypeAny>(req: Request): ZodInfer<T> => req.validated.body as ZodInfer<T>;
export const query = <T extends ZodTypeAny>(req: Request): ZodInfer<T> => req.validated.query as ZodInfer<T>;
export const params = <T extends ZodTypeAny>(req: Request): ZodInfer<T> => req.validated.params as ZodInfer<T>;
