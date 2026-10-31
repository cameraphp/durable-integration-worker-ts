# Requirements — durable-integration-worker (2026-10-31)

IDs are stable. Use "must" to read every requirement as mandatory. Validation evidence for each ID
is mapped in [`validation.md`](./validation.md).

## Functional requirements

| ID | Requirement |
|---|---|
| FR-001 | `POST /v1/webhooks/events` must accept a valid synthetic event envelope and return `202` with `{ jobId, state, created: true, correlationId }`. `jobId` is a UUID. |
| FR-002 | The event body must be validated with a strict schema: `eventId`, `type` (closed enum), `occurredAt` (ISO-8601), `source` (`"synthetic-demo"`), and `data` (strict object). Unknown properties at any level must be rejected with `400 VALIDATION_ERROR`, listing field paths and issue codes only. |
| FR-003 | `Idempotency-Key` (16–128 chars of `[A-Za-z0-9._:-]`) and `X-Correlation-ID` (8–128 chars of the same set) headers must be required. A missing or invalid header must return `400` with `MISSING_IDEMPOTENCY_KEY`, `INVALID_IDEMPOTENCY_KEY`, `MISSING_CORRELATION_ID` or `INVALID_CORRELATION_ID`. |
| FR-004 | Bodies larger than 16 KiB must return `413 PAYLOAD_TOO_LARGE`. A non-JSON content type must return `415 UNSUPPORTED_MEDIA_TYPE`. Malformed JSON must return `400 INVALID_JSON`. |
| FR-005 | A repeated request with the same idempotency key and a semantically identical body must return `200` with the original `jobId`, current state and `created: false`. It must not create a job or cause an additional side effect. |
| FR-006 | A repeated idempotency key with a different body must return `409 IDEMPOTENCY_KEY_CONFLICT` and must not create a job. |
| FR-007 | The accepted job (`JOB_RECEIVED` + `READY` transition) must be appended and fsynced to the journal **before** `202` is returned. If persistence fails, the endpoint must return `503 STORAGE_UNAVAILABLE` and not `202`. |
| FR-008 | Job states and transitions must follow the typed state machine in `plan.md` §6. Invalid transitions must be rejected. |
| FR-009 | The worker must have an explicit single-cycle entry point (`npm run worker:once` → `worker --once`). Running the worker without `--once` must exit with a usage error. |
| FR-010 | Each job must run a two-step mock pipeline (`normalize`, then `deliver`). Each successful step must be persisted as `STEP_SUCCEEDED` before the next step starts. |
| FR-011 | Outcomes must be classified server-side. **Retryable:** `TIMEOUT`, `TRANSIENT`, `RATE_LIMITED` (429-like), `UPSTREAM_5XX` (5xx-like), `ADAPTER_ERROR` (unexpected throw), `WORKER_INTERRUPTED`. **Not retryable:** `PERMANENT_VALIDATION`, `PERMANENT_CLIENT_4XX` (other 4xx-like). |
| FR-012 | Step execution must be bounded by `JOB_TIMEOUT_MS` using `AbortController`. Expiry must be recorded as `TIMEOUT` without a stack trace or raw error text in state, logs or API output. |
| FR-013 | Retries must be bounded by server-owned `MAX_ATTEMPTS` (1–10). The retry delay must be deterministic: `min(MAX_BACKOFF_MS, BASE_BACKOFF_MS × 2^(attempt−1))`, with no random jitter. |
| FR-014 | A non-retryable failure, or a retryable failure on the final attempt, must transition the job to `DEAD_LETTERED` (`MAX_ATTEMPTS_EXCEEDED` keeps the last failure category). It must also append a sanitized record to `dead-letters.journal.jsonl`. A missing dead-letter record must be reconciled on the next worker cycle. |
| FR-015 | Dead-lettered jobs must remain inspectable but must never be executed by normal worker polling. |
| FR-016 | After a partial failure (step 1 succeeded, step 2 failed), retries, restarts and replays must execute only the unfinished step. |
| FR-017 | On startup, job state and the idempotency index must be reconstructed from the journal. Completed and pending jobs must remain discoverable through the API with the same runtime directory. |
| FR-018 | A `RETRY_SCHEDULED` job must keep its persisted `nextAttemptAt` across restart. It must not run before that time and must become eligible at or after it. |
| FR-019 | A job left in `PROCESSING` with an expired lease (for example, after a worker crash) must be recovered by the next worker cycle as a retryable `WORKER_INTERRUPTED` attempt, subject to `MAX_ATTEMPTS`. |
| FR-020 | Replay must be local CLI only (no HTTP endpoint). It needs `--job-id <uuid>` and `--confirm-replay`, and works only on `DEAD_LETTERED` jobs not already replayed. It creates a new job with `replayOf`, carries over completed steps, and records `JOB_REPLAYED` (`replayedAs`) on the original. |
| FR-021 | `GET /v1/jobs/:jobId` must return a safe summary: `jobId`, `state`, `attempt`, `maxAttempts`, `correlationId`, `eventType`, timestamps, `nextAttemptAt`, `failureCategory`, `lastFailureCategory`, step statuses, and `replayOf`/`replayedAs`. Unknown jobs return `404 JOB_NOT_FOUND`; non-UUID ids return `400 INVALID_JOB_ID`. |
| FR-022 | `GET /healthz` must return `200 { status: "ok" }` without exposing paths or configuration. |
| FR-023 | A malformed **final** journal record must be detected. The original bytes must be preserved, only that record ignored, a structured `journal_tail_ignored` warning emitted, and a `JOURNAL_TAIL_RECOVERED` marker appended under the write lock. Unacknowledged mid-file corruption must refuse startup with `JOURNAL_CORRUPT`. |
| FR-024 | Journal writes from separate local processes must be serialized by an exclusive lock file. A stale lock older than `STALE_LOCK_MS` must be broken and logged. If the lock can't be acquired within `LOCK_ACQUIRE_TIMEOUT_MS`, the operation must fail; the API then answers `503 STORAGE_UNAVAILABLE`. |

## Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-001 | Logs must be structured JSON, one record per line. Each record about an incoming event or a job must include `service`, `correlationId`, `jobId` (once assigned), `event`, `attempt` (when relevant), and `state` or `failureCategory`. |
| NFR-002 | Tests must be deterministic: injected clock, scripted adapters, temporary runtime directories, no network, and no wall-clock sleeps used for correctness. |
| NFR-003 | `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` must pass. `.github/workflows/ci.yml` must run `npm ci`, typecheck, lint, test and build on push and pull request, without secrets, publishing or deployment. |
| NFR-004 | Dependencies must be minimal and pinned to exact versions in `package.json`, with a committed-ready `package-lock.json`. Each dependency's purpose and license must be documented. |
| NFR-005 | The full test suite must run with one command (`npm test`). |

## Safety requirements

| ID | Requirement |
|---|---|
| SAFE-001 | Local only. The API must bind to `127.0.0.1`, adapters must be local mocks, and the application must make no outbound network requests at runtime. |
| SAFE-002 | Synthetic data only. The schema requires `source: "synthetic-demo"`. Documentation and examples must use synthetic values only: no real customer, medical, bank or vendor data. |
| SAFE-003 | Logs must never contain raw webhook bodies, idempotency-key values, Authorization headers, secrets, email addresses, phone numbers, or error stacks (by default). |
| SAFE-004 | API error responses must never include filesystem paths, stack traces, journal contents or raw payloads. |
| SAFE-005 | `.runtime/`, `.env`, logs, coverage and build output must be Git-ignored. `.env.example` must contain only non-secret local settings. Tests and the smoke script must use OS temp directories, so no runtime data is created in the project. |
| SAFE-006 | Documentation must describe the project as a tested local reference implementation with at-least-once semantics. It must not claim production readiness, exactly-once delivery, zero data loss, or compliance or certification. |
| SAFE-007 | Clients must not be able to set retry limits, delays, state names, file paths or adapter names. Optional demo outcomes are honored only when the server sets `MOCK_SCENARIOS_ENABLED=true`, and only from a closed enum. |
| SAFE-008 | Idempotency keys must be persisted only as SHA-256 hashes, never in plain text. |
