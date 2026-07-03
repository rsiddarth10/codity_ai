import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useJobs, useCreateJob } from '../api/hooks';
import { Spinner, ErrorMsg, StatusBadge, Paginator, fmt } from '../components';

const STATUSES = ['', 'scheduled', 'queued', 'claimed', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'];

export function JobsPage() {
  const { queueId } = useParams<{ queueId: string }>();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useJobs(queueId!, status, page);
  const create = useCreateJob(queueId!);

  return (
    <div>
      <h1 className="page-title">Job explorer</h1>
      <p className="page-sub">
        <Link to={`/queues/${queueId}`}>← Queue</Link>
      </p>

      <div className="toolbar">
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">Status</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || 'all'}
              </option>
            ))}
          </select>
        </label>
        <div className="spacer" style={{ flex: 1 }} />
        <button
          className="primary"
          disabled={create.isPending}
          onClick={() => create.mutate({ payload: { type: 'echo' } })}
        >
          + Enqueue test job
        </button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorMsg error={error} />
      ) : (
        <>
          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Attempts</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data!.data.map((j) => (
                  <tr key={j.id}>
                    <td className="mono">
                      <Link to={`/jobs/${j.id}`}>{j.id.slice(0, 8)}</Link>
                    </td>
                    <td>
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="mono">{j.priority}</td>
                    <td className="mono">
                      {j.attempts}/{j.max_attempts}
                    </td>
                    <td className="muted">{fmt(j.created_at)}</td>
                  </tr>
                ))}
                {data!.data.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No jobs match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Paginator page={page} totalPages={data!.pagination.totalPages} onPage={setPage} />
          <p className="muted">{data!.pagination.total} total jobs</p>
        </>
      )}
    </div>
  );
}
