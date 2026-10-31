import { fastify, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Clock } from '../domain/clock.js';
import { syntheticEventSchema } from '../domain/event.js';
import type { AppLogger } from '../observability/logger.js';
import type { JobStore } from '../persistence/jobStore.js';
import { errorBody, safeIssues, type ApiErrorCode } from './errors.js';
import { acceptEvent, type IntakeInput, type IntakeResult } from './intake.js';
import { toJobView } from './jobView.js';

export const BODY_LIMIT_BYTES = 16 * 1024;
const OPAQUE = /^[A-Za-z0-9._:-]+$/;
const idempotencyKeySchema = z.string().min(16).max(128).regex(OPAQUE);
const correlationIdSchema = z.string().min(8).max(128).regex(OPAQUE);
const jobIdSchema = z.uuid();

export interface AppDeps {
  readonly store: JobStore;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly logger: AppLogger;
  /** Injectable for failure-path tests; defaults to the durable intake. */
  readonly intake?: (input: IntakeInput) => Promise<IntakeResult>;
}

function header(req: FastifyRequest, name: string): string | string[] | undefined {
  return req.headers[name];
}

/** Returns the correlation id only if it is a single, valid value (safe to echo and log). */
function validCorrelationId(req: FastifyRequest): string | undefined {
  const value = header(req, 'x-correlation-id');
  return typeof value === 'string' && correlationIdSchema.safeParse(value).success ? value : undefined;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { store, config, clock, logger } = deps;
  const intake = deps.intake ?? ((input: IntakeInput) => acceptEvent(store, input, { clock, maxAttempts: config.maxAttempts }));
  const app = fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
  app.removeContentTypeParser('text/plain');

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const correlationId = validCorrelationId(req);
    let status = 500;
    let code: ApiErrorCode = 'INTERNAL_ERROR';
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') [status, code] = [413, 'PAYLOAD_TOO_LARGE'];
    else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') [status, code] = [415, 'UNSUPPORTED_MEDIA_TYPE'];
    else if (err.statusCode === 400 && (err.name === 'SyntaxError' || /JSON/.test(err.code ?? ''))) [status, code] = [400, 'INVALID_JSON'];
    if (status === 500) logger.error({ event: 'http_internal_error', correlationId, err });
    else logger.warn({ event: 'webhook_rejected', correlationId, errorCode: code });
    return reply.code(status).send(errorBody(code, correlationId));
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorBody('NOT_FOUND', validCorrelationId(req))));

  app.get('/healthz', async (_req, reply) => reply.code(200).send({ status: 'ok' }));

  app.post('/v1/webhooks/events', async (req, reply) => {
    const reject = (status: number, code: ApiErrorCode, correlationId?: string, issues?: ReturnType<typeof safeIssues>) => {
      logger.warn({ event: 'webhook_rejected', correlationId, errorCode: code });
      return reply.code(status).send(errorBody(code, correlationId, issues));
    };

    const rawCorrelation = header(req, 'x-correlation-id');
    if (rawCorrelation === undefined) return reject(400, 'MISSING_CORRELATION_ID');
    const correlation = correlationIdSchema.safeParse(rawCorrelation);
    if (!correlation.success) return reject(400, 'INVALID_CORRELATION_ID');
    const correlationId = correlation.data;

    const rawKey = header(req, 'idempotency-key');
    if (rawKey === undefined) return reject(400, 'MISSING_IDEMPOTENCY_KEY', correlationId);
    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) return reject(400, 'INVALID_IDEMPOTENCY_KEY', correlationId);

    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return reject(415, 'UNSUPPORTED_MEDIA_TYPE', correlationId);
    }
    const body = syntheticEventSchema.safeParse(req.body);
    if (!body.success) return reject(400, 'VALIDATION_ERROR', correlationId, safeIssues(body.error));

    let result: IntakeResult;
    try {
      result = await intake({ event: body.data, idempotencyKey: key.data, correlationId });
    } catch (err) {
      logger.error({ event: 'webhook_persist_failed', correlationId, err });
      return reply.code(503).send(errorBody('STORAGE_UNAVAILABLE', correlationId));
    }

    if (result.kind === 'conflict') {
      logger.warn({ event: 'webhook_idempotency_conflict', correlationId });
      return reply.code(409).send(errorBody('IDEMPOTENCY_KEY_CONFLICT', correlationId));
    }
    const { job } = result;
    const created = result.kind === 'created';
    logger.info({
      event: created ? 'webhook_accepted' : 'webhook_duplicate',
      correlationId,
      jobId: job.jobId,
      originalCorrelationId: created ? undefined : job.correlationId,
      state: job.state,
    });
    return reply
      .code(created ? 202 : 200)
      .send({ jobId: job.jobId, state: job.state, created, correlationId: job.correlationId });
  });

  app.get<{ Params: { jobId: string } }>('/v1/jobs/:jobId', async (req, reply) => {
    const correlationId = validCorrelationId(req);
    const id = jobIdSchema.safeParse(req.params.jobId);
    if (!id.success) return reply.code(400).send(errorBody('INVALID_JOB_ID', correlationId));
    try {
      await store.refresh();
    } catch (err) {
      logger.error({ event: 'job_read_failed', correlationId, err });
      return reply.code(503).send(errorBody('STORAGE_UNAVAILABLE', correlationId));
    }
    const job = store.get(id.data);
    if (!job) return reply.code(404).send(errorBody('JOB_NOT_FOUND', correlationId));
    return reply.code(200).send(toJobView(job));
  });

  return app;
}
