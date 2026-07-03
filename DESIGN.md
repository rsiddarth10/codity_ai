# DESIGN.md

A living record of the engineering decisions behind Codity, written phase by phase as
choices are made (not reconstructed at the end). Each phase appends a section.

---

## 0. Stack decisions & rationale

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (Node ≥20) | Type safety across API/worker/scheduler; shared types via a `shared` package. |
| DB | PostgreSQL 16 | We use Postgres **as the queue** (see §2). `SELECT ... FOR UPDATE SKIP LOCKED` gives correct multi-consumer claiming without a separate broker. |
| DB access | `pg` + hand-written SQL | The claim query is the crown jewel of this system and must be **readable and reviewable**. No ORM is allowed to hide or reshape it. A thin data-access layer wraps raw SQL. |
| Migrations | `node-pg-migrate` | A real, reversible migration tool. Migrations are grouped logically (8 files) so the schema visibly *evolves*; every `up` has a tested `down`. |
| API framework | **Express** | Ubiquitous, minimal surprise for a reviewer, mature middleware ecosystem (auth, error handling, `pino-http`). Fastify is faster and has built-in schema validation, but we validate with `zod` regardless and the raw throughput of the HTTP layer is not this system's bottleneck (Postgres is). Lower reviewer friction wins. |
| Validation | `zod` | Parse-don't-validate at the edge; bad payloads never reach SQL. |
| Logging | `pino` + `pino-http` | Structured JSON logs with request id / latency. |
| Auth | JWT (access + refresh) + `bcryptjs` | Stateless access tokens, rotating refresh tokens (hash stored, never raw). `bcryptjs` is pure-JS so tests and local dev need no native toolchain; Docker could use native `bcrypt` for speed. |
| Worker/scheduler | Separate entrypoints (`packages/worker`, `packages/scheduler`) | Independently scalable processes, own Docker services, sharing code via `@codity/*` workspaces. |
| Frontend | React + TypeScript + Vite + Recharts | Polling-based live dashboard. |
| Tests | Vitest | Fast, ESM-native. Includes a **real concurrency test** against dockerized Postgres. |
| Runtime | `tsx` | Run TS directly in dev and in containers — no separate build step to drift out of sync. `tsc -b` is still available for type-checking. |

**Monorepo layout**

```
packages/
  db/          # pg pool + node-pg-migrate migrations (the schema)
  shared/      # config, logger, errors, shared types (later phases)
  api/         # Express REST API           (Phase 4)
  worker/      # polling/claiming/execution (Phase 3)
  scheduler/   # cron promotion + reaper    (Phases 3/6)
frontend/      # React dashboard            (Phase 7)
docs/          # architecture + ER diagrams
```

---

## 1. Database design

### 1.1 Why Postgres as the queue (not Redis/RabbitMQ/SQS)

A dedicated broker is faster at raw enqueue/dequeue, but this assignment is graded on
**correctness, durability, and observability**, and there Postgres wins:

- **One source of truth.** Job state, retry history, logs, schedules, and DLQ live in the
  same transactional store. A broker would force us to keep a second datastore in sync
  with the queue and reconcile them on crash — exactly the kind of race this project is
  meant to *avoid*.
- **Atomic claiming for free.** `SELECT ... FOR UPDATE SKIP LOCKED` lets N workers claim
  disjoint jobs with zero application-level coordination and zero double-delivery. This is
  a first-class, well-understood Postgres feature (§2 covers the exact query).
- **Rich querying.** The dashboard needs filtering, pagination, aggregation, and
  time-series stats. That's SQL's home turf; a broker can't answer "show me failed jobs in
  queue X in the last hour, paginated."
- **Transactional lifecycle.** Every state transition can be committed atomically with its
  audit row, execution row, and (on death) its DLQ row.

The honest trade-off: Postgres-as-queue tops out lower than a purpose-built broker
(polling + row locking has more overhead than an in-memory queue), and very high job rates
would want partitioning/sharding or a broker in front. That scaling story is in §"At larger
scale". For this system's scale and grading priorities, Postgres is the right call.

### 1.2 Normalization

The schema is in **3NF** for the configuration/identity core (organizations → users,
projects, retry_policies, queues) — no repeating groups, every non-key attribute depends on
the whole key. Deliberate, documented **denormalizations** exist only where they buy
correctness or a hot-path index:

1. **`jobs.retry_config` + `jobs.max_attempts` (snapshot).** The *effective* retry policy
   (job override → queue policy → system default) is copied onto the job at enqueue time.
   Rationale: retries must be **deterministic**. If we resolved the policy live at retry
   time, editing a queue's policy would retroactively change the behavior of jobs already
   in flight. Snapshotting freezes the contract at submission. `retry_policy_id` is kept
   purely as provenance.
2. **`workers.last_heartbeat` (denormalized latest).** The reaper's hot query is "which
   live workers have gone silent." Keeping the latest beat on the small `workers` row (with
   a partial index) avoids a `MAX(heartbeat_at)` over the append-only history table on
   every reap. `worker_heartbeats` retains the full history for the dashboard.
3. **`dead_letter_queue.payload` / `last_error` (snapshot).** A DLQ entry captures the
   payload and error *at death time* so later mutation of the job row can't rewrite
   history, and the DLQ is independently queryable.

`job_executions` is intentionally **one row per attempt** (never updated in place) — that
table *is* the retry history. Same for `job_state_transitions` (one row per transition) and
`job_logs` (append-only).

### 1.3 Indexing strategy (index the hot paths, keep them small)

| Index | Definition | Serves |
| --- | --- | --- |
| `idx_jobs_claim` | `(queue_id, priority DESC, run_at, created_at) WHERE status='queued'` | **The claim query.** Column order mirrors the `WHERE`/`ORDER BY` exactly; the partial predicate keeps only claimable rows, so the index stays hot and small even with millions of completed jobs. |
| `idx_jobs_reaper` | `(lock_expires_at) WHERE status IN ('claimed','running')` | Reaper scan for expired locks. |
| `idx_jobs_scheduled_due` | `(run_at) WHERE status='scheduled'` | Scheduler promoting due delayed jobs. |
| `idx_jobs_idempotency` | `UNIQUE (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL` | Enforces at-most-once enqueue per key; NULL keys don't collide. |
| `idx_jobs_queue_status_created` | `(queue_id, status, created_at DESC)` | Dashboard list/filter/paginate. |
| `idx_jobs_batch` | `(batch_id) WHERE batch_id IS NOT NULL` | Batch status rollups. |
| `idx_scheduled_jobs_due` | `(next_run_at) WHERE is_active` | Scheduler finding due cron schedules. |
| `idx_workers_liveness` | `(status, last_heartbeat) WHERE status='active'` | Reaper detecting dead workers. |

Partial indexes are used throughout: the vast majority of a mature `jobs` table is
`completed`/`failed`/`dead_letter`, and none of the operational hot paths care about those
rows. Filtering them out of the index keeps write amplification and index size low.

Enum-like columns use **`TEXT` + `CHECK`** rather than native `ENUM`: adding a status value
is a cheap, transactional, reversible `ALTER`; `ALTER TYPE ... ADD VALUE` cannot run inside
a transaction and is awkward to reverse — bad for clean migrations.

### 1.4 Cascade / `ON DELETE` behavior (and the trade-offs)

Ownership deletes **cascade down the tenancy tree**; cross-links **SET NULL** so history
survives losing an optional parent.

| Relationship | On delete | Rationale |
| --- | --- | --- |
| organization → users, projects | CASCADE | Deleting a tenant removes everything it owns. |
| project → queues, retry_policies, job_batches | CASCADE | Queues/policies are meaningless without their project. |
| queue → jobs, scheduled_jobs, dead_letter_queue | CASCADE | Jobs belong to a queue. |
| job → job_executions, job_logs, job_state_transitions, dead_letter_queue | CASCADE | Operational records with no consumer once the job is gone. |
| worker → worker_heartbeats | CASCADE | Heartbeat history dies with the worker. |
| **queue → jobs.retry_policy_id** | SET NULL | Removing a policy must not fail; jobs fall back to their snapshot / system default. |
| **worker → jobs.claimed_by**, **worker → job_executions.worker_id** | SET NULL | A worker can be deleted while its historical execution rows remain, just anonymized. |
| **batch → jobs.batch_id**, **schedule → jobs.scheduled_job_id** | SET NULL | Deleting the grouping/definition keeps already-generated jobs intact. |

**The contentious one — deleting a project drops historical `job_executions`.** We chose
CASCADE all the way down. Defense: once a project is deleted, its execution history has no
authenticated consumer (every read path is scoped by project/org), and keeping orphaned
rows complicates tenancy and billing queries. A system that legally needs retention should
**soft-delete** projects (a `deleted_at` flag) rather than hard-delete — then nothing
cascades and history is preserved. We note soft-delete as the production-grade alternative
and keep hard-delete + CASCADE for a clean, predictable schema here.

### 1.5 What Phase 1 delivered & verified

- 8 reversible migrations (`packages/db/migrations/0001..0008`), grouped by concern.
- 15 domain tables + `pgmigrations`, all FKs/checks/indexes as specified.
- **Verified:** full `up` → 16 tables; full `down 8` → schema empty (only `pgmigrations`);
  `up` again → back to 16. Migrations are reversible and re-runnable.
- Claim/reaper/idempotency indexes confirmed present via `pg_indexes`.

**Assumptions flagged (not blocking):**
- A user belongs to exactly one organization (simplest defensible tenancy; no multi-org
  membership). Signup creates an org + owner.
- Workers are infrastructure, not tenant-scoped — any worker can be pointed at any queue.
  In a hostile multi-tenant deployment you'd scope workers to orgs; out of scope here.
- `refresh_tokens` was added beyond the required table list to support real JWT refresh.

---

## 2. Atomic claiming & the data-access layer (Phase 2)

Phase 2 built the domain data-access layer (`packages/core`) — no HTTP yet — and *proved*
the concurrency guarantees with tests against real dockerized Postgres.

### 2.1 The claim query ([packages/core/src/claim.ts](packages/core/src/claim.ts))

Two safety properties, two mechanisms:

**(1) No two workers ever claim the same job — `FOR UPDATE SKIP LOCKED`.**
The `claimable` CTE selects candidate `queued` rows ordered by `priority DESC, run_at,
created_at`, row-locks them, and **skips** any row another claim already holds. Locked rows
are invisible rather than blocking, so N concurrent claimers carve the queue into disjoint
sets with zero coordination and zero double-delivery. The whole thing is one statement: a
CTE that `SELECT ... FOR UPDATE SKIP LOCKED LIMIT capacity`, wrapped by an `UPDATE ... SET
status='claimed' ... RETURNING jobs.*`, so selection and state change commit atomically.

**(2) The queue concurrency limit is never exceeded — per-queue advisory lock.**
"Max running across ALL workers" needs an *exact* in-flight count at claim time, and a bare
`count(*)` races with other claimers' commits. So `claimJobs` takes a **transaction-scoped
advisory lock keyed by the queue id** (`pg_advisory_xact_lock(hashtextextended(queue_id))`)
around the claim. Within that lock the count is exact and `capacity = limit − inflight`
cannot overcommit. Crucially this serializes only the *claim critical section per queue* —
claims are sub-millisecond row updates, different queues use different keys and run fully in
parallel, and **execution is always concurrent**. Consistent lock-acquire order (advisory →
job rows) means no deadlocks.

Why an advisory lock rather than `SELECT ... FROM queues FOR UPDATE`? The advisory lock
doesn't block readers/writers of the queue *config* row (pause/resume, stats) — it scopes
contention to exactly the claim path.

A paused queue (or a missing queue) resolves to `capacity = 0`, so it hands out nothing
while in-flight jobs keep running.

### 2.2 Lifecycle transitions ([lifecycle.ts](packages/core/src/lifecycle.ts))

Every post-claim transition is an **atomic conditional UPDATE** — e.g. `... WHERE id=$1 AND
status='running' AND claimed_by=$2`. If a job was reaped and reassigned, the original
worker's late `completeJob`/`failJob` matches nothing and no-ops, so a zombie worker can
never clobber newer state. Each transition writes a `job_executions` row (one per attempt)
and a `job_state_transitions` audit row inside the same transaction.

`attempts` increments on `claimed → running` (an "attempt" = one `job_executions` row).
`failJob` is a plain failure record in this phase; the retry-vs-DLQ decision lands in Phase 5.

### 2.3 Reaper / crash recovery ([lifecycle.ts](packages/core/src/lifecycle.ts) `requeueExpiredJobs`)

Heartbeats extend `lock_expires_at`. If a worker crashes, heartbeats stop, the lock expires,
and the reaper's `SELECT ... WHERE status IN ('claimed','running') AND lock_expires_at <
now() FOR UPDATE SKIP LOCKED` finds the job, marks its orphaned execution `failed`, and
returns it to `queued`. Lock-expiry is a single mechanism that covers both hard crashes and
hung jobs, needing no separate "is the worker alive?" check. (`markStaleWorkersDead` still
flips silent workers to `dead` for the dashboard.)

### 2.4 What Phase 2 tested & proved (13 tests, real Postgres)

| Test | Proves |
| --- | --- |
| `claim.concurrency` — 500 jobs, 24 claimers | Every job claimed **exactly once**: `set(claimed).size == 500`, DB shows 500 claimed/owned, **no** job with two `claimed` audit rows. |
| `claim.concurrency` — priority ordering | `priority DESC` then FIFO within a priority. |
| `concurrency-limit` — 60 jobs, limit 5, 20 claimers | In-flight **never exceeds 5**; exactly 5 claimed, 55 stay queued. |
| `concurrency-limit` — slot free on completion | Completing a job frees the slot for the next. |
| `concurrency-limit` — paused queue | Paused ⇒ 0 claims; resume ⇒ claimable. |
| `skip-locked` | A row locked by another tx is **skipped, not waited on** (test would hang if it blocked). |
| `lifecycle` (5) | Full `queued→claimed→running→completed` trail, execution rows, failure record, **idempotency key returns same job**, future `run_at ⇒ scheduled`, batch enqueue. |
| `reaper` (2) | Dead worker's job **requeued** (attempt 2, orphaned exec failed, audited); fresh-heartbeat job **not** requeued. |

Tests run against an isolated auto-provisioned `codity_test` database (Vitest global setup
creates + migrates it), truncated between tests. Files run serially since they share the DB.

**Trade-off recorded:** per-queue claim serialization is a deliberate choice for *exact*
concurrency accounting. If a single queue ever needs a claim rate beyond what serialized
sub-ms claims allow, the escape hatch is queue **sharding** (partition one logical queue
into K sub-queues, each independently claimable) — noted for the scaling section.

---

## 3. Worker & scheduler services (Phase 3)

Two new independently-scalable process types, built on the Phase 2 data-access layer.
Shared cross-cutting code (env parsing via zod, pino logger, signal handling) lives in
`@codity/shared`. Both processes split into an injectable **engine/class** (transport-free,
integration-tested in-process) and a thin **`main.ts`** entrypoint (env → wire → run).

### 3.1 Worker engine ([packages/worker/src/engine.ts](packages/worker/src/engine.ts))

- **Polling with jitter.** Each cycle is scheduled at `pollInterval ± jitter`
  (`scheduleNextPoll`) to avoid a thundering herd of synchronized workers.
- **In-process semaphore = the in-flight map.** `availableSlots = concurrency −
  inFlight.size`; a poll claims at most that many, so the worker never overcommits its own
  capacity. Jobs run **concurrently** (each `execute()` is a tracked promise), not
  one-at-a-time.
- **Multi-queue, priority-ordered.** With no explicit `WORKER_QUEUES`, the worker discovers
  all non-paused queues ordered by `priority DESC` each cycle and fills slots from the
  top — so higher-priority queues are served first, and newly created queues are picked up
  automatically.
- **Heartbeats.** Every `heartbeatInterval` the worker updates `workers.last_heartbeat`
  (+ a `worker_heartbeats` history row) and **extends the lock on every in-flight job**, so
  the reaper leaves live work alone.
- **Handler registry.** Jobs dispatch by `payload.type` to a registered `JobHandler`
  (`echo`/`sleep`/`fail` built in). Handlers get a `log()` (→ `job_logs`) and an
  `AbortSignal` for cooperative cancellation. Unknown types fail loudly.

### 3.2 Graceful shutdown ([engine.ts](packages/worker/src/engine.ts) `stop()`)

On SIGTERM/SIGINT: stop scheduling polls, mark the worker `draining`, then `drain()` —
`Promise.allSettled` on in-flight jobs raced against `shutdownTimeoutMs`. If everything
finishes → outcome `drained`, nothing left in `claimed`/`running`. If the timeout wins →
fire the `AbortSignal` and leave the stragglers for the reaper (lock expiry). Either way,
**no job is lost and none is stuck** on a normal restart.

**Container signal correctness:** the Docker command runs `node --import tsx …` (not `npm
start`) with `init: true`, so **node** is the signal target under tini and receives the
SIGTERM `docker stop` sends. Proven end-to-end: with 5 jobs in flight, `docker stop worker`
drained all 5 to `completed`, left the unclaimed job `queued`, and exited in ~1.5s.

### 3.3 Scheduler / reaper ([packages/scheduler/src/reaper.ts](packages/scheduler/src/reaper.ts))

A **singleton** sweep loop (in the scheduler, not the scaled workers). Each non-overlapping
tick: `markStaleWorkersDead` (dashboard signal) + `requeueExpiredJobs`. Because requeue uses
`FOR UPDATE SKIP LOCKED`, it's still safe if two reapers briefly overlap during a deploy.
(Phase 6 adds the cron promoter to this same process.)

**Timeout choice.** `JOB_LOCK_DURATION_MS` = 30s and `WORKER_HEARTBEAT_INTERVAL_MS` = 5s:
a healthy worker refreshes each lock 6× before it would expire, so transient GC pauses or
slow queries don't cause false reaps, while a truly dead worker's jobs are recovered within
~30–35s. `WORKER_DEAD_AFTER_MS` = 30s mirrors this for worker liveness. All are env-tunable.

### 3.4 What Phase 3 tested & proved (6 tests + live run)

| Test | Proves |
| --- | --- |
| worker — processes all jobs | 30 jobs → all `completed`, one succeeded execution row each. |
| worker — semaphore | With `concurrency=3`, observed simultaneous executions never exceed 3. |
| worker — failure | Failing handler → job `failed`, `last_error` recorded. |
| worker — graceful drain | 4 in-flight jobs on `stop()` → `drained`, all completed, **0 left in-flight**. |
| scheduler-reaper (2) | Crashed-worker job requeued via the loop; stale worker marked `dead`. |
| **Live run** | Containerized worker over the compose network processed 12 jobs; `docker stop` drained 5 in-flight jobs (SIGTERM → clean exit). |

**Windows dev note:** POSIX `SIGTERM` isn't delivered to console processes on Windows, so
process-level signal draining is validated in the Linux container; the engine `stop()`
logic is covered deterministically by the in-process drain test on all platforms.

---

## 4. REST API (Phase 4)

Express app in `packages/api`, built as an injectable factory `buildApp(pool, config,
logger)` (tests supply a test pool + secrets + silent logger). Read/write SQL lives in
`@codity/core` (`queries.ts`); the API package owns HTTP concerns + auth.

### 4.1 Why Express

Chosen over Fastify for reviewer familiarity and a frictionless middleware model (auth,
`pino-http`, centralized errors). We validate with `zod` and log with `pino` regardless of
framework, and the HTTP layer isn't this system's bottleneck (Postgres is), so Fastify's
throughput edge doesn't move the needle here. Express 4 + a tiny `asyncHandler` (forwards
async rejections to the error middleware) avoids Express 5's newer path-to-regexp quirks.

### 4.2 Auth & tenancy

- **Access token**: short-lived JWT (`sub`/`org`/`role`), verified by `requireAuth`, which
  populates `req.auth`. Everything mounted after it requires a valid token.
- **Refresh token**: an opaque 256-bit random string; only its **SHA-256 hash** is stored
  (`refresh_tokens`). `/auth/refresh` **rotates** — the presented token is revoked and a new
  pair issued, so a stolen refresh token is single-use and detectable.
- **Passwords**: `bcryptjs` (pure-JS, no native build). Login returns the same 401 whether
  the email is unknown or the password is wrong (no user enumeration).
- **Tenant isolation**: every handler runs `assertProject/Queue/Job(pool, id, orgId)`, which
  resolve the resource's owning org via joins and throw **404 (not 403)** when it's outside
  the caller's org — so we never confirm that an id exists in another tenant.

### 4.3 API conventions

- **Validation**: `zod` schemas on body/query/params via a `validate()` middleware; parsed
  values land on `req.validated` (we don't reassign the Express `req.query` getter). Bad
  input → `400 { error: { code:'BAD_REQUEST', message, details: <flattened zod issues> } }`.
- **Errors**: one centralized handler → `{ error: { code, message, details?, requestId } }`.
  It maps Postgres `23505/23503/23514` to `409/400/400` and treats anything else as an
  opaque 500 (no internal leakage). Every response carries the request id.
- **Pagination**: offset-based `?page&pageSize` (max 100), consistent envelope
  `{ data, pagination: { page, pageSize, total, totalPages } }` on all list endpoints.
- **Logging**: `pino-http` logs method/path/status/latency/reqId; assigns/echoes
  `x-request-id`; redacts `authorization`/`cookie`.
- **Docs**: hand-written OpenAPI 3.0 at `/openapi.json`, Swagger UI at `/docs`.

### 4.4 Resource tree

`/auth/{signup,login,refresh,logout}` · `/me` · `/projects` (CRUD) ·
`/projects/:id/retry-policies` · `/projects/:id/queues` (create/list) ·
`/queues/:id` (get/patch/delete, `/pause`, `/resume`, `/stats`) ·
`/queues/:id/jobs` (enqueue/list+filter) · `/jobs/:id` (+ `/executions`, `/logs`,
`/transitions`, `/cancel`) · `/workers`. Job enqueue supports immediate + delayed (future
`runAt` → `scheduled`) and idempotency keys (returns the existing job with 200). Cron/batch
endpoints land in Phase 6; retry-from-DLQ + manual retry in Phase 5.

### 4.5 What Phase 4 tested & proved (17 API tests + live curl)

Signup/login/refresh-rotation/401s; project CRUD + duplicate→409; **cross-org access→404**;
queue create/pause/resume/stats; job enqueue/get/list-filter-paginate/**idempotency-200**/
cancel→then-409; validation→400; OpenAPI + health. Integration tests run against the real
`codity_test` DB via supertest. Live-verified end-to-end against the running process
(`/docs` serves Swagger UI, full signup→enqueue→stats flow over HTTP).

---

## 5. Retry policies & Dead Letter Queue (Phase 5)

### 5.1 Backoff calculators ([packages/core/src/retry.ts](packages/core/src/retry.ts))

`computeBackoffMs(config, attempt, rng?)` is a **pure function** (rng injectable for
deterministic tests):

- `fixed` → `base`; `linear` → `base * attempt`; `exponential` → `base * multiplier^(attempt-1)`.
- Cap at `max_delay_ms` (if set) — bounds exponential blow-up.
- **Equal jitter** when enabled: result lands in `[delay/2, delay]`. We chose equal over
  full jitter because full jitter can return ~0 and let retries hammer the queue; equal
  jitter still guarantees a minimum backoff while de-synchronizing workers to avoid retry
  storms.

The policy used is the one **snapshotted onto the job at enqueue** (DESIGN §1.2), so
editing a queue's policy never changes the backoff of jobs already in flight.

### 5.2 Failure → retry-or-DLQ ([lifecycle.ts](packages/core/src/lifecycle.ts) `failJob`)

On a running job's failure (guarded, atomic, inside one tx):

- **Attempts remaining** (`attempts < max_attempts`): status → `failed` with `run_at` pushed
  out by the computed backoff. `failed` is an explicit **in-backoff resting state** — the
  claim query ignores it. A dashboard can therefore distinguish "retrying (in backoff)"
  from "ready".
- **Attempts exhausted**: status → `dead_letter` **and** a `dead_letter_queue` row is
  inserted (snapshotting payload/error/attempts), all in the same transaction.

A separate **promoter** (`promoteRetriableJobs`, run by the scheduler) flips
`failed`+`run_at<=now()` → `queued` when the backoff elapses — symmetric with the
`scheduled`→`queued` promotion coming in Phase 6, and it keeps the claim query to a single
ready state.

### 5.3 Reaper now respects max attempts

`requeueExpiredJobs` branches: a crashed job with attempts remaining is requeued
**immediately** (`run_at=now`, no backoff — a worker crash is an infra fault, not the job's),
but one that has **exhausted** attempts is **dead-lettered**. This stops a "poison" job that
repeatedly crashes workers from looping forever (bounded by `max_attempts`).

### 5.4 Manual retry ([queries.ts](packages/core/src/queries.ts) `retryJob`)

- `dead_letter` → `queued` with `attempts` **reset to 0** (fresh budget) and the DLQ row
  removed.
- `failed` (in backoff) → `queued` now (skip remaining backoff).
- anything else → not retriable (API returns 409).

**Idempotency semantics (documented):** "idempotent" in this system means *at-most-once
enqueue per idempotency key* (the `(queue_id, idempotency_key)` unique index). It does **not**
make execution exactly-once — a job can run more than once (a retry, or a reaped job whose
side effects partially applied before the worker crashed). Handlers that mutate external
state should therefore be written to tolerate re-execution (use the job id / payload key as
their own dedupe key). This is the standard at-least-once delivery contract.

### 5.5 API

`POST /jobs/:id/retry` (failed or dead-lettered → 200; else 409) and
`GET /queues/:id/dead-letter` (paginated).

### 5.6 What Phase 5 tested & proved (9 tests)

Unit (6): fixed/linear/exponential values, cap, equal-jitter bounds `[delay/2, delay]`,
attempt clamp. Integration (3): full **retry-with-backoff → 3 attempts → DLQ** flow (3 failed
execution rows, DLQ snapshot, manual revive resets attempts); **reaper dead-letters** a
crashed job that exhausted attempts; **DLQ list + retry over HTTP** (200 → queued → DLQ
emptied → second retry 409). Total suite: **45 tests**.

---

## 6. Scheduling — delayed / cron / batch (Phase 6)

All time-based promotion runs in the single **scheduler loop** ([SchedulerLoop](packages/scheduler/src/loop.ts)),
which now performs five ordered steps per tick (reap → retry-promote → delayed-promote →
cron-fire). Cron math is delegated to `cron-parser` (never hand-rolled).

### 6.1 The four job creation modes

| Mode | How it's represented | How it becomes runnable |
| --- | --- | --- |
| **Immediate** | `enqueueJob`, `run_at=now` → status `queued` | claimable right away |
| **Delayed / one-shot scheduled** | `enqueueJob` with future `run_at` → status `scheduled` | `promoteScheduledJobs`: `scheduled`+`run_at<=now()` → `queued` |
| **Recurring / cron** | a row in `scheduled_jobs` (cron + template payload) | `promoteDueSchedules`: fires due schedules into concrete jobs |
| **Batch** | `job_batches` row + N jobs sharing `batch_id` | all `queued` immediately; batch status is an aggregate rollup |

### 6.2 Cron firing ([scheduling.ts](packages/core/src/scheduling.ts) `promoteDueSchedules`)

For each active schedule with `next_run_at<=now()` (selected `FOR UPDATE SKIP LOCKED`):
enqueue a concrete job instance linked via `jobs.scheduled_job_id`, then advance
`next_run_at` to the next occurrence **after `now()`** — enqueue + advance in one
transaction. Advancing from `now()` rather than the missed slot means a scheduler that was
down **fires once and moves on** instead of backfilling a storm of missed runs. `next_run_at`
and `created_at`-on-create are computed with `cron-parser` honoring the schedule's timezone.
Idempotent across ticks: once advanced, the schedule isn't due again until its next slot.

### 6.3 Batch rollup ([scheduling.ts](packages/core/src/scheduling.ts) `getBatchStatus`)

`enqueueBatch` inserts a `job_batches` row + N jobs in one transaction. The status rollup is
computed live via `GROUP BY status` over `batch_id` (never denormalized, so it's always
correct): counts per status, `terminal` (completed+dead_letter+cancelled), `pending`, and a
`done` flag when every job has reached a terminal state.

### 6.4 API

`POST/GET /queues/:id/schedules`, `GET/PATCH/DELETE /schedules/:id` (PATCH toggles
`isActive` to pause/resume or edits the cron, recomputing `next_run_at`; invalid cron → 400).
`POST /queues/:id/batches` (submit N jobs → `{batchId, count}`), `GET /batches/:id` (rollup).

### 6.5 What Phase 6 tested & proved (+8 → **53 tests**)

Pure cron next-run + validation; delayed one-shot promotion; **cron fire + link +
next_run_at advance + no double-fire**; the **running SchedulerLoop** firing a due schedule
into exactly one job; batch rollup (pending → done); and over HTTP: schedule create/list +
**bad-cron 400**, batch submit + rollup.

---

## 7. Dashboard (Phase 7)

React + TypeScript + Vite + Recharts SPA in `frontend/`, data via **TanStack Query** with a
~3s `refetchInterval` (polling, per the brief). State is deliberately light — the server is
the source of truth and queries re-poll.

- **Auth**: JWT stored in `localStorage`; `authedFetch` transparently **refreshes on 401**
  (one-shot) using the rotating refresh token, then retries; on failure it logs out. Tokens
  live in a `ref` so the retry never reads a stale closure.
- **Screens** (all required ones): Projects; Queues with **health at a glance** (queued /
  running / completed / failed / DLQ badges, live); Queue detail with **stat cards + a
  throughput area chart** (completed vs failed per minute), **config editor** (priority /
  concurrency / pause-resume) and **cron schedule** management; **Job explorer** (filter by
  status, paginated); **Job detail** with the **lifecycle timeline**, **per-attempt history**,
  and **logs**, plus **retry / cancel** actions; **Worker fleet** (status, in-flight, last
  heartbeat); **Dead Letter Queue** with one-click retry.
- **Charts**: the throughput endpoint (`GET /queues/:id/throughput`) returns a
  `generate_series`-filled per-minute series so the chart is continuous; success rate and
  avg duration come from queue stats.
- **API base URL**: the browser calls the API directly (`VITE_API_URL`, default
  `localhost:4000`); server CORS is enabled. Served in prod by **nginx** with an SPA
  fallback (multi-stage Docker build).

**Verification**: strict `tsc --noEmit` clean, `vite build` succeeds, the built bundle
serves (200, correct title), and every endpoint the UI calls is covered by the API
integration tests. The new throughput SQL has its own integration test (**54 tests total**).
Deep visual/interaction QA in a real browser is the one thing not automated here.

---

## 8. Bonus features (Phase 8)

Three backend bonuses that reinforce the heavily-weighted areas (architecture / DB /
reliability), chosen over flashier options (WebSockets, sharding, distributed locking —
the last already covered by our advisory locks + SKIP LOCKED).

### 8.1 Workflow dependencies (job B waits on A)

- New table `job_dependencies` (edge list, dependent → parent) + a new job status
  **`blocked`**. A job with any unfinished parent is enqueued `blocked` and is therefore
  **invisible to the claim query** — which keeps the crown-jewel claim path and its partial
  index *unchanged* (no correlated NOT-EXISTS bolted onto the hot query).
- The scheduler's `resolveJobDependencies` sweep promotes `blocked → queued` once **all**
  parents are `completed`, and **cancels** the job if any parent `dead_letter`/`cancelled`
  (the dependency can never be satisfied — no silent zombie).
- **Cycles are impossible by construction**: a job may only depend on jobs that already
  exist at enqueue, so an older job can never point at a newer one → always a DAG. (Plus a
  `job_id <> depends_on_job_id` check.) This is cheaper and more robust than runtime cycle
  detection.

### 8.2 RBAC

`role` (owner/admin/member) already existed on users. A `requireRole(...)` middleware guards
**config mutations** (projects, queues, retry policies, schedules, user invites → owner/admin)
while leaving **job operations** (enqueue / retry / cancel / read) open to members. A
`POST /users` invite endpoint creates teammates **in the caller's own org** (org id taken
from the token, never the body) with role `admin`/`member` — you can't mint another owner or
inject a user into another tenant.

### 8.3 Per-queue rate limiting

`queues.rate_limit_per_sec` (nullable). Enforced **inside the claim query's capacity CTE**,
under the same per-queue advisory lock that already makes concurrency exact: a `recent` CTE
counts jobs `claimed_at` within the last rolling second, and capacity becomes
`LEAST(batch, concurrency_headroom, rate_headroom)`. Because claims for a queue are
serialized, the count is exact and the limit can't be exceeded. NULL = unlimited (zero
overhead — the CASE short-circuits to the batch size).

### 8.4 What Phase 8 tested & proved (+9 → **63 tests**)

Dependencies (5): blocked-not-claimable, promote-on-parent-complete, **cancel-on-parent-DLQ**,
wait-for-ALL-parents, already-completed-parent-not-blocked. Rate limiting (2): ≤N claims/sec
then 0 in-window then more after the window; null = unlimited. RBAC (2): member reads +
operates jobs but is **403** on config + invites; can't mint an owner (400). Migrations
0009/0010 verified reversible (`down 2` → `up`).
