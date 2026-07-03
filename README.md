# Codity — Distributed Job Scheduling Platform

A production-inspired job scheduler built on **Node.js + TypeScript + PostgreSQL**, where
Postgres is both the system of record and the queue. Jobs are claimed atomically by a pool
of horizontally-scalable workers using `SELECT ... FOR UPDATE SKIP LOCKED`, retried with
configurable backoff, dead-lettered on exhaustion, and fully observable (per-attempt
history, logs, lifecycle audit).

> **Status:** built in phases. Phase 1 (database schema + migrations) is complete. See
> [DESIGN.md](./DESIGN.md) for decisions, [docs/architecture.md](./docs/architecture.md)
> for the system diagram, and [docs/er-diagram.md](./docs/er-diagram.md) for the schema.

## Repository layout

```
packages/
  db/          # pg connection pool + node-pg-migrate migrations (the schema)
  shared/      # env config (zod), pino logger, graceful shutdown
  core/        # data-access layer: enqueue, the claim query, lifecycle, reaper
  worker/      # worker engine: poll/claim/execute/heartbeat/graceful shutdown
  scheduler/   # singleton sweep loop: reaper + retry/delayed/cron promotion
  api/         # Express REST API: auth, projects, queues, jobs, OpenAPI
frontend/      # React dashboard                             (Phase 7)
docs/          # architecture + ER diagrams
scripts/       # demo-seed.ts and other dev utilities
```

## Run the worker & scheduler

```bash
npm run migrate:up                       # ensure schema exists

# Option A — via Docker (whole stack):
docker compose up -d --build worker scheduler
docker compose up -d --scale worker=3 worker   # scale workers horizontally

# Option B — locally (each in its own terminal):
npm start -w @codity/worker
npm start -w @codity/scheduler

# Enqueue some demo work and watch it get processed:
COUNT=20 npx tsx scripts/demo-seed.ts
```

The worker polls all non-paused queues (priority-ordered) unless `WORKER_QUEUES` is set,
runs up to `WORKER_CONCURRENCY` jobs at once, heartbeats to hold its job locks, and drains
in-flight jobs on `docker stop` / SIGTERM. The scheduler runs the reaper that requeues jobs
from crashed workers.

## Run the API

```bash
npm run migrate:up
npm start -w @codity/api          # or: docker compose up -d --build api
# API on http://localhost:4000 — Swagger UI at http://localhost:4000/docs
```

Quick end-to-end via HTTP:

```bash
# Sign up (returns accessToken + refreshToken)
curl -sX POST localhost:4000/api/v1/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"me@ex.com","password":"password123","organizationName":"Acme"}'

# Use the token for everything else:
TOKEN=...        # accessToken from the response
curl -sX POST localhost:4000/api/v1/projects -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"my-project"}'
```

All `/api/v1` routes except `/auth/*` require `Authorization: Bearer <accessToken>`, and
resources are isolated per organization. Full endpoint reference is at `/docs`.

## Prerequisites

- Node.js ≥ 20 and npm ≥ 10
- Docker + Docker Compose (for Postgres, and later the full stack)

## Setup

```bash
# 1. Install dependencies (npm workspaces)
npm install

# 2. Create your env file
cp .env.example .env

# 3. Start Postgres
npm run db:up          # docker compose up -d postgres

# 4. Apply the schema
npm run migrate:up
```

Postgres listens on `localhost:5432` (`codity` / `codity` / db `codity`). Adminer, a web DB
browser, is available at http://localhost:8080 once `docker compose up` is running.

## Migration commands

| Command | Effect |
| --- | --- |
| `npm run migrate:up` | Apply all pending migrations. |
| `npm run migrate:down` | Roll back the most recent migration. |
| `node packages/db/scripts/migrate.mjs down <n>` | Roll back `n` migrations. |
| `node packages/db/scripts/migrate.mjs redo` | Roll back one and re-apply it. |

## Verify Phase 1

```bash
# 16 tables expected (15 domain + pgmigrations)
docker exec codity-postgres psql -U codity -d codity -c "\dt"

# The all-important partial claim index should be present
docker exec codity-postgres psql -U codity -d codity \
  -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='jobs';"

# Prove reversibility: roll everything back and re-apply
node packages/db/scripts/migrate.mjs down 8
npm run migrate:up
```

## Run the tests

The suite runs against **real Postgres** (the brief requires it — not mocks). Vitest's
global setup auto-creates and migrates an isolated `codity_test` database, so you only need
the Postgres container running.

```bash
npm run db:up        # Postgres must be up
npm test             # vitest run
```

Phase 2 ships 13 tests including the grade-critical concurrency proofs:

- `test/claim.concurrency.test.ts` — 500 jobs, 24 concurrent claimers → **each job claimed exactly once** (zero duplicates, none lost).
- `test/concurrency-limit.test.ts` — the per-queue concurrency cap is never exceeded under 20 concurrent claimers.
- `test/skip-locked.test.ts` — `FOR UPDATE SKIP LOCKED` skips a locked row instead of blocking.
- `test/reaper.test.ts` — a job whose worker "died" mid-execution is requeued; a job with a fresh heartbeat is not.
- `test/lifecycle.test.ts` — full state-machine trail, execution/audit rows, idempotency, batch enqueue.
- `test/retry.unit.test.ts` — fixed/linear/exponential backoff math, cap, and equal-jitter bounds.
- `test/retry-dlq.test.ts` — retry-with-backoff → attempts exhausted → **Dead Letter Queue**, reaper dead-lettering, and DLQ list + manual retry over HTTP.
- `test/scheduling.test.ts` — cron next-run math, delayed-job promotion, cron firing (+ no double-fire), and batch rollup, plus the schedule/batch API.

## Teardown

```bash
npm run db:down        # stop containers
docker compose down -v # also drop the Postgres volume (wipes data)
```
