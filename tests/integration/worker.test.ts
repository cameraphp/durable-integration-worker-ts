import { readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkerArgs } from '../../src/cli/args.js';
import { LocalMockAdapter } from '../../src/adapters/localMockAdapter.js';
import { InMemorySideEffectSink } from '../../src/adapters/sideEffects.js';
import { cleanupTempDirs, makeHarness, ScriptedAdapter, syntheticEvent, type Harness } from '../support/harness.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupTempDirs();
});

let keyCounter = 0;
async function submit(h: Harness, data: Parameters<typeof syntheticEvent>[0] = {}): Promise<string> {
  keyCounter += 1;
  const res = await h.post(syntheticEvent(data), `worker-key-${String(keyCounter).padStart(10, '0')}`, `corr-worker-${keyCounter}`);
  expect(res.statusCode).toBe(202);
  return res.json<{ jobId: string }>().jobId;
}

const state = (h: Harness, id: string) => h.store.get(id);
const plus = (h: Harness, ms: number) => new Date(h.clock.now().getTime() + ms).toISOString();

describe('worker', () => {
  it('T-WK-01 processes both steps and succeeds on the first attempt', async () => {
    const adapter = new ScriptedAdapter();
    const h = await makeHarness({ adapter });
    const id = await submit(h);
    const summary = await h.cycle();
    expect(summary).toMatchObject({ processed: 1, succeeded: 1 });
    expect(state(h, id)).toMatchObject({ state: 'SUCCEEDED', attempt: 1, steps: { normalize: 'SUCCEEDED', deliver: 'SUCCEEDED' } });
    expect(adapter.sideEffects.countFor(id)).toBe(1);
  });

  it('T-WK-02 transient failure schedules a bounded retry with deterministic backoff', async () => {
    const adapter = new ScriptedAdapter({ normalize: (c) => (c.attempt === 1 ? { kind: 'failure', hint: 'transient' } : { kind: 'success' }) });
    const h = await makeHarness({ adapter });
    const id = await submit(h);
    const due = plus(h, 1000);
    await h.cycle();
    expect(state(h, id)).toMatchObject({ state: 'RETRY_SCHEDULED', attempt: 1, failureCategory: 'TRANSIENT', nextAttemptAt: due });
    h.clock.advance(999);
    expect(await h.cycle()).toMatchObject({ promoted: 0, processed: 0 });
    expect(state(h, id)?.state).toBe('RETRY_SCHEDULED');
    h.clock.advance(1);
    expect(await h.cycle()).toMatchObject({ promoted: 1, processed: 1, succeeded: 1 });
    expect(state(h, id)).toMatchObject({ state: 'SUCCEEDED', attempt: 2, lastFailureCategory: 'TRANSIENT' });
  });

  it('T-WK-03 timeout aborts the step, is retryable and leaks nothing', async () => {
    const adapter = new ScriptedAdapter({ normalize: (c) => (c.attempt === 1 ? 'hang' : { kind: 'success' }) });
    const h = await makeHarness({ adapter, config: { jobTimeoutMs: 20 } });
    const id = await submit(h);
    await h.cycle();
    expect(state(h, id)).toMatchObject({ state: 'RETRY_SCHEDULED', failureCategory: 'TIMEOUT', attempt: 1 });
    expect(adapter.signals[0]?.aborted).toBe(true);
    const view = await h.app.inject({ method: 'GET', url: `/v1/jobs/${id}` });
    expect(view.json()).toMatchObject({ failureCategory: 'TIMEOUT' });
    for (const text of [h.logs.raw(), view.body, await h.journalText()]) {
      expect(text).not.toContain('stack');
      expect(text).not.toContain('aborted');
      expect(text).not.toContain('Error');
    }
    expect(h.logs.byEvent('step_failed')[0]).toMatchObject({ failureCategory: 'TIMEOUT', retryable: true, attempt: 1 });
  });

  it('T-WK-04 permanent failure dead-letters without retry', async () => {
    const adapter = new ScriptedAdapter({ deliver: () => ({ kind: 'failure', hint: 'rejected', status: 404 }) });
    const h = await makeHarness({ adapter });
    const id = await submit(h, { note: 'synthetic private-looking note' });
    expect(await h.cycle()).toMatchObject({ deadLettered: 1, retryScheduled: 0 });
    expect(state(h, id)).toMatchObject({ state: 'DEAD_LETTERED', attempt: 1, failureCategory: 'PERMANENT_CLIENT_4XX' });
    const lines = (await readFile(h.deadLetters.path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ jobId: id, failureCategory: 'PERMANENT_CLIENT_4XX', attempts: 1 });
    expect(lines[0]).not.toContain('private-looking');
    expect(lines[0]).not.toContain('referenceId');
    expect(adapter.calls.deliver).toBe(1);
  });

  it('T-WK-05 exhausting MAX_ATTEMPTS dead-letters with MAX_ATTEMPTS_EXCEEDED', async () => {
    const adapter = new ScriptedAdapter({ normalize: () => ({ kind: 'failure', hint: 'transient', status: 503 }) });
    const h = await makeHarness({ adapter, config: { maxAttempts: 3 } });
    const id = await submit(h);
    await h.cycle();
    expect(state(h, id)).toMatchObject({ state: 'RETRY_SCHEDULED', attempt: 1, nextAttemptAt: plus(h, 1000) });
    h.clock.advance(1000);
    await h.cycle();
    expect(state(h, id)).toMatchObject({ state: 'RETRY_SCHEDULED', attempt: 2, nextAttemptAt: plus(h, 2000) });
    h.clock.advance(2000);
    expect(await h.cycle()).toMatchObject({ deadLettered: 1 });
    expect(state(h, id)).toMatchObject({ state: 'DEAD_LETTERED', attempt: 3, failureCategory: 'MAX_ATTEMPTS_EXCEEDED', lastFailureCategory: 'UPSTREAM_5XX' });
    expect(adapter.calls.normalize).toBe(3);
  });

  it('T-WK-06 partial failure resumes only the unfinished step, across restart', async () => {
    const adapter = new ScriptedAdapter({ deliver: (c) => (c.attempt === 1 ? { kind: 'failure', hint: 'transient', status: 503 } : { kind: 'success' }) });
    const h = await makeHarness({ adapter });
    const id = await submit(h);
    await h.cycle();
    expect(state(h, id)).toMatchObject({ state: 'RETRY_SCHEDULED', steps: { normalize: 'SUCCEEDED', deliver: 'PENDING' } });
    await h.restart();
    expect(state(h, id)?.steps.normalize).toBe('SUCCEEDED');
    h.clock.advance(1000);
    await h.cycle();
    expect(state(h, id)).toMatchObject({ state: 'SUCCEEDED', attempt: 2 });
    expect(adapter.calls).toEqual({ normalize: 1, deliver: 2 });
    expect(h.logs.byEvent('step_skipped_already_completed')).toHaveLength(1);
  });

  it('T-WK-07 restart rebuilds jobs and the idempotency index from the journal', async () => {
    const adapter = new ScriptedAdapter({ normalize: (c) => (c.event.data.note === 'fail-once' && c.attempt === 1 ? { kind: 'failure', hint: 'transient' } : { kind: 'success' }) });
    const h = await makeHarness({ adapter, config: { workerBatchSize: 2 } });
    const event = syntheticEvent();
    const done = (await h.post(event, 'restart-key-000000001')).json<{ jobId: string }>().jobId;
    const retry = await submit(h, { note: 'fail-once' });
    await h.cycle();
    const pending = await submit(h);
    const before = new Map(h.store.list().map((j) => [j.jobId, j.state]));
    expect([...before.values()].sort()).toEqual(['READY', 'RETRY_SCHEDULED', 'SUCCEEDED']);

    await h.restart();
    expect(new Map(h.store.list().map((j) => [j.jobId, j.state]))).toEqual(before);
    for (const id of [done, retry, pending]) {
      expect((await h.app.inject({ method: 'GET', url: `/v1/jobs/${id}` })).statusCode).toBe(200);
    }
    const dup = await h.post(event, 'restart-key-000000001');
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ jobId: done, created: false, state: 'SUCCEEDED' });
  });

  it('T-WK-08 a retry-scheduled job keeps its schedule across restart', async () => {
    const adapter = new ScriptedAdapter({ normalize: (c) => (c.attempt === 1 ? { kind: 'failure', hint: 'transient', status: 429 } : { kind: 'success' }) });
    const h = await makeHarness({ adapter });
    const id = await submit(h);
    await h.cycle();
    const scheduled = state(h, id)?.nextAttemptAt;
    expect(state(h, id)).toMatchObject({ state: 'RETRY_SCHEDULED', failureCategory: 'RATE_LIMITED' });
    await h.restart();
    expect(state(h, id)?.nextAttemptAt).toBe(scheduled);
    h.clock.advance(999);
    expect(await h.cycle()).toMatchObject({ processed: 0 });
    h.clock.advance(1);
    expect(await h.cycle()).toMatchObject({ processed: 1, succeeded: 1 });
    expect(state(h, id)?.state).toBe('SUCCEEDED');
  });

  it('T-WK-09 dead-lettered jobs are never picked up by normal polling', async () => {
    const adapter = new ScriptedAdapter({ normalize: () => ({ kind: 'failure', hint: 'validation' }) });
    const h = await makeHarness({ adapter });
    const id = await submit(h);
    await h.cycle();
    expect(state(h, id)).toMatchObject({ state: 'DEAD_LETTERED', failureCategory: 'PERMANENT_VALIDATION' });
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(60_000);
      expect(await h.cycle()).toMatchObject({ processed: 0, promoted: 0 });
    }
    expect(adapter.calls.normalize).toBe(1);
    expect((await h.app.inject({ method: 'GET', url: `/v1/jobs/${id}` })).json()).toMatchObject({ state: 'DEAD_LETTERED' });
  });

  it('T-WK-10 recovers a job whose worker crashed mid-processing (expired lease)', async () => {
    for (const maxAttempts of [3, 1]) {
      const h = await makeHarness({ config: { maxAttempts } });
      const id = await submit(h);
      await h.store.withWriteLock(() =>
        h.store.append([{ type: 'JOB_TRANSITION', at: h.clock.now().toISOString(), jobId: id, from: 'READY', to: 'PROCESSING', attempt: 1, leaseExpiresAt: plus(h, 5000) }]),
      );
      await h.restart();
      h.clock.advance(4999);
      expect(await h.cycle()).toMatchObject({ recoveredStale: 0 });
      expect(state(h, id)?.state).toBe('PROCESSING');
      h.clock.advance(1);
      expect(await h.cycle()).toMatchObject({ recoveredStale: 1 });
      if (maxAttempts === 3) {
        expect(state(h, id)).toMatchObject({ state: 'RETRY_SCHEDULED', failureCategory: 'WORKER_INTERRUPTED', attempt: 1 });
      } else {
        expect(state(h, id)).toMatchObject({ state: 'DEAD_LETTERED', failureCategory: 'MAX_ATTEMPTS_EXCEEDED', lastFailureCategory: 'WORKER_INTERRUPTED' });
      }
    }
  });

  it('T-WK-11 reconciles a dead letter missing from the dead-letter journal', async () => {
    const h = await makeHarness({ adapter: new ScriptedAdapter({ deliver: () => ({ kind: 'failure', hint: 'rejected' }) }) });
    const id = await submit(h);
    await h.cycle();
    await rm(h.deadLetters.path);
    expect(await h.cycle()).toMatchObject({ reconciledDeadLetters: 1 });
    expect(await h.cycle()).toMatchObject({ reconciledDeadLetters: 0 });
    const lines = (await readFile(h.deadLetters.path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ jobId: id });
  });

  it('T-WK-12 an unexpected adapter throw is retryable ADAPTER_ERROR with no message persisted', async () => {
    const adapter = new ScriptedAdapter({ normalize: (c) => (c.attempt === 1 ? 'throw' : { kind: 'success' }) });
    const h = await makeHarness({ adapter });
    const id = await submit(h);
    await h.cycle();
    expect(state(h, id)).toMatchObject({ state: 'RETRY_SCHEDULED', failureCategory: 'ADAPTER_ERROR' });
    for (const text of [h.logs.raw(), await h.journalText()]) {
      expect(text).not.toContain('SECRET-DETAIL');
      expect(text).not.toContain('/internal/path');
      expect(text).not.toContain('stack');
    }
  });

  it('T-WK-13 worker CLI requires the explicit --once mode', () => {
    expect(parseWorkerArgs([])).toMatchObject({ ok: false });
    expect(parseWorkerArgs(['--loop'])).toMatchObject({ ok: false });
    expect(parseWorkerArgs(['--once'])).toEqual({ ok: true, value: { mode: 'once' } });
  });

  it('T-WK-14 the default local adapter needs no network', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access is not allowed');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const sink = new InMemorySideEffectSink();
    const h = await makeHarness();
    h.adapter = new LocalMockAdapter({ sink, clock: h.clock, scenariosEnabled: false });
    const id = await submit(h);
    await h.cycle();
    expect(state(h, id)?.state).toBe('SUCCEEDED');
    expect(sink.countFor(id)).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
