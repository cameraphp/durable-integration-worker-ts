import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FailureCategory, Job, StepName, StepStatus } from '../domain/types.js';
import { syncDirectory } from './journal.js';
import { DEAD_LETTER_JOURNAL } from './jobStore.js';

/** Sanitized operator-facing dead-letter record. Contains no payload data. */
export interface DeadLetterRecord {
  readonly v: 1;
  readonly at: string;
  readonly jobId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly attempts: number;
  readonly failureCategory: FailureCategory;
  readonly lastFailureCategory?: FailureCategory | undefined;
  readonly steps: Readonly<Record<StepName, StepStatus>>;
  readonly replayOf?: string | undefined;
}

export function toDeadLetterRecord(job: Job, at: string): DeadLetterRecord {
  if (job.state !== 'DEAD_LETTERED' || !job.failureCategory) throw new Error('job is not dead-lettered');
  return {
    v: 1,
    at,
    jobId: job.jobId,
    correlationId: job.correlationId,
    eventType: job.eventType,
    attempts: job.attempt,
    failureCategory: job.failureCategory,
    lastFailureCategory: job.lastFailureCategory,
    steps: job.steps,
    replayOf: job.replayOf,
  };
}

/**
 * Secondary, append-only log of dead letters. The jobs journal remains the source of truth;
 * missing records are reconciled by the worker. Callers hold the journal lock when appending.
 */
export class DeadLetterJournal {
  readonly path: string;

  constructor(runtimeDir: string) {
    this.path = join(runtimeDir, DEAD_LETTER_JOURNAL);
  }

  /** Returns the job ids present. A malformed final line (interrupted write) is skipped. */
  async recordedJobIds(): Promise<Set<string>> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw err;
    }
    const ids = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<DeadLetterRecord>;
        if (typeof parsed.jobId === 'string') ids.add(parsed.jobId);
      } catch {
        // Interrupted write: the job will be re-recorded by reconciliation.
      }
    }
    return ids;
  }

  async append(record: DeadLetterRecord): Promise<void> {
    const fh = await open(this.path, 'a+');
    let created: boolean;
    try {
      const size = (await fh.stat()).size;
      created = size === 0;
      let prefix = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        // Newline guard: isolates a torn previous line (interrupted write) from this record.
        if (last[0] !== 0x0a) prefix = '\n';
      }
      await fh.write(prefix + JSON.stringify(record) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (created) await syncDirectory(join(this.path, '..'));
  }
}
