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
  shared/      # config, logger, errors, shared types        (later phases)
  api/         # Express REST API                            (Phase 4)
  worker/      # polling / claiming / execution              (Phase 3)
  scheduler/   # cron promotion + reaper                     (Phase 3/6)
frontend/      # React dashboard                             (Phase 7)
docs/          # architecture + ER diagrams
```

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

## Teardown

```bash
npm run db:down        # stop containers
docker compose down -v # also drop the Postgres volume (wipes data)
```
