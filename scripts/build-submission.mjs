import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const b64 = (p) => readFileSync(path.join(root, p)).toString('base64');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const arch = b64('deliverables/architecture.png');
const er = b64('deliverables/er-diagram.png');

// The most important source files, embedded verbatim (accurate — read from disk).
const codeFiles = [
  { title: 'Database schema — the jobs table & the partial CLAIM index (migration 0005)', file: 'packages/db/migrations/0005_jobs_and_batches.cjs' },
  { title: 'THE claim query — atomic, no-double-claim, concurrency-safe (packages/core/src/claim.ts)', file: 'packages/core/src/claim.ts' },
  { title: 'Retry backoff calculator — fixed / linear / exponential + cap + jitter (packages/core/src/retry.ts)', file: 'packages/core/src/retry.ts' },
  { title: 'Worker engine — poll / claim / semaphore / heartbeat / graceful drain (packages/worker/src/engine.ts)', file: 'packages/worker/src/engine.ts' },
];
const codeSections = codeFiles
  .map((c) => `<h3 class="codehdr">${esc(c.title)}</h3>\n<pre><code>${esc(read(c.file))}</code></pre>`)
  .join('\n');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Codity — Submission</title>
<style>
  @page { size: A4; margin: 15mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.5 "Segoe UI", Arial, sans-serif; color: #1a1f2b; margin: 0; }
  h1 { font-size: 24pt; margin: 0 0 2px; color: #1b2a4a; }
  h1 span { color: #3563e9; }
  h2 { font-size: 15pt; color: #1b2a4a; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; margin: 26px 0 12px; }
  h3.codehdr { font-size: 10.5pt; color: #3563e9; margin: 18px 0 4px; }
  p { margin: 8px 0; }
  a { color: #3563e9; text-decoration: none; }
  .sub { color: #64748b; margin-top: 2px; }
  .links { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px 16px; margin: 16px 0; background: #f8fafc; }
  .links .row { margin: 6px 0; }
  .links .label { display: inline-block; width: 150px; color: #475569; font-weight: 600; }
  .blank { display: inline-block; border-bottom: 1px solid #94a3b8; min-width: 320px; color: #94a3b8; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 10pt; }
  th, td { border: 1px solid #d5dce6; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #eef2f9; }
  td.mark { text-align: center; font-weight: 700; width: 60px; }
  ul { margin: 8px 0; padding-left: 20px; }
  li { margin: 4px 0; }
  .crit { margin: 10px 0; }
  .crit b { color: #1b2a4a; }
  .pill { display: inline-block; background: #eef2f9; border: 1px solid #cbd5e1; border-radius: 999px; padding: 1px 9px; font-size: 8.5pt; margin-right: 5px; }
  img.diagram { width: 100%; border: 1px solid #e2e8f0; border-radius: 6px; margin: 6px 0; }
  pre { background: #0f1420; color: #e6e9ef; border-radius: 6px; padding: 10px 12px; overflow: hidden;
        white-space: pre-wrap; word-break: break-word; font: 7.4pt/1.35 "Consolas","Courier New",monospace; margin: 4px 0 14px; }
  code { font-family: inherit; }
  .page-break { page-break-before: always; }
  .foot { color: #94a3b8; font-size: 8.5pt; text-align: center; margin-top: 24px; }
</style></head>
<body>

<h1>Cod<span>ity</span> — Distributed Job Scheduling Platform</h1>
<div class="sub">Take-home assignment submission &nbsp;·&nbsp; Node.js + TypeScript + PostgreSQL</div>
<div class="sub">Submitted by <b>Siddarth</b> &nbsp;·&nbsp; rsiddarth69@gmail.com</div>

<div class="links">
  <div class="row"><span class="label">GitHub Repository</span> <a href="https://github.com/rsiddarth10/codity_ai">https://github.com/rsiddarth10/codity_ai</a></div>
  <div class="row"><span class="label">Deployed Application</span> <span class="blank">&nbsp;</span></div>
</div>

<h2>Overview</h2>
<p>Codity is a production-inspired distributed job scheduler where <b>PostgreSQL is both the system of
record and the queue</b>. Jobs are claimed atomically by a pool of horizontally-scalable workers using
<code>SELECT … FOR UPDATE SKIP LOCKED</code>, retried with configurable backoff, dead-lettered on
exhaustion, scheduled (delayed / cron / batch), gated by workflow dependencies, and fully observable
(per-attempt history, structured logs, lifecycle audit). It ships as a one-command Docker Compose stack:
API + worker pool + scheduler + Postgres + a React dashboard.</p>
<p>
  <span class="pill">TypeScript / Node 20</span><span class="pill">PostgreSQL 16</span>
  <span class="pill">pg + node-pg-migrate (raw SQL)</span><span class="pill">Express + zod + pino</span>
  <span class="pill">JWT + bcryptjs</span><span class="pill">cron-parser</span>
  <span class="pill">React + Vite + Recharts</span><span class="pill">Vitest</span><span class="pill">Docker Compose</span>
</p>

<h2>Deliverables</h2>
<table>
  <tr><th>Deliverable</th><th>Where it lives</th></tr>
  <tr><td>Source code + setup instructions</td><td>GitHub repo · README.md · setup section below</td></tr>
  <tr><td>Architecture diagram</td><td>Below · deliverables/architecture.svg &amp; .png</td></tr>
  <tr><td>ER diagram</td><td>Below · deliverables/er-diagram.svg &amp; .png</td></tr>
  <tr><td>API documentation</td><td>OpenAPI 3.0 (27 paths) · live Swagger UI at <code>GET /docs</code> · deliverables/openapi.json</td></tr>
  <tr><td>Design decisions document (trade-offs)</td><td>DESIGN.md (~4,900 words, written incrementally)</td></tr>
  <tr><td>Automated tests for critical functionality</td><td>test/ — 63 tests, 15 files, real dockerized Postgres</td></tr>
</table>

<h2>Evaluation criteria — how each is addressed</h2>
<table>
  <tr><th>Criteria</th><th class="mark">Marks</th><th>Coverage</th></tr>
  <tr><td><b>System Architecture</b></td><td class="mark">20</td><td>Monorepo of independently-scalable services (API / worker pool / scheduler / frontend) over a shared <code>@codity/*</code> core; Postgres as single source of truth + queue; clean layering (db = schema, core = data-access, services = thin entrypoints). See diagram.</td></tr>
  <tr><td><b>Database Design</b></td><td class="mark">20</td><td>Normalized 16-table schema, 10 reversible migrations; partial <b>claim index</b>; retry policy snapshotted onto each job; documented cascade / <code>SET NULL</code> behavior. See ER diagram + schema code.</td></tr>
  <tr><td><b>Backend Engineering</b></td><td class="mark">20</td><td>Raw, reviewable SQL data-access layer; Express REST API with zod validation, offset pagination, centralized structured errors, pino request logging; JWT auth with rotating hashed refresh tokens; RBAC.</td></tr>
  <tr><td><b>Reliability &amp; Concurrency</b></td><td class="mark">15</td><td><code>FOR UPDATE SKIP LOCKED</code> atomic claiming (<b>proven</b>: 500 jobs / 24 claimers → zero duplicates); per-queue advisory lock for exact concurrency + rate limits; heartbeats + reaper for crash recovery; graceful shutdown draining; retries → DLQ; all correctness paths in DB transactions.</td></tr>
  <tr><td><b>Frontend &amp; UX</b></td><td class="mark">10</td><td>React dashboard: queue health, job explorer (filter + paginate), job detail (timeline / attempts / logs), worker fleet, Dead Letter Queue with one-click retry, queue config, throughput charts; live polling.</td></tr>
  <tr><td><b>API Design</b></td><td class="mark">5</td><td>RESTful resource URLs + correct verbs/status codes; zod validation; consistent pagination + error envelope; OpenAPI 3.0 served at <code>/docs</code>.</td></tr>
  <tr><td><b>Documentation</b></td><td class="mark">5</td><td>DESIGN.md (incremental decisions + trade-offs), architecture + ER diagrams, OpenAPI spec, README, this document.</td></tr>
  <tr><td><b>Testing</b></td><td class="mark">5</td><td>63 automated tests on real dockerized Postgres: concurrency proof, crash recovery, retry/DLQ, scheduling, dependencies, RBAC, rate limiting, full API.</td></tr>
</table>

<div class="page-break"></div>
<h2>Architecture diagram</h2>
<img class="diagram" src="data:image/png;base64,${arch}" alt="Architecture" />

<h2>ER diagram (full schema)</h2>
<img class="diagram" src="data:image/png;base64,${er}" alt="ER diagram" />

<div class="page-break"></div>
<h2>Design decisions &amp; major trade-offs</h2>
<ul>
  <li><b>Postgres-as-queue, not a broker</b> — one transactional source of truth for state + history + queue; <code>SKIP LOCKED</code> gives correct multi-consumer claiming. Trade-off: lower ceiling than a dedicated broker at extreme rates (mitigation: queue sharding).</li>
  <li><b>Atomic claiming + exact limits</b> — <code>FOR UPDATE SKIP LOCKED</code> guarantees no double-claim; a per-queue transaction-scoped advisory lock makes the in-flight count exact so concurrency/rate limits can't be exceeded. Cost: claims for one queue serialize (sub-ms), execution stays fully concurrent.</li>
  <li><b>Retry policy snapshotted onto the job at enqueue</b> — retries are deterministic; editing a queue's policy never changes in-flight jobs.</li>
  <li><b>Enum-like columns are TEXT + CHECK</b> (not native ENUM) — adding a value is a cheap, reversible migration.</li>
  <li><b>Crash recovery via lock expiry</b> — heartbeats extend a per-job lock; the reaper requeues (or dead-letters) expired jobs. One mechanism covers hard crashes and hangs.</li>
  <li><b>Cron advances from now()</b> — a scheduler that was down fires once and moves on instead of backfilling a storm of missed runs.</li>
  <li><b>Workflow deps use a <code>blocked</code> status</b> — blocked jobs are invisible to the claim query, so the hot path + partial index stay untouched; cycles are impossible by construction.</li>
  <li><b>Hard-delete + CASCADE</b> for simplicity, with soft-delete noted as the production retention alternative.</li>
</ul>
<p>Full rationale for every decision is in <b>DESIGN.md</b> (§0–§8).</p>

<h2>Testing (what is proven, not asserted)</h2>
<ul>
  <li><b>Atomic claiming under real concurrency</b> — 500 jobs / 24 concurrent claimers → each claimed exactly once.</li>
  <li><b>SKIP LOCKED semantics</b> — a locked row is skipped, not blocked.</li>
  <li><b>Concurrency + rate limits</b> — never exceeded under load; pause/resume respected.</li>
  <li><b>Crash recovery</b> — a "dead" worker's job is requeued (or dead-lettered if exhausted); healthy heartbeats are left alone.</li>
  <li><b>Graceful shutdown</b> — in-flight jobs drain; nothing stuck in claimed/running.</li>
  <li><b>Retries → DLQ → manual revive</b>; backoff math (fixed/linear/exponential + cap + jitter).</li>
  <li><b>Scheduling</b> — cron next-run, delayed promotion, cron firing without double-fire, batch rollup.</li>
  <li><b>Workflow dependencies, RBAC, rate limiting, and the full REST API</b> (auth, tenant isolation, validation, pagination, idempotency).</li>
</ul>
<p>Run with <code>npm test</code> (spins up an isolated <code>codity_test</code> database automatically).</p>

<div class="page-break"></div>
<h2>Source code with setup</h2>
<p><b>Setup</b> — the full stack runs with one command:</p>
<pre><code>git clone https://github.com/rsiddarth10/codity_ai.git &amp;&amp; cd codity_ai
npm install
cp .env.example .env

# Whole stack (Postgres + API + worker + scheduler + dashboard):
docker compose up -d --build
npm run migrate:up            # apply the schema

#   API .......... http://localhost:4000        (Swagger UI at /docs)
#   Dashboard .... http://localhost:5173
# Scale workers:  docker compose up -d --scale worker=3

# Run the test suite (needs Postgres up):
npm test                      # 63 tests, real Postgres</code></pre>

<p>The most important source is embedded below (schema + claim query + retry backoff + worker engine).
The complete, runnable codebase — API, scheduler, React dashboard, all 15 test files — is on GitHub.</p>

${codeSections}

<div class="foot">Codity · full source, docs, and tests at https://github.com/rsiddarth10/codity_ai</div>
</body></html>`;

const out = path.join(root, 'deliverables', 'submission.html');
writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
