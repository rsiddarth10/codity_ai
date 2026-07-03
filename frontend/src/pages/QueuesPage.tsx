import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueues, useCreateQueue, useQueueStats, type Queue } from '../api/hooks';
import { Spinner, ErrorMsg, StatusBadge } from '../components';

function QueueRow({ queue }: { queue: Queue }) {
  const { data: stats } = useQueueStats(queue.id);
  return (
    <tr>
      <td>
        <Link to={`/queues/${queue.id}`}>{queue.name}</Link>{' '}
        {queue.is_paused && <StatusBadge status="draining" />}
      </td>
      <td className="mono">{queue.priority}</td>
      <td className="mono">{queue.concurrency_limit}</td>
      <td>{stats ? <span className="badge queued">{stats.queued}</span> : '…'}</td>
      <td>{stats ? <span className="badge running">{stats.running}</span> : '…'}</td>
      <td>{stats ? <span className="badge completed">{stats.completed}</span> : '…'}</td>
      <td>{stats ? <span className="badge failed">{stats.failed}</span> : '…'}</td>
      <td>{stats ? <span className="badge dead_letter">{stats.dead_letter}</span> : '…'}</td>
    </tr>
  );
}

export function QueuesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isLoading, error } = useQueues(projectId!);
  const create = useCreateQueue(projectId!);
  const [name, setName] = useState('');
  const [concurrency, setConcurrency] = useState(5);

  if (isLoading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;

  return (
    <div>
      <h1 className="page-title">Queues</h1>
      <p className="page-sub">
        <Link to="/projects">← Projects</Link> · health refreshes live
      </p>

      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate({ name: name.trim(), concurrencyLimit: concurrency }, { onSuccess: () => setName('') });
        }}
      >
        <input placeholder="New queue name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">concurrency</span>
          <input type="number" min={1} style={{ width: 80 }} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
        </label>
        <button className="primary" disabled={create.isPending}>
          Create queue
        </button>
        {create.error && <span className="error">{(create.error as Error).message}</span>}
      </form>

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Queue</th>
              <th>Priority</th>
              <th>Limit</th>
              <th>Queued</th>
              <th>Running</th>
              <th>Completed</th>
              <th>Failed</th>
              <th>DLQ</th>
            </tr>
          </thead>
          <tbody>
            {data!.data.map((q) => (
              <QueueRow key={q.id} queue={q} />
            ))}
            {data!.data.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No queues yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
