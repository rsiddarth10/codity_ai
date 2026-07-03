import { NavLink, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './auth';

export function Spinner() {
  return (
    <div className="center">
      <div className="spinner" />
    </div>
  );
}

export function ErrorMsg({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return <p className="error">⚠ {message}</p>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status.replace('_', ' ')}</span>;
}

export function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="panel stat">
      <span className="label">{label}</span>
      <span className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </span>
    </div>
  );
}

export function Paginator({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <span className="muted">
        Page {page} of {Math.max(1, totalPages)}
      </span>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </div>
  );
}

export function fmt(dt: string | null | undefined): string {
  if (!dt) return '—';
  return new Date(dt).toLocaleString();
}

export function fmtRelative(dt: string | null | undefined): string {
  if (!dt) return '—';
  const diff = Date.now() - new Date(dt).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          Cod<span>ity</span>
        </div>
        <nav className="nav">
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/workers">Workers</NavLink>
        </nav>
        <div className="spacer" />
        <div className="muted" style={{ fontSize: 12 }}>
          {user?.email}
        </div>
        <button onClick={logout}>Log out</button>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
