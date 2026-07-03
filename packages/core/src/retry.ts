import type { RetryConfig } from './types.js';

/**
 * Compute the delay (ms) before the next attempt, given the snapshotted retry policy and
 * the attempt number that just FAILED (1-based). Pure and deterministic (inject `rng` in
 * tests). Strategies:
 *
 *   fixed:        base
 *   linear:       base * attempt
 *   exponential:  base * multiplier^(attempt-1)
 *
 * Then the result is capped at `max_delay_ms` (if set), and — when `jitter` is on —
 * "equal jitter" is applied: keep half the delay and randomize the other half, i.e. the
 * returned value lands in [delay/2, delay]. Equal jitter spreads retry storms across
 * workers while still guaranteeing a minimum backoff (unlike full jitter, which can return
 * ~0 and hammer the queue).
 */
export function computeBackoffMs(
  config: RetryConfig,
  attempt: number,
  rng: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));

  let delay: number;
  switch (config.strategy) {
    case 'fixed':
      delay = config.base_delay_ms;
      break;
    case 'linear':
      delay = config.base_delay_ms * n;
      break;
    case 'exponential':
      delay = config.base_delay_ms * Math.pow(config.multiplier, n - 1);
      break;
    default:
      delay = config.base_delay_ms;
  }

  if (config.max_delay_ms != null) {
    delay = Math.min(delay, config.max_delay_ms);
  }

  if (config.jitter) {
    const half = delay / 2;
    delay = half + rng() * half;
  }

  return Math.max(0, Math.round(delay));
}
