import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DestinationStream } from 'pino';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { InMemorySideEffectSink } from '../../src/adapters/sideEffects.js';
import type { IntegrationAdapter, StepContext } from '../../src/adapters/types.js';
import { buildConfig, type AppConfig, type ConfigInput } from '../../src/config.js';
import type { StepOutcome } from '../../src/domain/classification.js';
import { ManualClock } from '../../src/domain/clock.js';
import type { SyntheticEvent } from '../../src/domain/event.js';
import type { StepName } from '../../src/domain/types.js';
import { createLogger, type AppLogger } from '../../src/observability/logger.js';
import { DeadLetterJournal } from '../../src/persistence/deadLetterJournal.js';
import { JobStore, JOBS_JOURNAL } from '../../src/persistence/jobStore.js';
import { runWorkerCycle, type CycleSummary } from '../../src/worker/worker.js';

const tempDirs: string[] = [];

export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'diw-test-'));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export interface CapturedLogs {
  readonly logger: AppLogger;
  raw(): string;
  records(): Array<Record<string, unknown>>;
  byEvent(name: string): Array<Record<string, unknown>>;
}

export function captureLogs(): CapturedLogs {
  const chunks: string[] = [];
  const destination: DestinationStream = { write: (s: string) => void chunks.push(s) };
  const logger = createLogger({ level: 'debug', destination });
  const records = () =>
    chunks
      .join('')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, raw: () => chunks.join(''), records, byEvent: (n) => records().filter((r) => r['event'] === n) };
}

export function testConfig(runtimeDir: string, overrides: Partial<ConfigInput> = {}): AppConfig {
  return buildConfig({
    runtimeDir,
    maxAttempts: 4,
    jobTimeoutMs: 50,
    baseBackoffMs: 1000,
    maxBackoffMs: 30_000,
    staleLockMs: 30_000,
    lockAcquireTimeoutMs: 2000,
    workerBatchSize: 10,
    ...overrides,
  });
}

let eventCounter = 0;
export function syntheticEvent(overrides: Partial<SyntheticEvent['data']> = {}): SyntheticEvent {
  eventCounter += 1;
  return {
    eventId: `evt_SYNTH${String(eventCounter).padStart(6, '0')}`,
    type: 'synthetic.order.created',
    occurredAt: '2026-10-31T11:59:00.000Z',
    source: 'synthetic-demo',
    data: { referenceId: `SYN-${String(1000 + eventCounter)}`, amountMinor: 1250, currency: 'USD', ...overrides },
  };
}

export function webhookHeaders(key: string, correlationId = 'corr-test-0001'): Record<string, string> {
  return { 'content-type': 'application/json', 'idempotency-key': key, 'x-correlation-id': correlationId };
}

type Script = (ctx: StepContext) => StepOutcome | 'hang' | 'throw';

/** Test adapter with per-step scripts and call counters. Never touches the network. */
export class ScriptedAdapter implements IntegrationAdapter {
  readonly name = 'scripted-test';
  readonly calls: Record<StepName, number> = { normalize: 0, deliver: 0 };
  readonly signals: AbortSignal[] = [];
  readonly sideEffects = new InMemorySideEffectSink();

  constructor(public script: Partial<Record<StepName, Script>> = {}) {}

  async executeStep(ctx: StepContext): Promise<StepOutcome> {
    this.calls[ctx.step] += 1;
    this.signals.push(ctx.signal);
    const result = this.script[ctx.step]?.(ctx) ?? { kind: 'success' };
    if (result === 'throw') throw new Error('synthetic adapter failure SECRET-DETAIL at /internal/path');
    if (result === 'hang') {
      return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (result.kind === 'success' && ctx.step === 'deliver') {
      await this.sideEffects.record({ jobId: ctx.jobId, correlationId: ctx.correlationId, step: ctx.step, attempt: ctx.attempt, at: 'test' });
    }
    return result;
  }
}

export interface Harness {
  readonly dir: string;
  readonly clock: ManualClock;
  readonly config: AppConfig;
  readonly logs: CapturedLogs;
  store: JobStore;
  deadLetters: DeadLetterJournal;
  app: FastifyInstance;
  adapter: IntegrationAdapter;
  cycle(): Promise<CycleSummary>;
  /** Simulates a process restart: a brand-new store/app/journal reader over the same runtime dir. */
  restart(): Promise<void>;
  post(event: unknown, key: string, correlationId?: string): Promise<LightMyRequestResponse>;
  journalText(): Promise<string>;
}

export async function makeHarness(
  opts: { adapter?: IntegrationAdapter; config?: Partial<ConfigInput>; dir?: string; clock?: ManualClock } = {},
): Promise<Harness> {
  const dir = opts.dir ?? (await makeTempDir());
  const clock = opts.clock ?? new ManualClock();
  const config = testConfig(dir, opts.config);
  const logs = captureLogs();
  const open = () =>
    JobStore.open({ runtimeDir: dir, clock, logger: logs.logger, staleLockMs: config.staleLockMs, lockAcquireTimeoutMs: config.lockAcquireTimeoutMs });
  const h: Harness = {
    dir,
    clock,
    config,
    logs,
    store: await open(),
    deadLetters: new DeadLetterJournal(dir),
    app: undefined as unknown as FastifyInstance,
    adapter: opts.adapter ?? new ScriptedAdapter(),
    cycle: () => runWorkerCycle({ store: h.store, deadLetters: h.deadLetters, adapter: h.adapter, clock, config, logger: logs.logger }),
    restart: async () => {
      await h.app.close();
      h.store = await open();
      h.deadLetters = new DeadLetterJournal(dir);
      h.app = buildApp({ store: h.store, config, clock, logger: logs.logger });
    },
    post: (event, key, correlationId) =>
      h.app.inject({ method: 'POST', url: '/v1/webhooks/events', headers: webhookHeaders(key, correlationId), payload: JSON.stringify(event) }),
    journalText: () => readFile(join(dir, JOBS_JOURNAL), 'utf8'),
  };
  h.app = buildApp({ store: h.store, config, clock, logger: logs.logger });
  return h;
}
