import type { IntegrationAdapter } from '../adapters/types.js';
import type { AppConfig } from '../config.js';
import { computeBackoffMs } from '../domain/backoff.js';
import { classify, type Classification } from '../domain/classification.js';
import type { Clock } from '../domain/clock.js';
import type { JobEvent } from '../domain/events.js';
import { STEP_NAMES, type Job } from '../domain/types.js';
import type { AppLogger } from '../observability/logger.js';
import { toDeadLetterRecord, type DeadLetterJournal } from '../persistence/deadLetterJournal.js';
import type { JobStore } from '../persistence/jobStore.js';
import { runStepWithTimeout } from './runStep.js';

export interface WorkerDeps {
  readonly store: JobStore;
  readonly deadLetters: DeadLetterJournal;
  readonly adapter: IntegrationAdapter;
  readonly clock: Clock;
  readonly config: AppConfig;
  readonly logger: AppLogger;
}

export interface CycleSummary {
  recoveredStale: number;
  promoted: number;
  processed: number;
  succeeded: number;
  retryScheduled: number;
  deadLettered: number;
  reconciledDeadLetters: number;
}

const LEASE_GRACE_MS = 1000;

function emptySummary(): CycleSummary {
  return { recoveredStale: 0, promoted: 0, processed: 0, succeeded: 0, retryScheduled: 0, deadLettered: 0, reconciledDeadLetters: 0 };
}

function jobLog(job: Job): { correlationId: string; jobId: string } {
  return { correlationId: job.correlationId, jobId: job.jobId };
}

/**
 * Builds the failure transition for a PROCESSING job: retry with deterministic backoff while
 * attempts remain, otherwise dead-letter. Retry limits are server-owned (job.maxAttempts).
 */
function failureTransition(job: Job, c: Classification, now: Date, config: AppConfig): JobEvent {
  const base = { type: 'JOB_TRANSITION' as const, at: now.toISOString(), jobId: job.jobId, from: 'PROCESSING' as const, attempt: job.attempt };
  if (c.retryable && job.attempt < job.maxAttempts) {
    const delayMs = computeBackoffMs(job.attempt, config.baseBackoffMs, config.maxBackoffMs);
    return { ...base, to: 'RETRY_SCHEDULED', failureCategory: c.category, nextAttemptAt: new Date(now.getTime() + delayMs).toISOString() };
  }
  if (c.retryable) {
    return { ...base, to: 'DEAD_LETTERED', failureCategory: 'MAX_ATTEMPTS_EXCEEDED', lastFailureCategory: c.category };
  }
  return { ...base, to: 'DEAD_LETTERED', failureCategory: c.category };
}

/** Appends a transition and, for dead letters, the sanitized dead-letter record. Caller holds the lock. */
async function commitOutcome(deps: WorkerDeps, event: JobEvent, summary: CycleSummary): Promise<void> {
  await deps.store.append([event]);
  if (event.type !== 'JOB_TRANSITION') return;
  const job = deps.store.get(event.jobId);
  if (!job) return;
  const log = { ...jobLog(job), attempt: job.attempt, state: job.state, failureCategory: job.failureCategory };
  if (job.state === 'SUCCEEDED') {
    summary.succeeded += 1;
    deps.logger.info({ ...log, event: 'job_succeeded' });
  } else if (job.state === 'RETRY_SCHEDULED') {
    summary.retryScheduled += 1;
    deps.logger.warn({ ...log, event: 'job_retry_scheduled', nextAttemptAt: job.nextAttemptAt });
  } else if (job.state === 'DEAD_LETTERED') {
    summary.deadLettered += 1;
    await deps.deadLetters.append(toDeadLetterRecord(job, event.at));
    deps.logger.error({ ...log, event: 'job_dead_lettered', lastFailureCategory: job.lastFailureCategory });
  }
}

/** Locked housekeeping: stale-lease recovery, due-retry promotion, dead-letter reconciliation. */
async function housekeeping(deps: WorkerDeps, summary: CycleSummary): Promise<void> {
  const { store, clock, config, logger } = deps;
  await store.withWriteLock(async () => {
    const now = clock.now();
    for (const job of store.list()) {
      if (job.state === 'PROCESSING' && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= now.getTime()) {
        summary.recoveredStale += 1;
        logger.warn({ ...jobLog(job), event: 'job_lease_expired_recovered', attempt: job.attempt, failureCategory: 'WORKER_INTERRUPTED' });
        await commitOutcome(deps, failureTransition(job, { category: 'WORKER_INTERRUPTED', retryable: true }, now, config), summary);
      }
    }
    for (const job of store.list()) {
      if (job.state === 'RETRY_SCHEDULED' && job.nextAttemptAt && Date.parse(job.nextAttemptAt) <= now.getTime()) {
        await store.append([{ type: 'JOB_TRANSITION', at: now.toISOString(), jobId: job.jobId, from: 'RETRY_SCHEDULED', to: 'READY', attempt: job.attempt }]);
        summary.promoted += 1;
        logger.info({ ...jobLog(job), event: 'job_retry_due', attempt: job.attempt, state: 'READY' });
      }
    }
    const recorded = await deps.deadLetters.recordedJobIds();
    for (const job of store.list()) {
      if (job.state === 'DEAD_LETTERED' && !recorded.has(job.jobId)) {
        await deps.deadLetters.append(toDeadLetterRecord(job, now.toISOString()));
        summary.reconciledDeadLetters += 1;
        logger.warn({ ...jobLog(job), event: 'dead_letter_reconciled', state: job.state, failureCategory: job.failureCategory });
      }
    }
  });
}

/** Claims the oldest READY job (READY -> PROCESSING with a lease), or returns undefined. */
async function claimNext(deps: WorkerDeps): Promise<Job | undefined> {
  const { store, clock, config, logger } = deps;
  return store.withWriteLock(async () => {
    const candidate = store
      .list()
      .filter((j) => j.state === 'READY')
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))[0];
    if (!candidate) return undefined;
    const now = clock.now();
    const pending = STEP_NAMES.filter((s) => candidate.steps[s] !== 'SUCCEEDED').length;
    const leaseMs = config.jobTimeoutMs * Math.max(pending, 1) + LEASE_GRACE_MS;
    await store.append([
      {
        type: 'JOB_TRANSITION',
        at: now.toISOString(),
        jobId: candidate.jobId,
        from: 'READY',
        to: 'PROCESSING',
        attempt: candidate.attempt + 1,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      },
    ]);
    const claimed = store.get(candidate.jobId);
    if (claimed) logger.info({ ...jobLog(claimed), event: 'job_claimed', attempt: claimed.attempt, state: claimed.state });
    return claimed;
  });
}

/** True if the job is still ours (same attempt, still PROCESSING). Caller holds the lock. */
function stillOwned(store: JobStore, job: Job): boolean {
  const current = store.get(job.jobId);
  return current?.state === 'PROCESSING' && current.attempt === job.attempt;
}

async function processJob(deps: WorkerDeps, claimed: Job, summary: CycleSummary): Promise<void> {
  const { store, adapter, clock, config, logger } = deps;
  summary.processed += 1;
  let failure: Classification | undefined;
  for (const step of STEP_NAMES) {
    const base = { ...jobLog(claimed), attempt: claimed.attempt, step };
    if (claimed.steps[step] === 'SUCCEEDED') {
      logger.info({ ...base, event: 'step_skipped_already_completed', state: 'PROCESSING' });
      continue;
    }
    logger.info({ ...base, event: 'step_started', state: 'PROCESSING' });
    const result = await runStepWithTimeout(
      adapter,
      { jobId: claimed.jobId, correlationId: claimed.correlationId, attempt: claimed.attempt, step, event: claimed.event },
      config.jobTimeoutMs,
    );
    if (result.kind === 'success') {
      const committed = await store.withWriteLock(async () => {
        if (!stillOwned(store, claimed)) return false;
        await store.append([{ type: 'STEP_SUCCEEDED', at: clock.now().toISOString(), jobId: claimed.jobId, step, attempt: claimed.attempt }]);
        return true;
      });
      if (!committed) {
        logger.warn({ ...base, event: 'job_lease_lost', state: store.get(claimed.jobId)?.state });
        return;
      }
      logger.info({ ...base, event: 'step_succeeded', state: 'PROCESSING' });
      continue;
    }
    failure = classify(result);
    logger.warn({ ...base, event: 'step_failed', failureCategory: failure.category, retryable: failure.retryable });
    break;
  }
  await store.withWriteLock(async () => {
    const job = store.get(claimed.jobId);
    if (!job || !stillOwned(store, claimed)) {
      logger.warn({ ...jobLog(claimed), event: 'job_lease_lost', attempt: claimed.attempt, state: job?.state });
      return;
    }
    const now = clock.now();
    const event: JobEvent = failure
      ? failureTransition(job, failure, now, config)
      : { type: 'JOB_TRANSITION', at: now.toISOString(), jobId: job.jobId, from: 'PROCESSING', to: 'SUCCEEDED', attempt: job.attempt };
    await commitOutcome(deps, event, summary);
  });
}

/**
 * One explicit worker cycle: housekeeping, then claim-and-process up to WORKER_BATCH_SIZE READY
 * jobs. DEAD_LETTERED and SUCCEEDED jobs are never selected.
 */
export async function runWorkerCycle(deps: WorkerDeps): Promise<CycleSummary> {
  const summary = emptySummary();
  await housekeeping(deps, summary);
  for (let i = 0; i < deps.config.workerBatchSize; i += 1) {
    const claimed = await claimNext(deps);
    if (!claimed) break;
    await processJob(deps, claimed, summary);
  }
  deps.logger.info({ event: 'worker_cycle_completed', ...summary });
  return summary;
}
