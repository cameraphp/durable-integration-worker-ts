import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Clock } from '../domain/clock.js';
import { STEP_NAMES } from '../domain/types.js';
import type { AppLogger } from '../observability/logger.js';
import type { JobStore } from '../persistence/jobStore.js';

export type ReplayRefusal = 'JOB_NOT_FOUND' | 'NOT_DEAD_LETTERED' | 'ALREADY_REPLAYED';

export class ReplayRefusedError extends Error {
  constructor(readonly code: ReplayRefusal) {
    super(`replay refused: ${code}`);
    this.name = 'ReplayRefusedError';
  }
}

export interface ReplayDeps {
  readonly store: JobStore;
  readonly clock: Clock;
  readonly config: AppConfig;
  readonly logger: AppLogger;
}

/**
 * Deliberate operator replay of a dead-lettered job (local CLI only). Creates a NEW job linked by
 * `replayOf`, carries over completed steps so they are not repeated, and records `replayedAs` on
 * the original, which stays DEAD_LETTERED for audit.
 */
export async function replayDeadLetter(deps: ReplayDeps, jobId: string): Promise<{ replayJobId: string }> {
  return deps.store.withWriteLock(async () => {
    const original = deps.store.get(jobId);
    if (!original) throw new ReplayRefusedError('JOB_NOT_FOUND');
    if (original.state !== 'DEAD_LETTERED') throw new ReplayRefusedError('NOT_DEAD_LETTERED');
    if (original.replayedAs) throw new ReplayRefusedError('ALREADY_REPLAYED');
    const replayJobId = randomUUID();
    const at = deps.clock.now().toISOString();
    await deps.store.append([
      {
        type: 'JOB_RECEIVED',
        at,
        jobId: replayJobId,
        correlationId: original.correlationId,
        idempotencyKeyHash: null,
        requestFingerprint: null,
        maxAttempts: deps.config.maxAttempts,
        event: original.event,
        replayOf: original.jobId,
        carriedSteps: STEP_NAMES.filter((s) => original.steps[s] === 'SUCCEEDED'),
      },
      { type: 'JOB_TRANSITION', at, jobId: replayJobId, from: 'RECEIVED', to: 'READY', attempt: 0 },
      { type: 'JOB_REPLAYED', at, jobId: original.jobId, replayJobId },
    ]);
    deps.logger.warn({
      event: 'dead_letter_replayed',
      correlationId: original.correlationId,
      jobId: original.jobId,
      replayJobId,
      state: 'READY',
    });
    return { replayJobId };
  });
}
