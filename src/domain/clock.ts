/** Injectable time source. Job decisions never call `Date.now()` directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests and controlled demos. */
export class ManualClock implements Clock {
  private epochMs: number;

  constructor(start: string | number = '2026-10-31T12:00:00.000Z') {
    this.epochMs = typeof start === 'number' ? start : Date.parse(start);
  }

  now(): Date {
    return new Date(this.epochMs);
  }

  advance(ms: number): void {
    this.epochMs += ms;
  }
}
