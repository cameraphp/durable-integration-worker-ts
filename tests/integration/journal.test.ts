import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptEvent } from '../../src/api/intake.js';
import { ManualClock } from '../../src/domain/clock.js';
import { JournalCorruptError } from '../../src/persistence/journal.js';
import { JobStore, JOBS_JOURNAL, LOCK_FILE } from '../../src/persistence/jobStore.js';
import { LockTimeoutError, withFileLock } from '../../src/persistence/lock.js';
import { captureLogs, cleanupTempDirs, makeTempDir, syntheticEvent } from '../support/harness.js';

afterEach(cleanupTempDirs);

const clock = new ManualClock();

async function openStore(dir: string, logs = captureLogs()) {
  return JobStore.open({ runtimeDir: dir, clock, logger: logs.logger, staleLockMs: 30_000, lockAcquireTimeoutMs: 2000 });
}

async function accept(store: JobStore, key: string) {
  return acceptEvent(store, { event: syntheticEvent(), idempotencyKey: key, correlationId: 'corr-journal-01' }, { clock, maxAttempts: 4 });
}

describe('journal durability', () => {
  it('T-JR-01 fsyncs every logical write and reloads records in seq order', async () => {
    const dir = await makeTempDir();
    const store = await openStore(dir);
    expect(store.journal.syncCount).toBe(0);
    const a = await accept(store, 'journal-key-0000000001');
    expect(store.journal.syncCount).toBe(1);
    const b = await accept(store, 'journal-key-0000000002');
    expect(store.journal.syncCount).toBe(2);

    const reopened = await openStore(dir);
    expect(reopened.list().map((j) => j.jobId).sort()).toEqual(
      [a.kind === 'created' ? a.job.jobId : '', b.kind === 'created' ? b.job.jobId : ''].sort(),
    );
    const seqs = (await readFile(join(dir, JOBS_JOURNAL), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('T-JR-02 preserves, ignores and acknowledges a torn final record', async () => {
    const dir = await makeTempDir();
    const file = join(dir, JOBS_JOURNAL);
    const first = await accept(await openStore(dir), 'journal-key-0000000003');
    const torn = '{"v":1,"seq":3,"type":"JOB_RECEIVED","at":"2026-10-31T12:0';
    await appendFile(file, torn);

    const logs = captureLogs();
    const store = await openStore(dir, logs);
    expect(store.warnings).toEqual([{ event: 'journal_tail_ignored', line: 3, bytes: torn.length }]);
    expect(logs.byEvent('journal_tail_ignored')).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    expect(store.get(first.kind === 'created' ? first.job.jobId : '')?.state).toBe('READY');

    const text = await readFile(file, 'utf8');
    expect(text.includes(torn + '\n')).toBe(true);
    const lines = text.trim().split('\n');
    expect(JSON.parse(lines.at(-1) ?? '')).toMatchObject({ type: 'JOURNAL_TAIL_RECOVERED', ignoredLine: 3, ignoredBytes: torn.length, seq: 3 });

    await accept(store, 'journal-key-0000000004');
    const again = captureLogs();
    const reopened = await openStore(dir, again);
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.warnings).toEqual([{ event: 'journal_tail_previously_recovered', line: 3, bytes: torn.length }]);
    expect(again.byEvent('journal_tail_ignored')).toHaveLength(0);
  });

  it('T-JR-03 refuses to start on unacknowledged mid-file corruption without modifying the file', async () => {
    const dir = await makeTempDir();
    const file = join(dir, JOBS_JOURNAL);
    const store = await openStore(dir);
    await accept(store, 'journal-key-0000000005');
    await accept(store, 'journal-key-0000000006');
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines[1] = '{"this is":"not a valid record"';
    const corrupted = lines.join('\n');
    await writeFile(file, corrupted);

    await expect(openStore(dir)).rejects.toBeInstanceOf(JournalCorruptError);
    await expect(openStore(dir)).rejects.toMatchObject({ code: 'JOURNAL_CORRUPT', line: 2 });
    expect(await readFile(file, 'utf8')).toBe(corrupted);
  });

  it('T-JR-04 lock file blocks while fresh and is broken when stale', async () => {
    const dir = await makeTempDir();
    const lockPath = join(dir, LOCK_FILE);
    const logs = captureLogs();
    const opts = { lockPath, staleLockMs: 30_000, acquireTimeoutMs: 60, retryDelayMs: 10, clock, logger: logs.logger };

    await writeFile(lockPath, JSON.stringify({ pid: 999_999, acquiredAt: clock.now().toISOString(), token: 'foreign' }));
    await expect(withFileLock(opts, async () => 'never')).rejects.toBeInstanceOf(LockTimeoutError);

    const old = new Date(clock.now().getTime() - 60_000).toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, acquiredAt: old, token: 'foreign' }));
    await expect(withFileLock(opts, async () => 'acquired')).resolves.toBe('acquired');
    expect(logs.byEvent('journal_lock_stale_broken')).toHaveLength(1);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
