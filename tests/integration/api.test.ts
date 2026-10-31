import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { sha256Hex } from '../../src/api/intake.js';
import { LocalMockAdapter } from '../../src/adapters/localMockAdapter.js';
import { InMemorySideEffectSink } from '../../src/adapters/sideEffects.js';
import { JobStore, LOCK_FILE } from '../../src/persistence/jobStore.js';
import { cleanupTempDirs, makeHarness, ScriptedAdapter, syntheticEvent, webhookHeaders } from '../support/harness.js';

afterEach(cleanupTempDirs);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('webhook API', () => {
  it('T-API-01 accepts a valid event and persists it before responding 202', async () => {
    const h = await makeHarness();
    const res = await h.post(syntheticEvent(), 'api-key-000000000001', 'corr-api-0001');
    expect(res.statusCode).toBe(202);
    const body = res.json<{ jobId: string; state: string; created: boolean; correlationId: string }>();
    expect(body).toMatchObject({ state: 'READY', created: true, correlationId: 'corr-api-0001' });
    expect(body.jobId).toMatch(UUID);

    const fresh = await JobStore.open({ runtimeDir: h.dir, clock: h.clock, logger: h.logs.logger, staleLockMs: 30_000, lockAcquireTimeoutMs: 2000 });
    expect(fresh.get(body.jobId)?.state).toBe('READY');
  });

  it('T-API-02 returns 503 and never 202 when persistence fails', async () => {
    const h = await makeHarness();
    const app = buildApp({
      store: h.store, config: h.config, clock: h.clock, logger: h.logs.logger,
      intake: async () => {
        throw new Error('EIO: disk write failed at /secret/runtime/jobs.journal.jsonl');
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/events', headers: webhookHeaders('api-key-000000000002'), payload: JSON.stringify(syntheticEvent()) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } });
    expect(res.body).not.toContain('/secret/');
    expect(h.store.list()).toHaveLength(0);

    // Real failure path: another process holds a fresh journal lock longer than LOCK_ACQUIRE_TIMEOUT_MS.
    const busy = await makeHarness({ config: { lockAcquireTimeoutMs: 40 } });
    await writeFile(join(busy.dir, LOCK_FILE), JSON.stringify({ pid: 999_999, acquiredAt: busy.clock.now().toISOString(), token: 'foreign' }));
    const timedOut = await busy.post(syntheticEvent(), 'api-key-000000000022');
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json()).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } });
    await rm(join(busy.dir, LOCK_FILE));
    await busy.store.refresh();
    expect(busy.store.list()).toHaveLength(0);
  });

  it('T-API-03 rejects schema violations with paths and codes only', async () => {
    const h = await makeHarness();
    const cases: Array<[unknown, string]> = [
      [{ ...syntheticEvent(), extra: 'top-level-value' }, 'extra'],
      [{ ...syntheticEvent(), data: { ...syntheticEvent().data, nested: 'nested-value' } }, 'data.nested'],
      [{ ...syntheticEvent(), data: { ...syntheticEvent().data, amountMinor: 'ten' } }, 'data.amountMinor'],
      [{ ...syntheticEvent(), source: 'real-production-system' }, 'source'],
    ];
    for (const [i, [payload, path]] of cases.entries()) {
      const res = await h.post(payload, `api-key-00000000003${i}`);
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; issues: Array<{ path: string; code: string }> } }>();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.issues.map((x) => x.path)).toContain(path);
      for (const secret of ['top-level-value', 'nested-value', 'ten', 'real-production-system']) expect(res.body).not.toContain(secret);
    }
    expect(h.store.list()).toHaveLength(0);
  });

  it('T-API-04 validates Idempotency-Key and X-Correlation-ID headers', async () => {
    const h = await makeHarness();
    const payload = JSON.stringify(syntheticEvent());
    const send = (headers: Record<string, string>) => h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers: { 'content-type': 'application/json', ...headers }, payload });
    const code = async (headers: Record<string, string>) => (await send(headers)).json<{ error: { code: string } }>().error.code;
    expect(await code({ 'idempotency-key': 'api-key-000000000004' })).toBe('MISSING_CORRELATION_ID');
    expect(await code({ 'idempotency-key': 'api-key-000000000004', 'x-correlation-id': 'bad id!' })).toBe('INVALID_CORRELATION_ID');
    expect(await code({ 'x-correlation-id': 'corr-api-0004' })).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(await code({ 'x-correlation-id': 'corr-api-0004', 'idempotency-key': 'short' })).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(h.store.list()).toHaveLength(0);
  });

  it('T-API-05 enforces body size, content type and JSON syntax', async () => {
    const h = await makeHarness();
    const headers = webhookHeaders('api-key-000000000005');
    const big = await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    const text = await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers: { ...headers, 'content-type': 'text/plain' }, payload: 'hello' });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    const bad = await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: '{"eventId":' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'INVALID_JSON' } });
  });

  it('T-API-06 duplicate delivery returns the original job and causes one side effect', async () => {
    const adapter = new ScriptedAdapter();
    const h = await makeHarness({ adapter });
    const event = syntheticEvent();
    const key = 'api-key-000000000006';
    const first = await h.post(event, key);
    const second = await h.post(JSON.parse(JSON.stringify(event)), key, 'corr-api-retry-02');
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ jobId: first.json<{ jobId: string }>().jobId, created: false });

    const journal = await h.journalText();
    expect(journal.match(/"type":"JOB_RECEIVED"/g)).toHaveLength(1);
    expect(journal).not.toContain(key);
    expect(journal).toContain(sha256Hex(key));

    await h.cycle();
    const third = await h.post(event, key);
    expect(third.json()).toMatchObject({ created: false, state: 'SUCCEEDED' });
    await h.cycle();
    expect(adapter.sideEffects.countFor(first.json<{ jobId: string }>().jobId)).toBe(1);
  });

  it('T-API-07 rejects idempotency key reuse with a different body', async () => {
    const h = await makeHarness();
    await h.post(syntheticEvent(), 'api-key-000000000007');
    const res = await h.post(syntheticEvent(), 'api-key-000000000007');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_CONFLICT' } });
    expect(h.store.list()).toHaveLength(1);
  });

  it('T-API-08 job view exposes a safe summary only', async () => {
    const h = await makeHarness();
    const event = syntheticEvent({ note: 'synthetic note text', referenceId: 'SYN-777777' });
    const { jobId } = (await h.post(event, 'api-key-000000000008')).json<{ jobId: string }>();
    const res = await h.app.inject({ method: 'GET', url: `/v1/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(
      ['attempt', 'correlationId', 'eventType', 'failureCategory', 'jobId', 'lastFailureCategory', 'maxAttempts', 'nextAttemptAt',
        'receivedAt', 'replayOf', 'replayedAs', 'state', 'steps', 'updatedAt'].sort(),
    );
    for (const s of ['SYN-777777', 'synthetic note text', event.eventId, 'amountMinor', 'idempotency']) expect(res.body).not.toContain(s);
    expect((await h.app.inject({ method: 'GET', url: '/v1/jobs/33333333-3333-4333-8333-333333333333' })).json()).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
    const invalid = await h.app.inject({ method: 'GET', url: '/v1/jobs/not-a-uuid' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_JOB_ID' } });
  });

  it('T-API-09 health endpoint returns status only', async () => {
    const h = await makeHarness();
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('T-API-10 error responses never leak paths, stacks or journal content', async () => {
    const h = await makeHarness();
    await h.post(syntheticEvent(), 'api-key-000000000010');
    const failing = buildApp({ store: h.store, config: h.config, clock: h.clock, logger: h.logs.logger, intake: async () => { throw new Error(`boom at ${h.dir}`); } });
    const headers = webhookHeaders('api-key-000000000011');
    const responses = [
      await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: '{bad json' }),
      await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: JSON.stringify({ pad: 'y'.repeat(20_000) }) }),
      await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers: { ...headers, 'content-type': 'text/plain' }, payload: 'x' }),
      await h.app.inject({ method: 'GET', url: '/nope' }),
      await h.post({ nope: true }, 'api-key-000000000012'),
      await failing.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: JSON.stringify(syntheticEvent()) }),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      for (const leak of [h.dir, 'stack', '    at ', '"seq"', 'jobs.journal', 'boom']) expect(res.body).not.toContain(leak);
    }
  });

  it('T-API-11 clients cannot steer retries, delays, states, paths or adapters', async () => {
    const sink = new InMemorySideEffectSink();
    const h = await makeHarness({ config: { mockScenariosEnabled: false } });
    h.adapter = new LocalMockAdapter({ sink, clock: h.clock, scenariosEnabled: false });
    const fields = { maxAttempts: 99, state: 'SUCCEEDED', delayMs: 0, adapter: 'remote-http', runtimeDir: '/tmp/x' };
    for (const [i, [k, v]] of Object.entries(fields).entries()) {
      const res = await h.post({ ...syntheticEvent(), [k]: v }, `api-key-00000000013${i}`);
      expect(res.statusCode).toBe(400);
    }
    const res = await h.post(syntheticEvent({ demoOutcome: 'permanent' }), 'api-key-000000000014');
    expect(res.statusCode).toBe(202);
    await h.cycle();
    expect(h.store.get(res.json<{ jobId: string }>().jobId)?.state).toBe('SUCCEEDED');
    expect(sink.entries).toHaveLength(1);
  });
});
