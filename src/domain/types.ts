import type { SyntheticEvent } from './event.js';

export const JOB_STATES = ['RECEIVED', 'READY', 'PROCESSING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'DEAD_LETTERED'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Ordered two-step mock integration pipeline. */
export const STEP_NAMES = ['normalize', 'deliver'] as const;
export type StepName = (typeof STEP_NAMES)[number];
export type StepStatus = 'PENDING' | 'SUCCEEDED';

export const FAILURE_CATEGORIES = [
  'TIMEOUT',
  'TRANSIENT',
  'RATE_LIMITED',
  'UPSTREAM_5XX',
  'ADAPTER_ERROR',
  'WORKER_INTERRUPTED',
  'PERMANENT_VALIDATION',
  'PERMANENT_CLIENT_4XX',
  'MAX_ATTEMPTS_EXCEEDED',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Internal job representation rebuilt from the journal. `event` is never exposed by the API. */
export interface Job {
  readonly jobId: string;
  readonly state: JobState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly correlationId: string;
  readonly eventType: SyntheticEvent['type'];
  readonly receivedAt: string;
  readonly updatedAt: string;
  readonly nextAttemptAt?: string | undefined;
  readonly leaseExpiresAt?: string | undefined;
  /** Present only while RETRY_SCHEDULED or DEAD_LETTERED. */
  readonly failureCategory?: FailureCategory | undefined;
  /** Most recent step-level failure, kept for diagnostics. */
  readonly lastFailureCategory?: FailureCategory | undefined;
  readonly steps: Readonly<Record<StepName, StepStatus>>;
  readonly replayOf?: string | undefined;
  readonly replayedAs?: string | undefined;
  readonly idempotencyKeyHash: string | null;
  readonly requestFingerprint: string | null;
  readonly event: SyntheticEvent;
}
