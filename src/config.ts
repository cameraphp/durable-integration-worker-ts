import { z } from 'zod';

/** The API never binds to anything other than loopback in this reference implementation. */
export const HOST = '127.0.0.1' as const;

const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

/** Server-owned settings with hard bounds. Nothing here can be influenced by a webhook client. */
export const configSchema = z
  .object({
    port: z.coerce.number().int().min(1).max(65_535).default(3000),
    runtimeDir: z.string().min(1).default('.runtime'),
    maxAttempts: z.coerce.number().int().min(1).max(10).default(4),
    jobTimeoutMs: z.coerce.number().int().min(5).max(60_000).default(2000),
    baseBackoffMs: z.coerce.number().int().min(1).max(60_000).default(1000),
    maxBackoffMs: z.coerce.number().int().min(1).max(600_000).default(30_000),
    staleLockMs: z.coerce.number().int().min(50).max(600_000).default(30_000),
    lockAcquireTimeoutMs: z.coerce.number().int().min(10).max(60_000).default(5000),
    workerBatchSize: z.coerce.number().int().min(1).max(100).default(10),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
    mockScenariosEnabled: bool.default(false),
  })
  .refine((c) => c.maxBackoffMs >= c.baseBackoffMs, { message: 'MAX_BACKOFF_MS must be >= BASE_BACKOFF_MS' });

export type AppConfig = z.infer<typeof configSchema> & { readonly host: typeof HOST };
export type ConfigInput = z.input<typeof configSchema>;

const ENV_KEYS: Record<keyof ConfigInput, string> = {
  port: 'PORT',
  runtimeDir: 'RUNTIME_DIR',
  maxAttempts: 'MAX_ATTEMPTS',
  jobTimeoutMs: 'JOB_TIMEOUT_MS',
  baseBackoffMs: 'BASE_BACKOFF_MS',
  maxBackoffMs: 'MAX_BACKOFF_MS',
  staleLockMs: 'STALE_LOCK_MS',
  lockAcquireTimeoutMs: 'LOCK_ACQUIRE_TIMEOUT_MS',
  workerBatchSize: 'WORKER_BATCH_SIZE',
  logLevel: 'LOG_LEVEL',
  mockScenariosEnabled: 'MOCK_SCENARIOS_ENABLED',
};

export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';
  constructor(readonly fields: string[]) {
    super(`invalid configuration: ${fields.join(', ')}`);
    this.name = 'ConfigError';
  }
}

export function buildConfig(input: ConfigInput): AppConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => (i.path.length ? String(i.path[0]) : 'config')));
  }
  return { ...parsed.data, host: HOST };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const input: Record<string, string> = {};
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    const value = env[envName];
    if (value !== undefined && value !== '') input[key] = value;
  }
  return buildConfig(input as ConfigInput);
}
