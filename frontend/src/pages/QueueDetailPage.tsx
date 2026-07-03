import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  useQueue,
  useQueueStats,
  useThroughput,
  useUpdateQueue,
  useSetPaused,
  useSchedules,
  useCreateSchedule,
  useToggleSchedule,
  useDeleteSchedule,
} from '../api/hooks';
import { Spinner, ErrorMsg, StatCard, StatusBadge, fmt } from '../components';

export function QueueDetailPage() {
  const { queueId } = useParams<{ queueId: string }>();
  const { data: queue, isLoading, error } = useQueue(queueId!);
  const { data: stats } = useQueueStats(queueId!);
  const { data: throughput } = useThroughput(queueId!, 30);
  const update = useUpdateQueue(queueId!);
  const pause = useSetPaused(queueId!);

  const [priority, setPriority] = useState(0);
  const [concurrency, setConcurrency] = useState(1);
  useEffect(() => {
    if (queue) {
      setPriority(queue.priority);
      setConcurrency(queue.concurrency_limit);
    }
  }, [queue]);

  if (isLoading) return <Spinner />;
  if (error || !queue) return <ErrorMsg error={error} />;

  const successRate =
    stats && stats.completed + stats.failed > 0
      ? Math.round((stats.completed / (stats.completed + stats.failed)) * 100)
      : 100;

  const chartData = (throughput?.data ?? []).map((b) => ({
    t: new Date(b.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    completed: b.completed,
    failed: b.failed,
  }));

  return (
    <div>
      <h1 className="page-title">
        Queue: {queue.name} {queue.is_paused && <StatusBadge status="draining" />}
      </h1>
      <p className="page-sub">
        <Link to={`/projects/${queue.project_id}/queues`}>← Queues</Link> ·{' '}
        <Link to={`/queues/${queue.id}/jobs`}>Jobs</Link> ·{' '}
        <Link to={`/queues/${queue.id}/dead-letter`}>Dead Letter Queue</Link>
      </p>

      {stats && (
        <div className="grid cards" style={{ marginBottom: 16 }}>
          <StatCard label="Queued" value={stats.queued} tone="accent" />
          <StatCard label="Running" value={stats.running} tone="amber" />
          <StatCard label="Completed" value={stats.completed} tone="green" />
          <StatCard label="Failed" value={stats.failed} tone="red" />
          <StatCard label="Dead-letter" value={stats.dead_letter} tone="purple" />
          <StatCard label="Success rate" value={`${successRate}%`} />
          <StatCard label="Avg duration" value={`${Math.round(stats.avg_duration_ms)}ms`} />
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row between">
          <strong>Throughput (last 30 min)</strong>
          <span className="muted">completed vs failed / min</span>
        </div>
        <div style={{ height: 220, marginTop: 10 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ left: -20, right: 8, top: 6 }}>
              <defs>
                <linearGradient id="g-completed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2ecc71" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#2ecc71" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="g-failed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ff5c6c" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#ff5c6c" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a3346" />
              <XAxis dataKey="t" stroke="#8b95a7" fontSize={11} minTickGap={30} />
              <YAxis stroke="#8b95a7" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#171d2b', border: '1px solid #2a3346', borderRadius: 8 }} />
              <Area type="monotone" dataKey="completed" stroke="#2ecc71" fill="url(#g-completed)" />
              <Area type="monotone" dataKey="failed" stroke="#ff5c6c" fill="url(#g-failed)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="panel">
          <strong>Configuration</strong>
          <div className="grid" style={{ gap: 10, marginTop: 12 }}>
            <label className="row between">
              <span className="muted">Priority</span>
              <input type="number" style={{ width: 100 }} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
            </label>
            <label className="row between">
              <span className="muted">Concurrency limit</span>
              <input type="number" min={1} style={{ width: 100 }} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
            </label>
            <div className="row">
              <button className="primary" disabled={update.isPending} onClick={() => update.mutate({ priority, concurrencyLimit: concurrency })}>
                Save config
              </button>
              <button onClick={() => pause.mutate(!queue.is_paused)} disabled={pause.isPending}>
                {queue.is_paused ? 'Resume queue' : 'Pause queue'}
              </button>
            </div>
            {update.isSuccess && <span className="muted">Saved.</span>}
          </div>
        </div>

        <SchedulesPanel queueId={queueId!} />
      </div>
    </div>
  );
}

function SchedulesPanel({ queueId }: { queueId: string }) {
  const { data } = useSchedules(queueId);
  const create = useCreateSchedule(queueId);
  const toggle = useToggleSchedule(queueId);
  const del = useDeleteSchedule(queueId);
  const [name, setName] = useState('');
  const [cron, setCron] = useState('*/5 * * * *');

  return (
    <div className="panel">
      <strong>Cron schedules</strong>
      <form
        className="toolbar"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && cron.trim())
            create.mutate({ name: name.trim(), cronExpression: cron.trim(), payload: { type: 'echo' } }, { onSuccess: () => setName('') });
        }}
      >
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 110 }} />
        <input placeholder="cron" className="mono" value={cron} onChange={(e) => setCron(e.target.value)} style={{ width: 120 }} />
        <button className="primary" disabled={create.isPending}>
          Add
        </button>
      </form>
      {create.error && <p className="error">{(create.error as Error).message}</p>}
      <table>
        <tbody>
          {(data?.data ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td className="mono">{s.cron_expression}</td>
              <td>{s.is_active ? <StatusBadge status="active" /> : <StatusBadge status="cancelled" />}</td>
              <td className="muted">{fmt(s.next_run_at)}</td>
              <td className="row">
                <button onClick={() => toggle.mutate({ id: s.id, isActive: !s.is_active })}>{s.is_active ? 'Pause' : 'Resume'}</button>
                <button className="danger" onClick={() => del.mutate(s.id)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {(data?.data ?? []).length === 0 && (
            <tr>
              <td className="muted">No schedules.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
