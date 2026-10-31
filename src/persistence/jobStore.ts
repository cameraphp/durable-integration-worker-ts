import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../domain/clock.js';
import type { JobEvent, JournalRecord } from '../domain/events.js';
import { applyEvent } from '../domain/reducer.js';
import type { Job } from '../domain/types.js';
import type { AppLogger } from '../observability/logger.js';
import { JournalCorruptError, JournalFile, newCursor, type JournalWarning, type ReadCursor } from './journal.js';
import { withFileLock } from './lock.js';

export const JOBS_JOURNAL = 'jobs.journal.jsonl';
export const DEAD_LETTER_JOURNAL = 'dead-letters.journal.jsonl';
export const LOCK_FILE = 'journal.lock';

export interface JobStoreOptions {
  readonly runtimeDir: string;
  readonly clock: Clock;
  readonly logger: AppLogger;
  readonly staleLockMs: number;
  readonly lockAcquireTimeoutMs: number;
}

export class StoreNotLockedError extends Error {
  readonly code = 'STORE_NOT_LOCKED';
  constructor() {
    super('append requires the journal write lock');
    this.name = 'StoreNotLockedError';
  }
}

/**
 * Durable job store: the journal is the source of truth; this class keeps an in-memory projection
 * (jobs + idempotency index) that is rebuilt on open and refreshed incrementally.
 */
export class JobStore {
  readonly journal: JournalFile;
  readonly warnings: JournalWarning[] = [];
  private jobs = new Map<string, Job>();
  private readonly byKeyHash = new Map<string, string>();
  private readonly cursor: ReadCursor = newCursor();
  private locked = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly opts: JobStoreOptions) {
    this.journal = new JournalFile(join(opts.runtimeDir, JOBS_JOURNAL));
  }

  /** Opens the store, replaying the full journal under the write lock (recovering a torn tail). */
  static async open(opts: JobStoreOptions): Promise<JobStore> {
    await mkdir(opts.runtimeDir, { recursive: true });
    const store = new JobStore(opts);
    await store.withWriteLock(async () => undefined);
    opts.logger.info({ event: 'journal_opened', jobs: store.jobs.size, lastSeq: store.cursor.lastSeq });
    return store;
  }

  get runtimeDir(): string {
    return this.opts.runtimeDir;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  findJobIdByKeyHash(keyHash: string): string | undefined {
    return this.byKeyHash.get(keyHash);
  }

  /** Read-only incremental refresh; never consumes a trailing partial line. */
  async refresh(): Promise<void> {
    await this.serialize(() => this.readAndApply());
  }

  /**
   * Runs `fn` with exclusive journal access: in-process mutex + cross-process lock file + full
   * refresh with torn-tail recovery. `append` is only allowed inside `fn`.
   */
  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialize(() =>
      withFileLock(
        {
          lockPath: join(this.opts.runtimeDir, LOCK_FILE),
          staleLockMs: this.opts.staleLockMs,
          acquireTimeoutMs: this.opts.lockAcquireTimeoutMs,
          clock: this.opts.clock,
          logger: this.opts.logger,
        },
        async () => {
          const remainder = await this.readAndApply();
          await this.recoverTornTail(remainder);
          this.locked = true;
          try {
            return await fn();
          } finally {
            this.locked = false;
          }
        },
      ),
    );
  }

  /** Validates events against the projection, appends + fsyncs, then publishes the new projection. */
  async append(events: readonly JobEvent[]): Promise<JournalRecord[]> {
    if (!this.locked) throw new StoreNotLockedError();
    let preview = this.jobs;
    for (const e of events) preview = applyEvent(preview, e);
    const records = await this.journal.append(this.cursor, events);
    this.jobs = preview;
    for (const e of events) this.indexEvent(e);
    return records;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private indexEvent(e: JobEvent): void {
    if (e.type === 'JOB_RECEIVED' && e.idempotencyKeyHash) this.byKeyHash.set(e.idempotencyKeyHash, e.jobId);
  }

  private async readAndApply(): Promise<number> {
    const batch = await this.journal.readNew(this.cursor);
    for (const w of batch.warnings) {
      this.warnings.push(w);
      this.opts.logger.warn({ event: w.event, line: w.line, bytes: w.bytes });
    }
    for (const record of batch.records) {
      const { v: _v, seq: _seq, ...event } = record;
      try {
        this.jobs = applyEvent(this.jobs, event as JobEvent);
      } catch (err) {
        throw new JournalCorruptError(this.cursor.line, `invalid event sequence (${(err as Error).name})`);
      }
      if (event.type === 'JOB_RECEIVED' && event.idempotencyKeyHash) {
        const existing = this.byKeyHash.get(event.idempotencyKeyHash);
        if (existing && existing !== event.jobId) throw new JournalCorruptError(this.cursor.line, 'idempotency key reused');
        this.byKeyHash.set(event.idempotencyKeyHash, event.jobId);
      }
    }
    return batch.remainderBytes;
  }

  /**
   * A malformed FINAL record (interrupted write) is preserved byte-for-byte, ignored, reported,
   * and acknowledged by appending a JOURNAL_TAIL_RECOVERED marker. History is never rewritten.
   */
  private async recoverTornTail(remainderBytes: number): Promise<void> {
    let ignoredLine: number;
    let ignoredBytes: number;
    if (remainderBytes > 0) {
      if (this.cursor.pendingMalformed) {
        throw new JournalCorruptError(this.cursor.pendingMalformed.line, 'malformed record not acknowledged');
      }
      ignoredLine = this.cursor.line + 1;
      ignoredBytes = remainderBytes;
      this.cursor.offset += remainderBytes;
    } else if (this.cursor.pendingMalformed) {
      ({ line: ignoredLine, bytes: ignoredBytes } = this.cursor.pendingMalformed);
    } else {
      return;
    }
    const warning: JournalWarning = { event: 'journal_tail_ignored', line: ignoredLine, bytes: ignoredBytes };
    this.warnings.push(warning);
    this.opts.logger.warn({ event: warning.event, line: ignoredLine, bytes: ignoredBytes });
    await this.journal.append(
      this.cursor,
      [{ type: 'JOURNAL_TAIL_RECOVERED', at: this.opts.clock.now().toISOString(), ignoredLine, ignoredBytes }],
      remainderBytes > 0,
    );
    this.cursor.pendingMalformed = null;
  }
}
