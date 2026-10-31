import type { JobEvent } from './events.js';
import { assertTransition } from './stateMachine.js';
import { STEP_NAMES, type Job, type StepName, type StepStatus } from './types.js';

export class ReducerError extends Error {
  readonly code = 'REDUCER_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'ReducerError';
  }
}

function initialSteps(carried: readonly StepName[] | undefined): Record<StepName, StepStatus> {
  const steps = Object.fromEntries(STEP_NAMES.map((s) => [s, 'PENDING'])) as Record<StepName, StepStatus>;
  for (const s of carried ?? []) steps[s] = 'SUCCEEDED';
  return steps;
}

function requireJob(jobs: ReadonlyMap<string, Job>, jobId: string): Job {
  const job = jobs.get(jobId);
  if (!job) throw new ReducerError(`event references unknown job`);
  return job;
}

/**
 * Pure, immutable reducer: returns a new Map with the event applied, or throws if the event is
 * inconsistent with current state (which callers treat as rejection or journal corruption).
 */
export function applyEvent(jobs: ReadonlyMap<string, Job>, e: JobEvent): Map<string, Job> {
  const next = new Map(jobs);
  switch (e.type) {
    case 'JOB_RECEIVED': {
      if (jobs.has(e.jobId)) throw new ReducerError('duplicate job id');
      next.set(e.jobId, {
        jobId: e.jobId,
        state: 'RECEIVED',
        attempt: 0,
        maxAttempts: e.maxAttempts,
        correlationId: e.correlationId,
        eventType: e.event.type,
        receivedAt: e.at,
        updatedAt: e.at,
        steps: initialSteps(e.carriedSteps),
        replayOf: e.replayOf,
        idempotencyKeyHash: e.idempotencyKeyHash,
        requestFingerprint: e.requestFingerprint,
        event: e.event,
      });
      return next;
    }
    case 'JOB_TRANSITION': {
      const job = requireJob(jobs, e.jobId);
      if (job.state !== e.from) throw new ReducerError(`transition from ${e.from} but job is ${job.state}`);
      assertTransition(e.from, e.to);
      if (e.to === 'PROCESSING' && e.attempt !== job.attempt + 1) throw new ReducerError('attempt must increment');
      if (e.to !== 'PROCESSING' && e.attempt !== job.attempt) throw new ReducerError('attempt changed outside PROCESSING');
      if (e.attempt > job.maxAttempts) throw new ReducerError('attempt exceeds maxAttempts');
      if (e.to === 'RETRY_SCHEDULED' && !e.nextAttemptAt) throw new ReducerError('retry requires nextAttemptAt');
      if (e.to === 'PROCESSING' && !e.leaseExpiresAt) throw new ReducerError('processing requires leaseExpiresAt');
      const failed = e.to === 'RETRY_SCHEDULED' || e.to === 'DEAD_LETTERED';
      if (failed && !e.failureCategory) throw new ReducerError('failure transition requires failureCategory');
      next.set(e.jobId, {
        ...job,
        state: e.to,
        attempt: e.attempt,
        updatedAt: e.at,
        nextAttemptAt: e.to === 'RETRY_SCHEDULED' ? e.nextAttemptAt : undefined,
        leaseExpiresAt: e.to === 'PROCESSING' ? e.leaseExpiresAt : undefined,
        failureCategory: failed ? e.failureCategory : undefined,
        lastFailureCategory: e.lastFailureCategory ?? e.failureCategory ?? job.lastFailureCategory,
      });
      return next;
    }
    case 'STEP_SUCCEEDED': {
      const job = requireJob(jobs, e.jobId);
      if (job.state !== 'PROCESSING') throw new ReducerError('step result for job not PROCESSING');
      if (e.attempt !== job.attempt) throw new ReducerError('step result for a different attempt');
      next.set(e.jobId, { ...job, updatedAt: e.at, steps: { ...job.steps, [e.step]: 'SUCCEEDED' } });
      return next;
    }
    case 'JOB_REPLAYED': {
      const job = requireJob(jobs, e.jobId);
      if (job.state !== 'DEAD_LETTERED') throw new ReducerError('only dead-lettered jobs can be replayed');
      if (job.replayedAs) throw new ReducerError('job already replayed');
      next.set(e.jobId, { ...job, replayedAs: e.replayJobId });
      return next;
    }
    case 'JOURNAL_TAIL_RECOVERED':
      return next;
  }
}
