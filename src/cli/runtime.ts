import { LocalMockAdapter } from '../adapters/localMockAdapter.js';
import { FileSideEffectSink } from '../adapters/sideEffects.js';
import { loadConfig, type AppConfig } from '../config.js';
import { systemClock, type Clock } from '../domain/clock.js';
import { createLogger, type AppLogger } from '../observability/logger.js';
import { DeadLetterJournal } from '../persistence/deadLetterJournal.js';
import { JournalCorruptError } from '../persistence/journal.js';
import { JobStore } from '../persistence/jobStore.js';

export interface Runtime {
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly logger: AppLogger;
  readonly store: JobStore;
  readonly deadLetters: DeadLetterJournal;
  readonly adapter: LocalMockAdapter;
}

/** Wires the local runtime from environment configuration (system clock, file-backed journal, mock adapter). */
export async function createRuntime(): Promise<Runtime> {
  const config = loadConfig();
  const clock = systemClock;
  const logger = createLogger({ level: config.logLevel });
  const store = await JobStore.open({
    runtimeDir: config.runtimeDir,
    clock,
    logger,
    staleLockMs: config.staleLockMs,
    lockAcquireTimeoutMs: config.lockAcquireTimeoutMs,
  });
  const deadLetters = new DeadLetterJournal(config.runtimeDir);
  const adapter = new LocalMockAdapter({
    sink: new FileSideEffectSink(config.runtimeDir),
    clock,
    scenariosEnabled: config.mockScenariosEnabled,
  });
  return { config, clock, logger, store, deadLetters, adapter };
}

/** Structured fatal report without stacks; returns the process exit code. */
export function reportFatal(err: unknown, logger?: AppLogger): number {
  const fallback = logger ?? createLogger();
  if (err instanceof JournalCorruptError) {
    fallback.fatal({ event: 'journal_corrupt_refusing_start', errorCode: err.code, line: err.line, reason: err.reason });
  } else {
    fallback.fatal({ event: 'fatal_error', err, errorCode: (err as { code?: string }).code });
  }
  return 1;
}
