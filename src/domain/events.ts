import { z } from 'zod';
import { syntheticEventSchema } from './event.js';
import { FAILURE_CATEGORIES, JOB_STATES, STEP_NAMES } from './types.js';

const isoTime = z.iso.datetime();
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueId = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const state = z.enum(JOB_STATES);
const failure = z.enum(FAILURE_CATEGORIES);
const step = z.enum(STEP_NAMES);

export const jobReceivedEvent = z.strictObject({
  type: z.literal('JOB_RECEIVED'),
  at: isoTime,
  jobId: z.uuid(),
  correlationId: opaqueId,
  /** SHA-256 of the Idempotency-Key header; the raw key is never persisted. Null for replay jobs. */
  idempotencyKeyHash: sha256Hex.nullable(),
  requestFingerprint: sha256Hex.nullable(),
  maxAttempts: z.number().int().min(1).max(10),
  event: syntheticEventSchema,
  replayOf: z.uuid().optional(),
  carriedSteps: z.array(step).optional(),
});

export const jobTransitionEvent = z.strictObject({
  type: z.literal('JOB_TRANSITION'),
  at: isoTime,
  jobId: z.uuid(),
  from: state,
  to: state,
  attempt: z.number().int().min(0).max(10),
  failureCategory: failure.optional(),
  lastFailureCategory: failure.optional(),
  nextAttemptAt: isoTime.optional(),
  leaseExpiresAt: isoTime.optional(),
});

export const stepSucceededEvent = z.strictObject({
  type: z.literal('STEP_SUCCEEDED'),
  at: isoTime,
  jobId: z.uuid(),
  step,
  attempt: z.number().int().min(1).max(10),
});

export const jobReplayedEvent = z.strictObject({
  type: z.literal('JOB_REPLAYED'),
  at: isoTime,
  jobId: z.uuid(),
  replayJobId: z.uuid(),
});

/** Audit marker acknowledging an interrupted (torn) final record. The torn bytes are left in place. */
export const journalTailRecoveredEvent = z.strictObject({
  type: z.literal('JOURNAL_TAIL_RECOVERED'),
  at: isoTime,
  ignoredLine: z.number().int().min(1),
  ignoredBytes: z.number().int().min(0),
});

const eventVariants = [
  jobReceivedEvent,
  jobTransitionEvent,
  stepSucceededEvent,
  jobReplayedEvent,
  journalTailRecoveredEvent,
] as const;

export const jobEventSchema = z.discriminatedUnion('type', eventVariants);
export type JobEvent = z.infer<typeof jobEventSchema>;

const envelope = { v: z.literal(1), seq: z.number().int().positive() };
export const journalRecordSchema = z.discriminatedUnion(
  'type',
  [
    jobReceivedEvent.extend(envelope),
    jobTransitionEvent.extend(envelope),
    stepSucceededEvent.extend(envelope),
    jobReplayedEvent.extend(envelope),
    journalTailRecoveredEvent.extend(envelope),
  ],
);
export type JournalRecord = z.infer<typeof journalRecordSchema>;
