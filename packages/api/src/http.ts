import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';

/** Wrap an async handler so rejected promises reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Shared offset-pagination query schema (page/pageSize with sane bounds). */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Pagination {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

export function toPagination(q: { page: number; pageSize: number }): Pagination {
  return { page: q.page, pageSize: q.pageSize, limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
}

/** Consistent list envelope: { data, pagination }. */
export function paginated<T>(data: T[], total: number, p: { page: number; pageSize: number }) {
  return {
    data,
    pagination: {
      page: p.page,
      pageSize: p.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
    },
  };
}
