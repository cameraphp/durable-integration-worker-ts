import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../domain/clock.js';
import type { SyntheticEvent } from '../domain/event.js';
import type { Job } from '../domain/types.js';
import type { JobStore } from '../persistence/jobStore.js';

export type IntakeResult =
  | { readonly kind: 'created'; readonly job: Job }
  | { readonly kind: 'duplicate'; readonly job: Job }
  | { readonly kind: 'conflict' };

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Canonical JSON (sorted keys) so semantically identical bodies produce the same fingerprint. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface IntakeInput {
  readonly event: SyntheticEvent;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

/**
 * Idempotent acceptance. Under the journal lock: look up the key hash; return the original job for
 * an identical body, refuse a different body, otherwise append JOB_RECEIVED + READY (one fsynced
 * write) and only then report success.
 */
export async function acceptEvent(
  store: JobStore,
  input: IntakeInput,
  deps: { readonly clock: Clock; readonly maxAttempts: number },
): Promise<IntakeResult> {
  const keyHash = sha256Hex(input.idempotencyKey);
  const fingerprint = sha256Hex(canonicalJson(input.event));
  return store.withWriteLock(async () => {
    const existingId = store.findJobIdByKeyHash(keyHash);
    if (existingId) {
      const existing = store.get(existingId);
      if (existing && existing.requestFingerprint === fingerprint) return { kind: 'duplicate', job: existing };
      return { kind: 'conflict' };
    }
    const jobId = randomUUID();
    const at = deps.clock.now().toISOString();
    await store.append([
      {
        type: 'JOB_RECEIVED',
        at,
        jobId,
        correlationId: input.correlationId,
        idempotencyKeyHash: keyHash,
        requestFingerprint: fingerprint,
        maxAttempts: deps.maxAttempts,
        event: input.event,
      },
      { type: 'JOB_TRANSITION', at, jobId, from: 'RECEIVED', to: 'READY', attempt: 0 },
    ]);
    const job = store.get(jobId);
    if (!job) throw new Error('job missing after append');
    return { kind: 'created', job };
  });
}
