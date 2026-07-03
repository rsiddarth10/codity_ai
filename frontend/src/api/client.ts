export const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** Low-level JSON request. Adds a Bearer token when provided; throws ApiError on !ok. */
export async function request<T = unknown>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message =
      (data as { error?: { message?: string } })?.error?.message || res.statusText || 'Request failed';
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}
