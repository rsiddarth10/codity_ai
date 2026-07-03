# Deliverables — Codity Distributed Job Scheduler

This folder collects the gradable artifacts. Everything below is present in the repository;
this file maps each required deliverable to exactly where it lives.

## Checklist

| Required deliverable | Status | Where |
| --- | --- | --- |
| **Source code + setup instructions** | ✅ | Whole repo; setup in [`../README.md`](../README.md) (local + one-command Docker) |
| **Architecture diagram** (downloadable) | ✅ | [`architecture.svg`](./architecture.svg) · [`architecture.png`](./architecture.png) · source [`architecture.mmd`](./architecture.mmd) · doc [`../docs/architecture.md`](../docs/architecture.md) |
| **ER diagram** (downloadable) | ✅ | [`er-diagram.svg`](./er-diagram.svg) · [`er-diagram.png`](./er-diagram.png) · source [`er-diagram.mmd`](./er-diagram.mmd) · doc [`../docs/er-diagram.md`](../docs/er-diagram.md) |
| **API documentation** | ✅ | [`openapi.json`](./openapi.json) (OpenAPI 3.0, 27 paths); live Swagger UI at `GET /docs`; usage examples in [`../README.md`](../README.md) and below |
| **Design decisions document** (major trade-offs) | ✅ | [`../DESIGN.md`](../DESIGN.md) — written incrementally across all 8 phases |
| **Automated tests for critical functionality** | ✅ | [`../test/`](../test) — 63 tests, 15 files, against real dockerized Postgres (`npm test`) |

## What's in this folder

```
deliverables/
  DELIVERABLES.md      ← you are here
  architecture.svg     ← system diagram (vector, for docs)
  architecture.png     ← system diagram (raster)
  architecture.mmd     ← Mermaid source
  er-diagram.svg       ← full schema ER diagram (vector)
  er-diagram.png       ← full schema ER diagram (raster)
  er-diagram.mmd       ← Mermaid source
  openapi.json         ← exported OpenAPI 3.0 spec (import into Postman/Swagger)
```

Regenerate the images and spec anytime:

```bash
# diagrams (uses the mermaid-cli Docker image)
docker run --rm -v "$PWD:/data" minlag/mermaid-cli -i /data/docs/architecture.mmd -o /data/deliverables/architecture.svg -b white -s 2
docker run --rm -v "$PWD:/data" minlag/mermaid-cli -i /data/docs/er-diagram.mmd   -o /data/deliverables/er-diagram.svg   -b white -s 2
# OpenAPI spec
npx tsx scripts/export-openapi.ts
```

## Project map

```
packages/
  db/          pg pool + 10 node-pg-migrate migrations (the schema)
  shared/      env config (zod), pino logger, graceful shutdown
  core/        data-access: enqueue, THE claim query, lifecycle, retries, scheduling, deps
  worker/      worker engine: poll/claim/execute/heartbeat/graceful drain
  scheduler/   singleton sweep: reaper + retry/delayed/cron/dependency promotion
  api/         Express REST API: auth, projects, queues, jobs, schedules, batches, RBAC
frontend/      React + Vite + Recharts dashboard
docs/          architecture + ER diagrams (Mermaid)
test/          63 integration/unit tests (real Postgres)
```

## Setup (short)

```bash
npm install
cp .env.example .env
npm run db:up            # Postgres via Docker
npm run migrate:up       # apply schema
npm test                 # 63 tests
# run the stack:
docker compose up -d --build     # API :4000 (/docs), dashboard :5173, worker, scheduler
```

Full instructions, per-service run commands, and a demo walkthrough are in
[`../README.md`](../README.md).

## Test coverage (what's proven, not asserted)

- **Atomic claiming under real concurrency** — 500 jobs / 24 concurrent claimers → each
  claimed **exactly once** (`test/claim.concurrency.test.ts`).
- **`FOR UPDATE SKIP LOCKED` semantics** — a locked row is skipped, not blocked
  (`test/skip-locked.test.ts`).
- **Queue concurrency limit** never exceeded under load; pause/resume
  (`test/concurrency-limit.test.ts`).
- **Crash recovery** — a job whose worker "died" is requeued (or dead-lettered if
  exhausted); a healthy heartbeat is left alone (`test/reaper.test.ts`, `test/retry-dlq.test.ts`).
- **Worker engine** — processes all jobs, respects the in-process semaphore, graceful drain
  leaves nothing stuck (`test/worker.test.ts`).
- **Retries + DLQ** — backoff math (fixed/linear/exponential + cap + jitter), retry→DLQ→
  manual revive (`test/retry.unit.test.ts`, `test/retry-dlq.test.ts`).
- **Scheduling** — cron next-run, delayed promotion, cron firing without double-fire, batch
  rollup (`test/scheduling.test.ts`).
- **Workflow dependencies, RBAC, rate limiting** (`test/dependencies.test.ts`,
  `test/rbac.test.ts`, `test/rate-limit.test.ts`).
- **REST API** — auth flows, tenant isolation (cross-org → 404), validation, pagination,
  idempotency (`test/api.test.ts`).

## API usage examples

All `/api/v1` routes except `/auth/*` require `Authorization: Bearer <accessToken>`.

```bash
# 1. Sign up (creates org + owner, returns tokens)
curl -sX POST localhost:4000/api/v1/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"me@ex.com","password":"password123","organizationName":"Acme"}'

TOKEN=...   # accessToken from the response

# 2. Create a project and a queue
PID=$(curl -sX POST localhost:4000/api/v1/projects -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"my-project"}' | jq -r .id)
QID=$(curl -sX POST localhost:4000/api/v1/projects/$PID/queues -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"emails","concurrencyLimit":5,"rateLimitPerSec":10}' | jq -r .id)

# 3. Enqueue jobs
curl -sX POST localhost:4000/api/v1/queues/$QID/jobs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"payload":{"type":"echo"},"priority":5}'

# delayed job
curl -sX POST localhost:4000/api/v1/queues/$QID/jobs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"payload":{},"runAt":"2030-01-01T00:00:00Z"}'

# job B depends on job A (workflow)
curl -sX POST localhost:4000/api/v1/queues/$QID/jobs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"payload":{},"dependsOn":["<jobA-id>"]}'

# batch of jobs
curl -sX POST localhost:4000/api/v1/queues/$QID/batches -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"import","jobs":[{"payload":{"i":1}},{"payload":{"i":2}}]}'

# cron schedule
curl -sX POST localhost:4000/api/v1/queues/$QID/schedules -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"nightly","cronExpression":"0 0 * * *","payload":{"type":"echo"}}'

# 4. Observe
curl -s "localhost:4000/api/v1/queues/$QID/stats"      -H "Authorization: Bearer $TOKEN"
curl -s "localhost:4000/api/v1/queues/$QID/jobs?status=completed&page=1&pageSize=20" -H "Authorization: Bearer $TOKEN"
curl -s "localhost:4000/api/v1/queues/$QID/dead-letter" -H "Authorization: Bearer $TOKEN"
```
