/**
 * Deterministic bounded exponential backoff (no jitter):
 * delay(attempt) = min(maxMs, baseMs * 2^(attempt - 1)), attempt >= 1.
 */
export function computeBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be an integer >= 1');
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
