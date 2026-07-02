import type { JobRow } from '@codity/core';

/** Context handed to every job handler. */
export interface JobContext {
  job: JobRow;
  /** Append a structured log line for this attempt (persisted to job_logs). */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, metadata?: Record<string, unknown>) => Promise<void>;
  /** Aborted when the worker is shutting down past its drain timeout. */
  signal: AbortSignal;
}

/** A job handler returns an optional JSON result (stored on the job). */
export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

/**
 * Dispatches jobs to handlers keyed by `payload.type`. A registry is how a real system
 * maps job kinds to code; unknown types fail loudly (better than silently succeeding).
 */
export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();
  private fallback?: JobHandler;

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  setDefault(handler: JobHandler): this {
    this.fallback = handler;
    return this;
  }

  resolve(job: JobRow): JobHandler {
    const type = typeof job.payload?.type === 'string' ? (job.payload.type as string) : 'default';
    const handler = this.handlers.get(type) ?? this.fallback;
    if (!handler) {
      return () => {
        throw new Error(`No handler registered for job type "${type}"`);
      };
    }
    return handler;
  }
}

/** Sleep that resolves early if the abort signal fires. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Built-in demo handlers, useful for exercising the system end-to-end from the API/UI:
 *   - echo:  returns the payload
 *   - sleep: waits payload.ms then succeeds (respects abort)
 *   - fail:  throws payload.message (to exercise retries/DLQ)
 */
export function defaultHandlers(): HandlerRegistry {
  return new HandlerRegistry()
    .register('echo', async (ctx) => {
      await ctx.log('info', 'echo handler', { payload: ctx.job.payload });
      return { echoed: ctx.job.payload };
    })
    .register('sleep', async (ctx) => {
      const ms = typeof ctx.job.payload?.ms === 'number' ? (ctx.job.payload.ms as number) : 100;
      await ctx.log('info', `sleeping ${ms}ms`);
      await abortableDelay(ms, ctx.signal);
      return { sleptMs: ms };
    })
    .register('fail', async (ctx) => {
      const message =
        typeof ctx.job.payload?.message === 'string'
          ? (ctx.job.payload.message as string)
          : 'intentional failure';
      await ctx.log('warn', `failing: ${message}`);
      throw new Error(message);
    })
    .setDefault(async (ctx) => {
      await ctx.log('info', 'default handler (no-op success)');
      return { ok: true };
    });
}
