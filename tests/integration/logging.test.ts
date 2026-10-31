import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';
import { captureLogs, cleanupTempDirs, makeHarness, ScriptedAdapter, syntheticEvent, webhookHeaders } from '../support/harness.js';

afterEach(cleanupTempDirs);

describe('structured logging', () => {
  it('T-LOG-01 job-related records carry service, correlationId, jobId, event, attempt and state/failure', async () => {
    const adapter = new ScriptedAdapter({ deliver: (c) => (c.attempt === 1 ? { kind: 'failure', hint: 'transient', status: 502 } : { kind: 'success' }) });
    const h = await makeHarness({ adapter });
    const { jobId } = (await h.post(syntheticEvent(), 'log-key-00000000001', 'corr-log-0001')).json<{ jobId: string }>();
    await h.cycle();
    h.clock.advance(1000);
    await h.cycle();

    expect(h.logs.byEvent('webhook_accepted')[0]).toMatchObject({ service: 'durable-integration-worker', correlationId: 'corr-log-0001', jobId, state: 'READY' });
    for (const name of ['job_claimed', 'step_started', 'step_failed', 'job_retry_scheduled', 'job_retry_due', 'step_skipped_already_completed', 'job_succeeded']) {
      const rec = h.logs.byEvent(name)[0];
      expect(rec, name).toBeDefined();
      expect(rec).toMatchObject({ service: 'durable-integration-worker', correlationId: 'corr-log-0001', jobId });
      expect(typeof rec?.['attempt'], name).toBe('number');
      expect(rec?.['state'] ?? rec?.['failureCategory'], name).toBeDefined();
    }
    expect(h.logs.byEvent('step_failed')[0]).toMatchObject({ failureCategory: 'UPSTREAM_5XX', attempt: 1 });
    for (const rec of h.logs.records().filter((r) => 'jobId' in r)) {
      expect(rec['service']).toBe('durable-integration-worker');
      expect(rec['correlationId']).toBe('corr-log-0001');
    }
  });

  it('T-LOG-02 logs never contain payloads, keys, auth headers, emails, phones or stacks', async () => {
    const adapter = new ScriptedAdapter({ normalize: (c) => (c.attempt === 1 ? 'throw' : { kind: 'success' }) });
    const h = await makeHarness({ adapter });
    const key = 'log-secret-key-00000002';
    const event = syntheticEvent({ referenceId: 'SYN-55501234', note: 'Call me at +1 555-123-4567 or jane.doe@example.com' });
    const headers = { ...webhookHeaders(key, 'corr-log-0002'), authorization: 'Bearer synthetic-token-value-123' };
    await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: JSON.stringify(event) });
    await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: JSON.stringify(event) });
    await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: JSON.stringify({ ...event, extra: 'jane.doe@example.com' }) });
    await h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers, payload: '{broken' });
    await h.cycle();

    const raw = h.logs.raw();
    expect(raw.length).toBeGreaterThan(0);
    for (const forbidden of [key, 'Call me', 'jane.doe@example.com', '555-123-4567', 'synthetic-token-value-123', 'Bearer', 'SYN-55501234', event.eventId, '"stack"', 'SECRET-DETAIL']) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });

  it('T-LOG-03 sanitizer masks email and phone shapes in free-text fields', () => {
    const logs = captureLogs();
    logs.logger.info({ event: 'diagnostic', detail: 'reach a.b@example.org or +44 20 7946 0958', nextAttemptAt: '2026-10-31T12:00:01.000Z' });
    const rec = logs.byEvent('diagnostic')[0];
    expect(rec?.['detail']).toBe('reach [redacted-email] or [redacted-phone]');
    expect(rec?.['nextAttemptAt']).toBe('2026-10-31T12:00:01.000Z');
    expect(logs.raw()).not.toContain('a.b@example.org');
    expect(createLogger({ level: 'silent' }).level).toBe('silent');
  });
});
