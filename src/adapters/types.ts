import type { StepOutcome } from '../domain/classification.js';
import type { SyntheticEvent } from '../domain/event.js';
import type { StepName } from '../domain/types.js';

export interface StepContext {
  readonly jobId: string;
  readonly correlationId: string;
  readonly attempt: number;
  readonly step: StepName;
  readonly event: SyntheticEvent;
  /** Aborted by the worker when JOB_TIMEOUT_MS elapses. Adapters must stop work when it fires. */
  readonly signal: AbortSignal;
}

/**
 * Typed integration boundary. Implementations must be local and deterministic in this project,
 * and should be idempotent per (jobId, step) because delivery is at-least-once.
 */
export interface IntegrationAdapter {
  readonly name: string;
  executeStep(ctx: StepContext): Promise<StepOutcome>;
}

export interface SideEffectEntry {
  readonly jobId: string;
  readonly correlationId: string;
  readonly step: StepName;
  readonly attempt: number;
  readonly at: string;
}

/** Where the mock "deliver" step records its simulated side effect. */
export interface SideEffectSink {
  record(entry: SideEffectEntry): Promise<void>;
}
