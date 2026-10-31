import { open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { journalRecordSchema, type JobEvent, type JournalRecord } from '../domain/events.js';

export class JournalCorruptError extends Error {
  readonly code = 'JOURNAL_CORRUPT';
  constructor(
    readonly line: number,
    readonly reason: string,
  ) {
    super(`journal corrupt at line ${line}: ${reason}`);
    this.name = 'JournalCorruptError';
  }
}

export interface JournalWarning {
  readonly event: 'journal_tail_ignored' | 'journal_tail_previously_recovered';
  readonly line: number;
  readonly bytes: number;
}

/** Incremental reader state. Only complete (newline-terminated) lines are ever consumed. */
export interface ReadCursor {
  offset: number;
  line: number;
  lastSeq: number;
  /** A malformed complete line awaiting its JOURNAL_TAIL_RECOVERED marker. */
  pendingMalformed: { line: number; bytes: number } | null;
}

export interface ReadBatch {
  readonly records: JournalRecord[];
  readonly warnings: JournalWarning[];
  /** Bytes after the last newline (only possible after an interrupted write or mid-write by another process). */
  readonly remainderBytes: number;
}

export function newCursor(): ReadCursor {
  return { offset: 0, line: 0, lastSeq: 0, pendingMalformed: null };
}

function parseRecord(text: string): JournalRecord | null {
  try {
    const result = journalRecordSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Append-only JSON Lines file. Each logical write is one `write()` followed by `fsync`
 * (`FileHandle.sync()`) before the promise resolves; callers acknowledge only after that.
 */
export class JournalFile {
  private syncs = 0;

  constructor(readonly path: string) {}

  get syncCount(): number {
    return this.syncs;
  }

  async size(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  /** Reads complete lines from `cursor.offset`, mutating the cursor. Throws JournalCorruptError. */
  async readNew(cursor: ReadCursor): Promise<ReadBatch> {
    const size = await this.size();
    if (size <= cursor.offset) return { records: [], warnings: [], remainderBytes: 0 };
    const fh = await open(this.path, 'r');
    let buf: Buffer;
    try {
      buf = Buffer.alloc(size - cursor.offset);
      await fh.read(buf, 0, buf.length, cursor.offset);
    } finally {
      await fh.close();
    }
    const lastNewline = buf.lastIndexOf(0x0a);
    const complete = lastNewline >= 0 ? buf.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    const records: JournalRecord[] = [];
    const warnings: JournalWarning[] = [];
    let pos = 0;
    while (pos < complete.length) {
      const nl = complete.indexOf(0x0a, pos);
      const lineBuf = complete.subarray(pos, nl);
      pos = nl + 1;
      cursor.line += 1;
      const record = parseRecord(lineBuf.toString('utf8'));
      if (!record) {
        if (cursor.pendingMalformed) {
          throw new JournalCorruptError(cursor.pendingMalformed.line, 'malformed record not acknowledged');
        }
        cursor.pendingMalformed = { line: cursor.line, bytes: lineBuf.length };
        continue;
      }
      if (cursor.pendingMalformed) {
        const p = cursor.pendingMalformed;
        if (record.type !== 'JOURNAL_TAIL_RECOVERED' || record.ignoredLine !== p.line) {
          throw new JournalCorruptError(p.line, 'malformed record not acknowledged');
        }
        warnings.push({ event: 'journal_tail_previously_recovered', line: p.line, bytes: p.bytes });
        cursor.pendingMalformed = null;
      }
      if (record.seq <= cursor.lastSeq) throw new JournalCorruptError(cursor.line, 'non-increasing seq');
      cursor.lastSeq = record.seq;
      records.push(record);
    }
    cursor.offset += complete.length;
    return { records, warnings, remainderBytes: buf.length - complete.length };
  }

  /**
   * Appends events atomically from this process's perspective (single write + fsync).
   * MUST be called while holding the journal lock with a fully refreshed cursor.
   */
  async append(cursor: ReadCursor, events: readonly JobEvent[], prefixNewline = false): Promise<JournalRecord[]> {
    const records = events.map((e, i) => ({ v: 1 as const, seq: cursor.lastSeq + i + 1, ...e }) as JournalRecord);
    const text = (prefixNewline ? '\n' : '') + records.map((r) => JSON.stringify(r) + '\n').join('');
    const created = (await this.size()) === 0;
    const data = Buffer.from(text, 'utf8');
    const fh = await open(this.path, 'a');
    try {
      await fh.write(data);
      await fh.sync();
      this.syncs += 1;
    } finally {
      await fh.close();
    }
    if (created) await syncDirectory(dirname(this.path));
    cursor.offset += data.length;
    cursor.line += records.length + (prefixNewline ? 1 : 0);
    cursor.lastSeq += records.length;
    return records;
  }
}

/** Best-effort directory fsync so a newly created file's entry is durable (unsupported on Windows). */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // Some filesystems reject directory fsync; durability of the entry then depends on the OS.
  }
}
