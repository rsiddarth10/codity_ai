import { describe, it, expect } from 'vitest';
import { computeBackoffMs, type RetryConfig } from '@codity/core';

/** Unit tests for the pure backoff calculator (no DB). */
const base = (over: Partial<RetryConfig> = {}): RetryConfig => ({
  strategy: 'exponential',
  base_delay_ms: 1000,
  max_delay_ms: null,
  multiplier: 2,
  jitter: false,
  ...over,
});

describe('computeBackoffMs', () => {
  it('fixed: same delay every attempt', () => {
    const c = base({ strategy: 'fixed', base_delay_ms: 500 });
    expect(computeBackoffMs(c, 1)).toBe(500);
    expect(computeBackoffMs(c, 5)).toBe(500);
  });

  it('linear: grows linearly with attempt', () => {
    const c = base({ strategy: 'linear', base_delay_ms: 200 });
    expect(computeBackoffMs(c, 1)).toBe(200);
    expect(computeBackoffMs(c, 2)).toBe(400);
    expect(computeBackoffMs(c, 3)).toBe(600);
  });

  it('exponential: base * multiplier^(attempt-1)', () => {
    const c = base({ strategy: 'exponential', base_delay_ms: 100, multiplier: 2 });
    expect(computeBackoffMs(c, 1)).toBe(100);
    expect(computeBackoffMs(c, 2)).toBe(200);
    expect(computeBackoffMs(c, 3)).toBe(400);
    expect(computeBackoffMs(c, 4)).toBe(800);
  });

  it('caps at max_delay_ms', () => {
    const c = base({ strategy: 'exponential', base_delay_ms: 1000, multiplier: 10, max_delay_ms: 5000 });
    expect(computeBackoffMs(c, 1)).toBe(1000);
    expect(computeBackoffMs(c, 2)).toBe(5000); // 10000 capped
    expect(computeBackoffMs(c, 5)).toBe(5000);
  });

  it('equal jitter keeps the result within [delay/2, delay]', () => {
    const c = base({ strategy: 'fixed', base_delay_ms: 1000, jitter: true });
    // rng=0 -> exactly half; rng~1 -> ~full.
    expect(computeBackoffMs(c, 1, () => 0)).toBe(500);
    expect(computeBackoffMs(c, 1, () => 0.999)).toBeGreaterThan(999 - 1);
    for (let i = 0; i < 200; i++) {
      const v = computeBackoffMs(c, 1, Math.random);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });

  it('clamps attempt to >= 1', () => {
    const c = base({ strategy: 'exponential', base_delay_ms: 100, multiplier: 2 });
    expect(computeBackoffMs(c, 0)).toBe(100);
  });
});
