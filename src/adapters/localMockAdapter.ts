import type { StepOutcome } from '../domain/classification.js';
import type { Clock } from '../domain/clock.js';
import type { IntegrationAdapter, SideEffectSink, StepContext } from './types.js';

export interface LocalMockAdapterOptions {
  readonly sink: SideEffectSink;
  readonly clock: Clock;
  /** Server-side switch. When false, `data.demoOutcome` is ignored entirely. */
  readonly scenariosEnabled: boolean;
}

/** Resolves only when the signal aborts. Used to simulate a hung dependency without timers. */
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

/**
 * Deterministic, network-free mock of a two-step integration:
 *  - normalize: pure local validation of the synthetic reference id
 *  - deliver:   records one simulated side effect in the configured sink
 */
export class LocalMockAdapter implements IntegrationAdapter {
  readonly name = 'local-mock';

  constructor(private readonly opts: LocalMockAdapterOptions) {}

  async executeStep(ctx: StepContext): Promise<StepOutcome> {
    const scenario = this.opts.scenariosEnabled ? ctx.event.data.demoOutcome : undefined;
    const first = ctx.attempt === 1;

    if (ctx.step === 'normalize') {
      if (scenario === 'transient_once' && first) return { kind: 'failure', hint: 'transient', status: 503 };
      if (!/^SYN-\d+$/.test(ctx.event.data.referenceId)) return { kind: 'failure', hint: 'validation' };
      return { kind: 'success' };
    }

    // deliver
    if (scenario === 'rate_limited_once' && first) return { kind: 'failure', hint: 'transient', status: 429 };
    if (scenario === 'partial_once' && first) return { kind: 'failure', hint: 'transient', status: 502 };
    if (scenario === 'timeout_once' && first) return waitForAbort(ctx.signal);
    if (scenario === 'permanent') return { kind: 'failure', hint: 'rejected', status: 422 };
    if (scenario === 'always_transient') return { kind: 'failure', hint: 'transient', status: 503 };

    await this.opts.sink.record({
      jobId: ctx.jobId,
      correlationId: ctx.correlationId,
      step: ctx.step,
      attempt: ctx.attempt,
      at: this.opts.clock.now().toISOString(),
    });
    return { kind: 'success' };
  }
}
