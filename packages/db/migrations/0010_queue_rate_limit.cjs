/* eslint-disable camelcase */

/**
 * Phase 8 — migration 10: per-queue rate limiting.
 *
 * rate_limit_per_sec caps how many jobs may be CLAIMED per rolling second for a queue,
 * across all workers. NULL = unlimited. Enforced inside the claim query's capacity CTE
 * (under the same per-queue advisory lock that makes concurrency exact), by counting jobs
 * whose claimed_at falls within the last second. See DESIGN.md §8.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('queues', {
    rate_limit_per_sec: { type: 'integer', check: 'rate_limit_per_sec IS NULL OR rate_limit_per_sec >= 1' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('queues', 'rate_limit_per_sec');
};
