import { Link, useParams } from 'react-router-dom';
import { useJob, useJobExecutions, useJobLogs, useJobTransitions, useJobAction } from '../api/hooks';
import { Spinner, ErrorMsg, StatusBadge, fmt } from '../components';

export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { data: job, isLoading, error } = useJob(jobId!);
  const { data: execs } = useJobExecutions(jobId!);
  const { data: logs } = useJobLogs(jobId!);
  const { data: transitions } = useJobTransitions(jobId!);
  const { retry, cancel } = useJobAction(jobId!, job?.queue_id);

  if (isLoading) return <Spinner />;
  if (error || !job) return <ErrorMsg error={error} />;

  const canRetry = job.status === 'failed' || job.status === 'dead_letter';
  const canCancel = job.status === 'queued' || job.status === 'scheduled';

  return (
    <div>
      <h1 className="page-title">
        Job <span className="mono">{job.id.slice(0, 8)}</span> <StatusBadge status={job.status} />
      </h1>
      <p className="page-sub">
        <Link to={`/queues/${job.queue_id}/jobs`}>← Jobs</Link>
      </p>

      <div className="row" style={{ marginBottom: 16 }}>
        <button className="primary" disabled={!canRetry || retry.isPending} onClick={() => retry.mutate()}>
          Retry job
        </button>
        <button className="danger" disabled={!canCancel || cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel job
        </button>
        {(retry.error || cancel.error) && <span className="error">{((retry.error || cancel.error) as Error).message}</span>}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="panel">
          <strong>Details</strong>
          <div className="kv" style={{ marginTop: 10 }}>
            <span className="k">Attempts</span>
            <span>
              {job.attempts} / {job.max_attempts}
            </span>
            <span className="k">Priority</span>
            <span>{job.priority}</span>
            <span className="k">Run at</span>
            <span>{fmt(job.run_at)}</span>
            <span className="k">Created</span>
            <span>{fmt(job.created_at)}</span>
            <span className="k">Idempotency key</span>
            <span className="mono">{job.idempotency_key ?? '—'}</span>
            <span className="k">Last error</span>
            <span className="error">{job.last_error ?? '—'}</span>
          </div>
          <details style={{ marginTop: 12 }}>
            <summary className="muted">Payload</summary>
            <pre className="mono">{JSON.stringify(job.payload, null, 2)}</pre>
          </details>
        </div>

        <div className="panel">
          <strong>Lifecycle timeline</strong>
          <ul className="timeline" style={{ marginTop: 12 }}>
            {(transitions?.data ?? []).map((t) => (
              <li key={t.id}>
                <span className="dot" />
                <div>
                  <StatusBadge status={t.to_status} /> <span className="muted">{fmt(t.created_at)}</span>
                </div>
                {t.reason && <div className="muted">{t.reason}</div>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <strong>Attempt history</strong>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Worker</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {(execs?.data ?? []).map((e) => (
              <tr key={e.id}>
                <td className="mono">{e.attempt_number}</td>
                <td>
                  <StatusBadge status={e.status === 'succeeded' ? 'completed' : e.status === 'failed' ? 'failed' : 'running'} />
                </td>
                <td className="mono">{e.worker_id ? e.worker_id.slice(0, 8) : '—'}</td>
                <td className="muted">{fmt(e.started_at)}</td>
                <td className="mono">{e.duration_ms != null ? `${e.duration_ms}ms` : '—'}</td>
                <td className="error">{e.error_message ?? '—'}</td>
              </tr>
            ))}
            {(execs?.data ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No attempts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <strong>Logs</strong>
        <div style={{ marginTop: 8 }}>
          {(logs?.data ?? []).map((l) => (
            <div className="logline mono" key={l.id}>
              <span className={`lvl log-${l.level}`}>{l.level}</span>
              <span className="muted">{new Date(l.logged_at).toLocaleTimeString()} </span>
              {l.message}
            </div>
          ))}
          {(logs?.data ?? []).length === 0 && <span className="muted">No logs.</span>}
        </div>
      </div>
    </div>
  );
}
