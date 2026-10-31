import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SideEffectEntry, SideEffectSink } from './types.js';

export const SIDE_EFFECTS_FILE = 'mock-side-effects.jsonl';

/** In-memory sink used by tests to count simulated side effects. */
export class InMemorySideEffectSink implements SideEffectSink {
  readonly entries: SideEffectEntry[] = [];

  async record(entry: SideEffectEntry): Promise<void> {
    this.entries.push(entry);
  }

  countFor(jobId: string): number {
    return this.entries.filter((e) => e.jobId === jobId).length;
  }
}

/** Local file sink used by the CLI so demos can observe side effects across processes. */
export class FileSideEffectSink implements SideEffectSink {
  readonly path: string;

  constructor(runtimeDir: string) {
    this.path = join(runtimeDir, SIDE_EFFECTS_FILE);
  }

  async record(entry: SideEffectEntry): Promise<void> {
    const fh = await open(this.path, 'a');
    try {
      await fh.write(JSON.stringify(entry) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
}
