import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useAuth } from '../auth';

// ── Shared types (mirror the API responses) ──
export interface Project { id: string; name: string; created_at: string }
export interface Queue {
  id: string; project_id: string; name: string; priority: number;
  concurrency_limit: number; retry_policy_id: string | null; is_paused: boolean;
}
export interface QueueStats {
  queued: number; scheduled: number; running: number; completed: number;
  failed: number; dead_letter: number; cancelled: number; total: number;
  avg_duration_ms: number; succeeded_executions: number;
}
export interface ThroughputBucket { bucket: string; completed: number; failed: number; dead_lettered: number }
export interface Job {
  id: string; queue_id: string; status: string; priority: number;
  payload: Record<string, unknown>; attempts: number; max_attempts: number;
  run_at: string; last_error: string | null; created_at: string;
  claimed_by: string | null; started_at: string | null; completed_at: string | null;
  idempotency_key: string | null;
}
export interface JobExecution {
  id: string; attempt_number: number; worker_id: string | null; status: string;
  started_at: string; finished_at: string | null; duration_ms: number | null; error_message: string | null;
}
export interface JobLog { id: number; level: string; message: string; logged_at: string; metadata: unknown }
export interface Transition { id: number; from_status: string | null; to_status: string; reason: string | null; created_at: string }
export interface Worker {
  id: string; name: string; status: string; concurrency: number;
  last_heartbeat: string; running_jobs: number;
}
export interface RetryPolicy { id: string; name: string; strategy: string; max_attempts: number }
export interface Schedule {
  id: string; name: string; cron_expression: string; timezone: string;
  is_active: boolean; next_run_at: string | null; last_run_at: string | null;
}
export interface DeadLetter { id: string; job_id: string; reason: string; attempts_made: number; last_error: string | null; moved_at: string }
export interface Paginated<T> { data: T[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }

const POLL = 3000;

function useApi() {
  return useAuth().authedFetch;
}

/** Thin wrapper so every query shares the authed fetch + a stable key. */
function useApiQuery<T>(key: unknown[], path: string, options?: Partial<UseQueryOptions<T>>) {
  const api = useApi();
  return useQuery<T>({ queryKey: key, queryFn: () => api<T>(path), ...options });
}

// ── Projects ──
export const useProjects = () => useApiQuery<Paginated<Project>>(['projects'], '/api/v1/projects?pageSize=100');
export function useCreateProject() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

// ── Queues ──
export const useQueues = (projectId: string) =>
  useApiQuery<{ data: Queue[] }>(['queues', projectId], `/api/v1/projects/${projectId}/queues`, { refetchInterval: POLL });
export const useQueue = (queueId: string) => useApiQuery<Queue>(['queue', queueId], `/api/v1/queues/${queueId}`);
export const useQueueStats = (queueId: string) =>
  useApiQuery<QueueStats>(['queueStats', queueId], `/api/v1/queues/${queueId}/stats`, { refetchInterval: POLL });
export const useThroughput = (queueId: string, minutes = 30) =>
  useApiQuery<{ data: ThroughputBucket[] }>(['throughput', queueId, minutes], `/api/v1/queues/${queueId}/throughput?minutes=${minutes}`, { refetchInterval: POLL });

export function useCreateQueue(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { name: string; priority?: number; concurrencyLimit?: number; retryPolicyId?: string | null }) =>
      api(`/api/v1/projects/${projectId}/queues`, { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queues', projectId] }),
  });
}
export function useUpdateQueue(queueId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api(`/api/v1/queues/${queueId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue', queueId] }),
  });
}
export function useSetPaused(queueId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => api(`/api/v1/queues/${queueId}/${paused ? 'pause' : 'resume'}`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue', queueId] });
      qc.invalidateQueries({ queryKey: ['queues'] });
    },
  });
}

// ── Jobs ──
export function useJobs(queueId: string, status: string, page: number, pageSize = 15) {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status) q.set('status', status);
  return useApiQuery<Paginated<Job>>(['jobs', queueId, status, page, pageSize], `/api/v1/queues/${queueId}/jobs?${q}`, { refetchInterval: POLL });
}
export const useJob = (jobId: string) => useApiQuery<Job>(['job', jobId], `/api/v1/jobs/${jobId}`, { refetchInterval: POLL });
export const useJobExecutions = (jobId: string) => useApiQuery<{ data: JobExecution[] }>(['jobExecs', jobId], `/api/v1/jobs/${jobId}/executions`, { refetchInterval: POLL });
export const useJobLogs = (jobId: string) => useApiQuery<{ data: JobLog[] }>(['jobLogs', jobId], `/api/v1/jobs/${jobId}/logs?pageSize=100`, { refetchInterval: POLL });
export const useJobTransitions = (jobId: string) => useApiQuery<{ data: Transition[] }>(['jobTrans', jobId], `/api/v1/jobs/${jobId}/transitions`, { refetchInterval: POLL });

export function useCreateJob(queueId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { payload?: unknown; priority?: number; runAt?: string }) =>
      api(`/api/v1/queues/${queueId}/jobs`, { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', queueId] }),
  });
}
export function useJobAction(jobId: string, queueId?: string) {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['job', jobId] });
    if (queueId) qc.invalidateQueries({ queryKey: ['jobs', queueId] });
    qc.invalidateQueries({ queryKey: ['deadLetter'] });
  };
  return {
    retry: useMutation({ mutationFn: () => api(`/api/v1/jobs/${jobId}/retry`, { method: 'POST' }), onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: () => api(`/api/v1/jobs/${jobId}/cancel`, { method: 'POST' }), onSuccess: invalidate }),
  };
}

// ── Dead letter, workers, schedules, retry policies ──
export const useDeadLetter = (queueId: string, page: number) =>
  useApiQuery<Paginated<DeadLetter>>(['deadLetter', queueId, page], `/api/v1/queues/${queueId}/dead-letter?page=${page}&pageSize=15`, { refetchInterval: POLL });
export const useWorkers = () => useApiQuery<{ data: Worker[] }>(['workers'], '/api/v1/workers', { refetchInterval: POLL });
export const useSchedules = (queueId: string) => useApiQuery<{ data: Schedule[] }>(['schedules', queueId], `/api/v1/queues/${queueId}/schedules`, { refetchInterval: POLL });
export const useRetryPolicies = (projectId: string) => useApiQuery<{ data: RetryPolicy[] }>(['policies', projectId], `/api/v1/projects/${projectId}/retry-policies`);

export function useCreateSchedule(queueId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { name: string; cronExpression: string; payload?: unknown }) =>
      api(`/api/v1/queues/${queueId}/schedules`, { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules', queueId] }),
  });
}
export function useToggleSchedule(queueId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api(`/api/v1/schedules/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules', queueId] }),
  });
}
export function useDeleteSchedule(queueId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/v1/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules', queueId] }),
  });
}
