import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pino from 'pino';
import type { Pool } from '@codity/db';
import { enqueueJob, countJobsByStatus, countInFlight } from '@codity/core';
import { WorkerEngine, HandlerRegistry, type WorkerEngineConfig } from '@codity/worker';
import { testPool, resetDb, seedQueue, waitFor } from './helpers.js';

const silentLogger = pino({ level: 'silent' });

/** Fast, deterministic engine config for tests (tight poll, no jitter). */
function fastConfig(overrides: Partial<WorkerEngineConfig> = {}): Omit<WorkerEngineConfig, 'queueIds'> {
  return {
    concurrency: 4,
    pollIntervalMs: 10,
    pollJitterMs: 0,
    heartbeatIntervalMs: 50,
    lockDurationMs: 30_000,
    shutdownTimeoutMs: 5_000,
    workerName: 'test-worker',
    ...overrides,
  };
}

describe('worker engine', () => {
  const pool: Pool = testPool(30);
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('processes all queued jobs to completion', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 100 });
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) => enqueueJob(pool, { queueId, payload: { type: 'echo', i } })),
    );

    const engine = new WorkerEngine(pool, { ...fastConfig(), queueIds: [queueId] }, new HandlerRegistry().setDefault(async () => ({ ok: true })), silentLogger);
    await engine.start();
    try {
      await waitFor(async () => (await countJobsByStatus(pool, queueId)).completed === N);
    } finally {
      await engine.stop();
    }

    const counts = await countJobsByStatus(pool, queueId);
    expect(counts.completed).toBe(N);

    // Every job has exactly one succeeded execution row + a result.
    const execs = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_executions WHERE status='succeeded'`,
    );
    expect(execs.rows[0]!.n).toBe(N);
  });

  it('never runs more than `concurrency` jobs at once (in-process semaphore)', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 1000 });
    await Promise.all(Array.from({ length: 20 }, () => enqueueJob(pool, { queueId, payload: { type: 'busy' } })));

    let current = 0;
    let observedMax = 0;
    const handlers = new HandlerRegistry().register('busy', async () => {
      current += 1;
      observedMax = Math.max(observedMax, current);
      await new Promise((r) => setTimeout(r, 40));
      current -= 1;
      return { ok: true };
    });

    const engine = new WorkerEngine(pool, { ...fastConfig({ concurrency: 3 }), queueIds: [queueId] }, handlers, silentLogger);
    await engine.start();
    try {
      await waitFor(async () => (await countJobsByStatus(pool, queueId)).completed === 20);
    } finally {
      await engine.stop();
    }

    expect(observedMax).toBeGreaterThan(0);
    expect(observedMax).toBeLessThanOrEqual(3);
  });

  it('records failures via the failing handler', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 100 });
    await enqueueJob(pool, { queueId, payload: { type: 'fail', message: 'kaboom' } });

    const handlers = new HandlerRegistry().register('fail', async () => {
      throw new Error('kaboom');
    });
    const engine = new WorkerEngine(pool, { ...fastConfig(), queueIds: [queueId] }, handlers, silentLogger);
    await engine.start();
    try {
      await waitFor(async () => (await countJobsByStatus(pool, queueId)).failed === 1);
    } finally {
      await engine.stop();
    }

    const failed = await pool.query<{ last_error: string }>(
      `SELECT last_error FROM jobs WHERE queue_id=$1`,
      [queueId],
    );
    expect(failed.rows[0]!.last_error).toBe('kaboom');
  });

  it('graceful shutdown drains in-flight jobs; nothing left stuck', async () => {
    const { queueId } = await seedQueue(pool, { name: 'q', concurrencyLimit: 100 });
    await Promise.all(Array.from({ length: 4 }, () => enqueueJob(pool, { queueId, payload: { type: 'slow' } })));

    const handlers = new HandlerRegistry().register('slow', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    });
    const engine = new WorkerEngine(pool, { ...fastConfig({ concurrency: 4 }), queueIds: [queueId] }, handlers, silentLogger);
    await engine.start();

    // Wait until all 4 are actually in flight, then request shutdown mid-execution.
    await waitFor(() => engine.inFlightCount === 4, { timeoutMs: 3000 });
    const outcome = await engine.stop();

    expect(outcome).toBe('drained');
    const counts = await countJobsByStatus(pool, queueId);
    expect(counts.completed).toBe(4);
    // No jobs left in a claimed/running limbo after a clean shutdown.
    expect(await countInFlight(pool, queueId)).toBe(0);
  });
});
