import { useWorkers } from '../api/hooks';
import { Spinner, ErrorMsg, StatusBadge, fmtRelative } from '../components';

export function WorkersPage() {
  const { data, isLoading, error } = useWorkers();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;

  return (
    <div>
      <h1 className="page-title">Workers</h1>
      <p className="page-sub">Live fleet status (polls every 3s).</p>
      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Worker</th>
              <th>Status</th>
              <th>In-flight</th>
              <th>Capacity</th>
              <th>Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {data!.data.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>
                  <StatusBadge status={w.status} />
                </td>
                <td className="mono">{w.running_jobs}</td>
                <td className="mono">{w.concurrency}</td>
                <td className="muted">{fmtRelative(w.last_heartbeat)}</td>
              </tr>
            ))}
            {data!.data.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No workers registered. Start one with <span className="mono">npm start -w @codity/worker</span>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
