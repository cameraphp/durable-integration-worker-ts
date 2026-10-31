// Local smoke walkthrough (validation ID SMK-01). Uses the BUILT CLI entry points, a temporary
// runtime directory under the OS temp folder, synthetic payloads, and only 127.0.0.1 requests.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeDir = mkdtempSync(join(tmpdir(), 'diw-smoke-'));
const port = await new Promise((resolve) => {
  const srv = createServer().listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PORT: String(port), RUNTIME_DIR: runtimeDir, MOCK_SCENARIOS_ENABLED: 'true',
  BASE_BACKOFF_MS: '60000', MAX_BACKOFF_MS: '600000', LOG_LEVEL: 'info',
};
const KEY_A = 'smoke-idem-key-A-0001';
const KEY_B = 'smoke-idem-key-B-0001';
let apiOutput = '';

function assert(cond, message) {
  if (!cond) throw new Error(`SMOKE FAIL: ${message}`);
  console.log(`  ok - ${message}`);
}

function event(n, demoOutcome) {
  return {
    eventId: `evt_SMOKE${String(n).padStart(6, '0')}`,
    type: 'synthetic.order.created',
    occurredAt: '2026-10-31T12:00:00.000Z',
    source: 'synthetic-demo',
    data: { referenceId: `SYN-${9000 + n}`, amountMinor: 4200, currency: 'USD', ...(demoOutcome ? { demoOutcome } : {}) },
  };
}

async function startApi() {
  const child = spawn(process.execPath, ['dist/cli/api.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (apiOutput += d));
  child.stderr.on('data', (d) => (apiOutput += d));
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return child;
    } catch {
      // not listening yet
    }
    await delay(50);
  }
  child.kill();
  throw new Error('SMOKE FAIL: API did not become healthy');
}

async function stopApi(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

const post = (body, key, corr) =>
  fetch(`${base}/v1/webhooks/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-correlation-id': corr },
    body: JSON.stringify(body),
  });
const getJob = async (id) => (await fetch(`${base}/v1/jobs/${id}`)).json();

try {
  console.log(`smoke: runtime dir in OS temp, API on 127.0.0.1:${port}`);
  let api = await startApi();

  const first = await post(event(1), KEY_A, 'corr-smoke-A');
  const a = await first.json();
  assert(first.status === 202 && a.created === true && a.state === 'READY', 'first delivery accepted with 202');
  const dup = await post(event(1), KEY_A, 'corr-smoke-A-retry');
  const d = await dup.json();
  assert(dup.status === 200 && d.jobId === a.jobId && d.created === false, 'duplicate returns the original job');
  const second = await post(event(2, 'transient_once'), KEY_B, 'corr-smoke-B');
  const b = await second.json();
  assert(second.status === 202, 'second (transient_once) event accepted');

  const worker = spawnSync(process.execPath, ['dist/cli/worker.js', '--once'], { cwd: root, env, encoding: 'utf8' });
  assert(worker.status === 0, 'worker --once exited 0');
  assert(/"event":"worker_cycle_completed"/.test(worker.stdout), 'worker emitted structured cycle summary');
  const noOnce = spawnSync(process.execPath, ['dist/cli/worker.js'], { cwd: root, env, encoding: 'utf8' });
  assert(noOnce.status === 2, 'worker without --once is refused');

  const jobA = await getJob(a.jobId);
  assert(jobA.state === 'SUCCEEDED' && jobA.attempt === 1, 'job A SUCCEEDED');
  const viewText = JSON.stringify(jobA);
  assert(!/referenceId|SYN-9001|evt_SMOKE|amountMinor|data/.test(viewText), 'job view exposes no payload fields');
  const jobB = await getJob(b.jobId);
  assert(jobB.state === 'RETRY_SCHEDULED' && jobB.failureCategory === 'UPSTREAM_5XX', 'job B RETRY_SCHEDULED (UPSTREAM_5XX)');

  await stopApi(api);
  api = await startApi();
  const jobB2 = await getJob(b.jobId);
  assert(jobB2.state === 'RETRY_SCHEDULED' && jobB2.nextAttemptAt === jobB.nextAttemptAt, 'restart preserves retry state and schedule');
  assert((await getJob(a.jobId)).state === 'SUCCEEDED', 'restart preserves completed job');
  const dupAfter = await (await post(event(1), KEY_A, 'corr-smoke-A-late')).json();
  assert(dupAfter.jobId === a.jobId && dupAfter.created === false, 'idempotency index survives restart');
  await stopApi(api);

  const effects = readFileSync(join(runtimeDir, 'mock-side-effects.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(effects.filter((e) => e.jobId === a.jobId).length === 1, 'exactly one mock side effect for job A');
  assert(!apiOutput.includes(KEY_A) && !apiOutput.includes(KEY_B), 'API logs contain no idempotency keys');
  assert(apiOutput.includes('"correlationId":"corr-smoke-A"'), 'API logs carry correlation IDs');
  assert(!existsSync(join(root, '.runtime')), 'no runtime data created inside the project');
  console.log('SMOKE OK');
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}
