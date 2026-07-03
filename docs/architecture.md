# Architecture

Codity is a Postgres-backed distributed job scheduler. Three independently scalable Node
services share one Postgres database (the single source of truth **and** the queue) plus a
`@codity/*` code core.

![Architecture diagram](../deliverables/architecture.png)

> Downloadable: [architecture.svg](../deliverables/architecture.svg) ·
> [architecture.png](../deliverables/architecture.png) · source
> [architecture.mmd](./architecture.mmd)

## Responsibilities

- **API** (Express, stateless, scalable) — auth, tenant-scoped CRUD for projects/queues/
  jobs, job submission (immediate/delayed/scheduled/cron/batch), stats/throughput for the
  dashboard. Never executes jobs.
- **Worker** (scale horizontally) — polls its queues with jitter, atomically claims jobs
  via `SELECT ... FOR UPDATE SKIP LOCKED`, respects per-queue concurrency + rate limits,
  executes jobs concurrently under an in-process semaphore, heartbeats to hold job locks,
  and drains in-flight work on SIGTERM.
- **Scheduler** (singleton sweep loop) — reaper (requeue/DLQ expired locks), promote retries
  + delayed jobs, fire due cron schedules, and resolve workflow dependencies.
- **Postgres** — durable state, the queue itself, and all history/observability.

## Why the reaper + promoters live in the scheduler

These are singleton, low-frequency sweeps that must not be duplicated across the
horizontally-scaled workers. Housing them in one scheduler process keeps "exactly-one
sweeper" simple; every step still uses `FOR UPDATE SKIP LOCKED`, so a brief overlap during a
deploy is harmless. (At larger scale this becomes a leader-elected job; see DESIGN.md.)

> Data model: see [er-diagram.md](./er-diagram.md). Engineering decisions: see
> [../DESIGN.md](../DESIGN.md).
