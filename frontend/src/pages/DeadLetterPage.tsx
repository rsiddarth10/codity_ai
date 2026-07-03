import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDeadLetter, useJobAction } from '../api/hooks';
import { Spinner, ErrorMsg, Paginator, fmt } from '../components';

function RetryButton({ jobId, queueId }: { jobId: string; queueId: string }) {
  const { retry } = useJobAction(jobId, queueId);
  return (
    <button className="primary" disabled={retry.isPending} onClick={() => retry.mutate()}>
      Retry
    </button>
  );
}

export function DeadLetterPage() {
  const { queueId } = useParams<{ queueId: string }>();
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useDeadLetter(queueId!, page);

  if (isLoading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;

  return (
    <div>
      <h1 className="page-title">Dead Letter Queue</h1>
      <p className="page-sub">
        <Link to={`/queues/${queueId}`}>← Queue</Link> · jobs that exhausted their retries
      </p>
      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Reason</th>
              <th>Attempts</th>
              <th>Last error</th>
              <th>Moved</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data!.data.map((d) => (
              <tr key={d.id}>
                <td className="mono">
                  <Link to={`/jobs/${d.job_id}`}>{d.job_id.slice(0, 8)}</Link>
                </td>
                <td>{d.reason}</td>
                <td className="mono">{d.attempts_made}</td>
                <td className="error">{d.last_error ?? '—'}</td>
                <td className="muted">{fmt(d.moved_at)}</td>
                <td>
                  <RetryButton jobId={d.job_id} queueId={queueId!} />
                </td>
              </tr>
            ))}
            {data!.data.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Dead letter queue is empty. 🎉
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Paginator page={page} totalPages={data!.pagination.totalPages} onPage={setPage} />
    </div>
  );
}
