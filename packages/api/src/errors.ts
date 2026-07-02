/** A typed HTTP error carrying a machine-readable code and optional details. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required'): ApiError =>
  new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Forbidden'): ApiError => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found'): ApiError =>
  new ApiError(404, 'NOT_FOUND', message);
export const conflict = (message: string, details?: unknown): ApiError =>
  new ApiError(409, 'CONFLICT', message, details);
