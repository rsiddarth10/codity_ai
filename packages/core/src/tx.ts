import type { Pool, PoolClient } from '@codity/db';

/** Anything we can run a query on — the pool or a checked-out client (inside a tx). */
export type Queryable = Pool | PoolClient;

/**
 * Run `fn` inside a single BEGIN/COMMIT transaction on a dedicated client.
 * Rolls back on any throw and always releases the client. This is the atomic
 * boundary every correctness-sensitive lifecycle operation runs within.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // If ROLLBACK itself fails the connection is broken; releasing with an error
      // below discards it from the pool. Surface the original error, not this one.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Log a lifecycle transition into the audit table (call inside the owning tx). */
export async function logTransition(
  client: PoolClient,
  jobId: string,
  fromStatus: string | null,
  toStatus: string,
  workerId: string | null = null,
  reason: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO job_state_transitions (job_id, from_status, to_status, worker_id, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [jobId, fromStatus, toStatus, workerId, reason],
  );
}
