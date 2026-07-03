import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const API = 'http://localhost:4000';
const APP = 'http://localhost:5173';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.resolve('deliverables/screenshots');
mkdirSync(OUT, { recursive: true });

async function api(pathname, opts = {}, token) {
  const res = await fetch(API + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  const t = await res.text();
  const d = t ? JSON.parse(t) : null;
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${t}`);
  return d;
}

// ── 1. Auth (signup, or login if the demo user already exists) ──
const email = 'demo@codity.dev';
let auth;
try {
  auth = await api('/api/v1/auth/signup', { method: 'POST', body: JSON.stringify({ email, password: 'password123', organizationName: 'Acme Corp' }) });
} catch {
  auth = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'password123' }) });
}
const token = auth.accessToken;

// ── 2. Seed data ──
let project;
try {
  project = await api('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'Transactional Email' }) }, token);
} catch {
  const list = await api('/api/v1/projects?pageSize=100', {}, token);
  project = list.data.find((p) => p.name === 'Transactional Email') ?? list.data[0];
}
const projectId = project.id;

let policy;
try {
  policy = await api(`/api/v1/projects/${projectId}/retry-policies`, { method: 'POST', body: JSON.stringify({ name: 'expo', strategy: 'exponential', maxAttempts: 3, baseDelayMs: 800 }) }, token);
} catch { /* exists */ }

let queue;
try {
  queue = await api(`/api/v1/projects/${projectId}/queues`, { method: 'POST', body: JSON.stringify({ name: 'welcome-emails', concurrencyLimit: 4, retryPolicyId: policy?.id ?? null, rateLimitPerSec: 20 }) }, token);
} catch {
  const list = await api(`/api/v1/projects/${projectId}/queues`, {}, token);
  queue = list.data[0];
}
const queueId = queue.id;

for (let i = 0; i < 28; i++) {
  await api(`/api/v1/queues/${queueId}/jobs`, { method: 'POST', body: JSON.stringify({ payload: { type: 'echo', to: `user${i}@example.com` }, priority: i % 5 }) }, token);
}
for (let i = 0; i < 3; i++) {
  await api(`/api/v1/queues/${queueId}/jobs`, { method: 'POST', body: JSON.stringify({ payload: { type: 'fail', message: 'SMTP connection timed out' } }) }, token);
}
await api(`/api/v1/queues/${queueId}/jobs`, { method: 'POST', body: JSON.stringify({ payload: { type: 'echo' }, runAt: new Date(Date.now() + 3600e3).toISOString() }) }, token);
try {
  await api(`/api/v1/queues/${queueId}/schedules`, { method: 'POST', body: JSON.stringify({ name: 'daily-digest', cronExpression: '0 9 * * *', payload: { type: 'echo' } }) }, token);
} catch { /* exists */ }

// Let the workers + scheduler process (echo -> completed; fail -> retries -> DLQ).
console.log('seeded; waiting for processing...');
await new Promise((r) => setTimeout(r, 15000));

const completed = await api(`/api/v1/queues/${queueId}/jobs?status=completed&pageSize=1`, {}, token);
const completedJobId = completed.data[0]?.id;

// ── 3. Screenshot each page ──
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--window-size=1440,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

async function shot(route, name, { full = true, injectAuth = true, waitMs = 2200 } = {}) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    (v, on) => (on ? localStorage.setItem('codity.auth', v) : localStorage.removeItem('codity.auth')),
    JSON.stringify(auth),
    injectAuth,
  );
  await page.goto(`${APP}${route}`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, waitMs));
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
  console.log('shot', name);
}

await shot('/login', '01-login', { injectAuth: false, full: false });
await shot('/projects', '02-projects', {});
await shot(`/projects/${projectId}/queues`, '03-queues', {});
await shot(`/queues/${queueId}`, '04-queue-detail', {});
await shot(`/queues/${queueId}/jobs`, '05-jobs', {});
if (completedJobId) await shot(`/jobs/${completedJobId}`, '06-job-detail', {});
await shot('/workers', '07-workers', {});
await shot(`/queues/${queueId}/dead-letter`, '08-dead-letter', {});

await browser.close();
console.log('done ->', OUT);
