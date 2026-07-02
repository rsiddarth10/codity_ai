/** Domain types mirroring the schema, plus retry-policy value objects. */

export type JobStatus =
  | 'scheduled'
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'cancelled';

export type RetryStrategy = 'fixed' | 'linear' | 'exponential';

export type ExecutionStatus = 'running' | 'succeeded' | 'failed';

/** The retry policy snapshotted onto each job at enqueue (see DESIGN.md §1.2). */
export interface RetryConfig {
  strategy: RetryStrategy;
  base_delay_ms: number;
  max_delay_ms: number | null;
  multiplier: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  strategy: 'exponential',
  base_delay_ms: 1000,
  max_delay_ms: 60_000,
  multiplier: 2,
  jitter: true,
};

export const DEFAULT_MAX_ATTEMPTS = 3;

export interface JobRow {
  id: string;
  queue_id: string;
  batch_id: string | null;
  scheduled_job_id: string | null;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
  retry_config: RetryConfig;
  retry_policy_id: string | null;
  run_at: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  lock_expires_at: Date | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface QueueRow {
  id: string;
  project_id: string;
  name: string;
  priority: number;
  concurrency_limit: number;
  retry_policy_id: string | null;
  is_paused: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WorkerRow {
  id: string;
  name: string;
  status: 'active' | 'draining' | 'dead';
  concurrency: number;
  metadata: Record<string, unknown>;
  last_heartbeat: Date;
  registered_at: Date;
}

export interface JobExecutionRow {
  id: string;
  job_id: string;
  attempt_number: number;
  worker_id: string | null;
  status: ExecutionStatus;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  error_message: string | null;
  error_stack: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
}

export interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface RetryPolicyRow {
  id: string;
  project_id: string;
  name: string;
  strategy: RetryStrategy;
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number | null;
  backoff_multiplier: string; // numeric arrives as string from pg
  jitter: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface JobLogRow {
  id: number;
  job_id: string;
  execution_id: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata: Record<string, unknown> | null;
  logged_at: Date;
}

export interface QueueStats {
  queued: number;
  scheduled: number;
  running: number;
  completed: number;
  failed: number;
  dead_letter: number;
  cancelled: number;
  total: number;
  avg_duration_ms: number;
  succeeded_executions: number;
}
