import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useProjects, useCreateProject } from '../api/hooks';
import { Spinner, ErrorMsg, fmt } from '../components';

export function ProjectsPage() {
  const { data, isLoading, error } = useProjects();
  const create = useCreateProject();
  const [name, setName] = useState('');

  if (isLoading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;

  return (
    <div>
      <h1 className="page-title">Projects</h1>
      <p className="page-sub">Projects own queues. Pick one to manage its queues.</p>

      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate(name.trim(), { onSuccess: () => setName('') });
        }}
      >
        <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={create.isPending}>
          Create project
        </button>
        {create.error && <span className="error">{(create.error as Error).message}</span>}
      </form>

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data!.data.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="muted">{fmt(p.created_at)}</td>
                <td>
                  <Link to={`/projects/${p.id}/queues`}>Queues →</Link>
                </td>
              </tr>
            ))}
            {data!.data.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No projects yet. Create one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
