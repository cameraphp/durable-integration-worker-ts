import type { FailureCategory } from './types.js';

/** What a mock adapter may report for one step. Status codes are HTTP-like hints only. */
export type StepOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'failure'; readonly hint: 'transient' | 'validation' | 'rejected'; readonly status?: number };

/** What the worker observed, including conditions the adapter cannot self-report. */
export type ExecutionResult = StepOutcome | { readonly kind: 'timeout' } | { readonly kind: 'thrown' };

export interface Classification {
  readonly category: FailureCategory;
  readonly retryable: boolean;
}

const RETRYABLE: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  'TIMEOUT',
  'TRANSIENT',
  'RATE_LIMITED',
  'UPSTREAM_5XX',
  'ADAPTER_ERROR',
  'WORKER_INTERRUPTED',
]);

export function isRetryable(category: FailureCategory): boolean {
  return RETRYABLE.has(category);
}

function of(category: FailureCategory): Classification {
  return { category, retryable: isRetryable(category) };
}

/** Server-side classification. HTTP-like status hints take precedence over the adapter's label. */
export function classify(result: Exclude<ExecutionResult, { kind: 'success' }>): Classification {
  switch (result.kind) {
    case 'timeout':
      return of('TIMEOUT');
    case 'thrown':
      return of('ADAPTER_ERROR');
    case 'failure': {
      const { status, hint } = result;
      if (status === 429) return of('RATE_LIMITED');
      if (status === 408) return of('TIMEOUT');
      if (status !== undefined && status >= 500 && status <= 599) return of('UPSTREAM_5XX');
      if (hint === 'validation') return of('PERMANENT_VALIDATION');
      if (hint === 'rejected' || (status !== undefined && status >= 400 && status <= 499)) {
        return of('PERMANENT_CLIENT_4XX');
      }
      return of('TRANSIENT');
    }
  }
}
