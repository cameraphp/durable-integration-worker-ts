import { parseArgs } from 'node:util';
import { z } from 'zod';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; usage: string };

export const WORKER_USAGE = 'usage: worker --once   (runs exactly one worker cycle and exits)';
export const REPLAY_USAGE =
  'usage: replay --job-id <uuid> --confirm-replay   (replays ONE dead-lettered job as a new linked job)';

/** The worker only supports an explicit single-cycle mode. */
export function parseWorkerArgs(argv: readonly string[]): ParseResult<{ mode: 'once' }> {
  try {
    const { values } = parseArgs({ args: [...argv], options: { once: { type: 'boolean' } }, strict: true });
    return values.once ? { ok: true, value: { mode: 'once' } } : { ok: false, usage: WORKER_USAGE };
  } catch {
    return { ok: false, usage: WORKER_USAGE };
  }
}

/** Replay requires both an explicit job id and an explicit confirmation flag. */
export function parseReplayArgs(argv: readonly string[]): ParseResult<{ jobId: string }> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { 'job-id': { type: 'string' }, 'confirm-replay': { type: 'boolean' } },
      strict: true,
    });
    const jobId = z.uuid().safeParse(values['job-id']);
    if (!values['confirm-replay'] || !jobId.success) return { ok: false, usage: REPLAY_USAGE };
    return { ok: true, value: { jobId: jobId.data } };
  } catch {
    return { ok: false, usage: REPLAY_USAGE };
  }
}
