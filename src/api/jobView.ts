import type { Job } from '../domain/types.js';

/** Safe public projection of a job. Never includes the webhook payload or idempotency material. */
export interface JobView {
  jobId: string;
  state: Job['state'];
  attempt: number;
  maxAttempts: number;
  correlationId: string;
  eventType: Job['eventType'];
  receivedAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  failureCategory: Job['failureCategory'] | null;
  lastFailureCategory: Job['lastFailureCategory'] | null;
  steps: Job['steps'];
  replayOf: string | null;
  replayedAs: string | null;
}

export function toJobView(job: Job): JobView {
  return {
    jobId: job.jobId,
    state: job.state,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    correlationId: job.correlationId,
    eventType: job.eventType,
    receivedAt: job.receivedAt,
    updatedAt: job.updatedAt,
    nextAttemptAt: job.nextAttemptAt ?? null,
    failureCategory: job.failureCategory ?? null,
    lastFailureCategory: job.lastFailureCategory ?? null,
    steps: { ...job.steps },
    replayOf: job.replayOf ?? null,
    replayedAs: job.replayedAs ?? null,
  };
}
