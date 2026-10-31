import type { JobState } from './types.js';

const ALLOWED: Readonly<Record<JobState, readonly JobState[]>> = {
  RECEIVED: ['READY'],
  READY: ['PROCESSING'],
  PROCESSING: ['SUCCEEDED', 'RETRY_SCHEDULED', 'DEAD_LETTERED'],
  RETRY_SCHEDULED: ['READY'],
  SUCCEEDED: [],
  DEAD_LETTERED: [],
};

export const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [JobState, JobState]> = Object.entries(ALLOWED).flatMap(
  ([from, tos]) => tos.map((to) => [from as JobState, to] as const),
);

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(['SUCCEEDED', 'DEAD_LETTERED']);

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(
    readonly from: JobState,
    readonly to: JobState,
  ) {
    super(`invalid job state transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: JobState, to: JobState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
