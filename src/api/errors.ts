import type { z } from 'zod';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'MISSING_CORRELATION_ID'
  | 'INVALID_CORRELATION_ID'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INVALID_JSON'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'STORAGE_UNAVAILABLE'
  | 'INVALID_JOB_ID'
  | 'JOB_NOT_FOUND'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

const MESSAGES: Record<ApiErrorCode, string> = {
  VALIDATION_ERROR: 'Request body failed schema validation.',
  MISSING_IDEMPOTENCY_KEY: 'Idempotency-Key header is required.',
  INVALID_IDEMPOTENCY_KEY: 'Idempotency-Key must be 16-128 characters of [A-Za-z0-9._:-].',
  MISSING_CORRELATION_ID: 'X-Correlation-ID header is required.',
  INVALID_CORRELATION_ID: 'X-Correlation-ID must be 8-128 characters of [A-Za-z0-9._:-].',
  PAYLOAD_TOO_LARGE: 'Request body exceeds the 16 KiB limit.',
  UNSUPPORTED_MEDIA_TYPE: 'Content-Type must be application/json.',
  INVALID_JSON: 'Request body is not valid JSON.',
  IDEMPOTENCY_KEY_CONFLICT: 'Idempotency-Key was already used with a different request body.',
  STORAGE_UNAVAILABLE: 'The job could not be persisted; retry later.',
  INVALID_JOB_ID: 'Job id must be a UUID.',
  JOB_NOT_FOUND: 'Job not found.',
  NOT_FOUND: 'Route not found.',
  INTERNAL_ERROR: 'Internal error.',
};

export interface SafeIssue {
  path: string;
  code: string;
}

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; issues?: SafeIssue[] };
  correlationId?: string;
}

/** Issues expose only field paths and issue codes, never submitted values. */
export function safeIssues(error: z.ZodError): SafeIssue[] {
  const out: SafeIssue[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push({ path: base ? `${base}.${key}` : key, code: 'unrecognized_key' });
    } else {
      out.push({ path: base || '(root)', code: issue.code });
    }
  }
  return out.slice(0, 20);
}

export function errorBody(code: ApiErrorCode, correlationId?: string, issues?: SafeIssue[]): ApiErrorBody {
  return {
    error: { code, message: MESSAGES[code], ...(issues ? { issues } : {}) },
    ...(correlationId ? { correlationId } : {}),
  };
}
