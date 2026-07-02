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
