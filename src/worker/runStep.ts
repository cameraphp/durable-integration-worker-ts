import type { IntegrationAdapter, StepContext } from '../adapters/types.js';
import type { ExecutionResult } from '../domain/classification.js';

/**
 * Runs one adapter step bounded by `timeoutMs`. On expiry the AbortController fires, the adapter is
 * expected to stop, and the result is `{ kind: 'timeout' }`. Thrown errors become `{ kind: 'thrown' }`
 * and are deliberately discarded so no message or stack can reach state, logs or API output.
 */
export async function runStepWithTimeout(
  adapter: IntegrationAdapter,
  ctx: Omit<StepContext, 'signal'>,
  timeoutMs: number,
): Promise<ExecutionResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ExecutionResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
  });
  const execution: Promise<ExecutionResult> = Promise.resolve()
    .then(() => adapter.executeStep({ ...ctx, signal: controller.signal }))
    .then(
      (outcome): ExecutionResult => outcome,
      (): ExecutionResult => (controller.signal.aborted ? { kind: 'timeout' } : { kind: 'thrown' }),
    );
  try {
    return await Promise.race([execution, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
