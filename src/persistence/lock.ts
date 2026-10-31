import { randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Clock } from '../domain/clock.js';
import type { AppLogger } from '../observability/logger.js';

export class LockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT';
  constructor() {
    super('timed out acquiring journal lock');
    this.name = 'LockTimeoutError';
  }
}

export interface FileLockOptions {
  readonly lockPath: string;
  readonly staleLockMs: number;
  readonly acquireTimeoutMs: number;
  readonly retryDelayMs?: number;
  readonly clock: Clock;
  readonly logger: AppLogger;
}

interface LockBody {
  pid: number;
  acquiredAt: string;
  token: string;
}

async function readLock(lockPath: string): Promise<LockBody | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'acquiredAt' in parsed && 'token' in parsed) return parsed as LockBody;
    return null;
  } catch {
    return null;
  }
}

/**
 * Advisory exclusive lock between cooperating local processes (API and worker) using O_EXCL
 * file creation. NOT a distributed lock. A lock older than `staleLockMs` is assumed abandoned.
 */
export async function withFileLock<T>(opts: FileLockOptions, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const startedAt = performance.now();
  for (;;) {
    try {
      const fh = await open(opts.lockPath, 'wx');
      try {
        const body: LockBody = { pid: process.pid, acquiredAt: opts.clock.now().toISOString(), token };
        await fh.writeFile(JSON.stringify(body));
      } finally {
        await fh.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await readLock(opts.lockPath);
      const ageMs = existing ? opts.clock.now().getTime() - Date.parse(existing.acquiredAt) : Number.POSITIVE_INFINITY;
      if (!existing || !(ageMs <= opts.staleLockMs)) {
        opts.logger.warn({ event: 'journal_lock_stale_broken', lockAgeMs: Number.isFinite(ageMs) ? ageMs : null });
        await unlink(opts.lockPath).catch(() => undefined);
        continue;
      }
      if (performance.now() - startedAt > opts.acquireTimeoutMs) throw new LockTimeoutError();
      await delay(opts.retryDelayMs ?? 20);
    }
  }
  try {
    return await fn();
  } finally {
    const current = await readLock(opts.lockPath);
    if (current?.token === token) await unlink(opts.lockPath).catch(() => undefined);
  }
}
