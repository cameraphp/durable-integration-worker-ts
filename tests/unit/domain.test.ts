import { describe, expect, it } from 'vitest';
import { buildConfig, ConfigError, HOST, loadConfig } from '../../src/config.js';
import { computeBackoffMs } from '../../src/domain/backoff.js';
import { classify } from '../../src/domain/classification.js';
import type { JobEvent } from '../../src/domain/events.js';
import { applyEvent } from '../../src/domain/reducer.js';
import { ALLOWED_TRANSITIONS, assertTransition, InvalidTransitionError } from '../../src/domain/stateMachine.js';
import type { Job, JobState } from '../../src/domain/types.js';
import { syntheticEvent } from '../support/harness.js';

const JOB = '11111111-1111-4111-8111-111111111111';
const REPLAY = '22222222-2222-4222-8222-222222222222';
const t = (s: number) => new Date(Date.UTC(2026, 9, 31, 12, 0, s)).toISOString();

function fold(events: JobEvent[]): Job {
  let jobs = new Map<string, Job>();
  for (const e of events) jobs = applyEvent(jobs, e);
  const job = jobs.get(JOB);
  if (!job) throw new Error('missing');
  return job;
}

describe('state machine', () => {
  it('T-SM-01 accepts every allowed transition', () => {
    expect(ALLOWED_TRANSITIONS).toHaveLength(6);
    for (const [from, to] of ALLOWED_TRANSITIONS) expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('T-SM-02 rejects disallowed transitions', () => {
    const bad: Array<[JobState, JobState]> = [
      ['SUCCEEDED', 'READY'],
      ['DEAD_LETTERED', 'READY'],
      ['READY', 'SUCCEEDED'],
      ['RECEIVED', 'PROCESSING'],
      ['RETRY_SCHEDULED', 'PROCESSING'],
      ['DEAD_LETTERED', 'PROCESSING'],
    ];
    for (const [from, to] of bad) expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('T-SM-03 reducer folds an event sequence into the expected job view', () => {
    const base = { jobId: JOB };
    const received: JobEvent = {
      type: 'JOB_RECEIVED', at: t(0), ...base, correlationId: 'corr-unit-0001', idempotencyKeyHash: 'a'.repeat(64),
      requestFingerprint: 'b'.repeat(64), maxAttempts: 3, event: syntheticEvent(),
    };
    const job = fold([
      received,
      { type: 'JOB_TRANSITION', at: t(0), ...base, from: 'RECEIVED', to: 'READY', attempt: 0 },
      { type: 'JOB_TRANSITION', at: t(1), ...base, from: 'READY', to: 'PROCESSING', attempt: 1, leaseExpiresAt: t(9) },
      { type: 'STEP_SUCCEEDED', at: t(2), ...base, step: 'normalize', attempt: 1 },
      { type: 'JOB_TRANSITION', at: t(3), ...base, from: 'PROCESSING', to: 'RETRY_SCHEDULED', attempt: 1, failureCategory: 'UPSTREAM_5XX', nextAttemptAt: t(4) },
      { type: 'JOB_TRANSITION', at: t(4), ...base, from: 'RETRY_SCHEDULED', to: 'READY', attempt: 1 },
      { type: 'JOB_TRANSITION', at: t(5), ...base, from: 'READY', to: 'PROCESSING', attempt: 2, leaseExpiresAt: t(20) },
      { type: 'STEP_SUCCEEDED', at: t(6), ...base, step: 'deliver', attempt: 2 },
      { type: 'JOB_TRANSITION', at: t(7), ...base, from: 'PROCESSING', to: 'SUCCEEDED', attempt: 2 },
    ]);
    expect(job).toMatchObject({
      state: 'SUCCEEDED', attempt: 2, maxAttempts: 3, steps: { normalize: 'SUCCEEDED', deliver: 'SUCCEEDED' },
      lastFailureCategory: 'UPSTREAM_5XX', receivedAt: t(0), updatedAt: t(7),
    });
    expect(job.failureCategory).toBeUndefined();
    expect(job.nextAttemptAt).toBeUndefined();
    expect(job.leaseExpiresAt).toBeUndefined();

    const dead = fold([
      received,
      { type: 'JOB_TRANSITION', at: t(0), ...base, from: 'RECEIVED', to: 'READY', attempt: 0 },
      { type: 'JOB_TRANSITION', at: t(1), ...base, from: 'READY', to: 'PROCESSING', attempt: 1, leaseExpiresAt: t(9) },
      { type: 'JOB_TRANSITION', at: t(2), ...base, from: 'PROCESSING', to: 'DEAD_LETTERED', attempt: 1, failureCategory: 'PERMANENT_CLIENT_4XX' },
      { type: 'JOB_REPLAYED', at: t(3), ...base, replayJobId: REPLAY },
    ]);
    expect(dead).toMatchObject({ state: 'DEAD_LETTERED', failureCategory: 'PERMANENT_CLIENT_4XX', replayedAs: REPLAY });
  });
});

describe('backoff and classification', () => {
  it('T-BO-01 deterministic exponential backoff with cap', () => {
    expect([1, 2, 3, 4, 5].map((a) => computeBackoffMs(a, 1000, 8000))).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(() => computeBackoffMs(0, 1000, 8000)).toThrow(RangeError);
  });

  it('T-CL-01 classification table', () => {
    expect(classify({ kind: 'failure', hint: 'transient', status: 429 })).toEqual({ category: 'RATE_LIMITED', retryable: true });
    expect(classify({ kind: 'failure', hint: 'transient', status: 503 })).toEqual({ category: 'UPSTREAM_5XX', retryable: true });
    expect(classify({ kind: 'failure', hint: 'rejected', status: 404 })).toEqual({ category: 'PERMANENT_CLIENT_4XX', retryable: false });
    expect(classify({ kind: 'failure', hint: 'transient', status: 400 })).toEqual({ category: 'PERMANENT_CLIENT_4XX', retryable: false });
    expect(classify({ kind: 'failure', hint: 'rejected', status: 503 })).toEqual({ category: 'UPSTREAM_5XX', retryable: true });
    expect(classify({ kind: 'failure', hint: 'validation' })).toEqual({ category: 'PERMANENT_VALIDATION', retryable: false });
    expect(classify({ kind: 'failure', hint: 'transient' })).toEqual({ category: 'TRANSIENT', retryable: true });
    expect(classify({ kind: 'timeout' })).toEqual({ category: 'TIMEOUT', retryable: true });
    expect(classify({ kind: 'thrown' })).toEqual({ category: 'ADAPTER_ERROR', retryable: true });
  });
});

describe('configuration', () => {
  it('T-CFG-01 enforces server-owned bounds and loopback host', () => {
    expect(() => buildConfig({ maxAttempts: 0 })).toThrow(ConfigError);
    expect(() => buildConfig({ maxAttempts: 11 })).toThrow(ConfigError);
    expect(() => buildConfig({ baseBackoffMs: 5000, maxBackoffMs: 1000 })).toThrow(ConfigError);
    const defaults = loadConfig({});
    expect(defaults).toMatchObject({ port: 3000, maxAttempts: 4, jobTimeoutMs: 2000, mockScenariosEnabled: false, host: HOST });
    expect(loadConfig({ HOST: '0.0.0.0', MAX_ATTEMPTS: '2' })).toMatchObject({ host: '127.0.0.1', maxAttempts: 2 });
    expect(HOST).toBe('127.0.0.1');
  });
});
