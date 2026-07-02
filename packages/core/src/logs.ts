import type { Queryable } from './tx.js';

export interface AddJobLogInput {
  jobId: string;
  executionId?: string | null;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, unknown> | null;
}

/** Append a structured log line emitted by a job handler. */
export async function addJobLog(db: Queryable, input: AddJobLogInput): Promise<void> {
  await db.query(
    `INSERT INTO job_logs (job_id, execution_id, level, message, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.jobId, input.executionId ?? null, input.level ?? 'info', input.message, input.metadata ?? null],
  );
}
