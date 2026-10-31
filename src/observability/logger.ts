import { pino, type DestinationStream, type Logger } from 'pino';

export const SERVICE_NAME = 'durable-integration-worker';

export type AppLogger = Logger;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-like: optional country code, then 3 groups separated by space/dot/dash. Does not match ISO dates.
const PHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;

/** Identifier fields that are safe by construction and must not be altered by the sanitizer. */
const SAFE_KEYS = new Set([
  'service', 'event', 'jobId', 'correlationId', 'originalCorrelationId', 'replayOf', 'replayJobId', 'state', 'from', 'to',
  'failureCategory', 'lastFailureCategory', 'nextAttemptAt', 'leaseExpiresAt', 'step', 'time', 'level',
]);

/** Defence in depth: masks email- and phone-shaped substrings in any free-text log field. */
export function sanitizeString(value: string): string {
  return value.replace(EMAIL, '[redacted-email]').replace(PHONE, '[redacted-phone]');
}

function sanitize(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SAFE_KEYS.has(k) ? v : sanitize(v, depth + 1);
  return out;
}

/** Never serialise stacks or messages from unknown errors; only the error class name. */
function safeErr(err: unknown): { name: string } {
  return { name: err instanceof Error ? err.name : 'UnknownError' };
}

export interface LoggerOptions {
  readonly level?: string;
  readonly destination?: DestinationStream;
}

export function createLogger(opts: LoggerOptions = {}): AppLogger {
  return pino(
    {
      level: opts.level ?? 'info',
      base: { service: SERVICE_NAME },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      redact: {
        paths: [
          'body', 'payload', 'event.data', 'data', 'headers', 'authorization', 'idempotencyKey',
          'req.headers', '*.authorization', '*.idempotencyKey', '*.headers', 'stack', '*.stack',
        ],
        censor: '[redacted]',
      },
      serializers: { err: safeErr, error: safeErr },
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => sanitize(obj, 0) as Record<string, unknown>,
      },
    },
    opts.destination,
  );
}
