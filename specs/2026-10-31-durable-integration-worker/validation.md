# Validation — durable-integration-worker (2026-10-31)

Every requirement in [`requirements.md`](./requirements.md) is mapped to at least one validation item
below. Test titles in `tests/` begin with the validation ID (for example `T-API-01`), and
`scripts/safety-check.mjs` (run by `npm run check:safety`) verifies that every `T-*` ID listed here
appears in a test title.

## 1. Validation items

### Unit tests: domain and config (`tests/unit/`)

| ID | Validation | Expected result |
|---|---|---|
| T-SM-01 | Every allowed transition in the state machine is accepted | All 6 allowed transitions return OK |
| T-SM-02 | Disallowed transitions are rejected (for example `SUCCEEDED→READY`, `DEAD_LETTERED→READY`, `READY→SUCCEEDED`, `RECEIVED→PROCESSING`) | `InvalidTransitionError` thrown |
| T-SM-03 | The reducer folds a journal event sequence into the expected job view (attempts, steps, failure category, `nextAttemptAt`, replay links) | Exact object match |
| T-BO-01 | Backoff is deterministic exponential with a cap | `base=1000, max=8000` gives 1000, 2000, 4000, 8000, 8000 |
| T-CL-01 | Classification table | 429→`RATE_LIMITED`/retryable; 503→`UPSTREAM_5XX`/retryable; 404→`PERMANENT_CLIENT_4XX`/not retryable; validation→`PERMANENT_VALIDATION`/not retryable; transient→`TRANSIENT`/retryable; timeout→`TIMEOUT`/retryable; throw→`ADAPTER_ERROR`/retryable |
| T-CFG-01 | Config parsing enforces server-owned bounds | `MAX_ATTEMPTS=0` and `MAX_ATTEMPTS=11` rejected; defaults applied; `HOST` is always `127.0.0.1` |

### Persistence tests (`tests/integration/journal.test.ts`)

| ID | Validation | Expected result |
|---|---|---|
| T-JR-01 | Appends are fsynced and readable after reopening | `syncCount` increments once per logical write; records reload in order with strictly increasing `seq` |
| T-JR-02 | Torn final record | Original bytes still present; record ignored; `journal_tail_ignored` warning; marker appended; later reload reports the acknowledged warning and accepts new appends |
| T-JR-03 | Unacknowledged mid-file corruption | Opening the store throws `JournalCorruptError` (`JOURNAL_CORRUPT`); file unchanged |
| T-JR-04 | Lock file behavior | A fresh foreign lock blocks until `LockTimeoutError`; a stale lock is broken with a `journal_lock_stale_broken` warning |

### API integration tests (`tests/integration/api.test.ts`)

| ID | Validation | Expected result |
|---|---|---|
| T-API-01 | Valid webhook | `202`; a store opened fresh from disk right after the response contains the job in `READY` |
| T-API-02 | Persistence failure | (a) Injected intake failure and (b) a real lock timeout against a fresh foreign `journal.lock` both give `503 STORAGE_UNAVAILABLE`; no `202`; no job persisted |
| T-API-03 | Schema rejection | Unknown top-level and nested fields, wrong types and wrong `source` give `400 VALIDATION_ERROR` with paths and codes only (no values) |
| T-API-04 | Header validation | Missing or invalid `Idempotency-Key` / `X-Correlation-ID` give the four documented codes |
| T-API-05 | Body and content limits | 17 KiB body → `413`; `text/plain` → `415`; malformed JSON → `400 INVALID_JSON` |
| T-API-06 | Duplicate delivery | Second identical request → `200`, same `jobId`, `created:false`; journal has one `JOB_RECEIVED`; after a worker cycle the side-effect counter is 1 |
| T-API-07 | Idempotency conflict | Same key, different body → `409 IDEMPOTENCY_KEY_CONFLICT`; no new job |
| T-API-08 | Safe job view | Response excludes payload values (`referenceId`, `note`, `eventId`); `404 JOB_NOT_FOUND`; `400 INVALID_JOB_ID` |
| T-API-09 | Health | `200 {status:"ok"}` only |
| T-API-10 | Safe errors | No error body contains the runtime directory path, `stack`, `    at ` frames or journal lines |
| T-API-11 | No client control | Bodies with `maxAttempts`, `state`, `delayMs`, `adapter` or `runtimeDir` → `400`; `demoOutcome` ignored when `MOCK_SCENARIOS_ENABLED=false` |

### Worker tests (`tests/integration/worker.test.ts`)

| ID | Validation | Expected result |
|---|---|---|
| T-WK-01 | Success path | `SUCCEEDED`, attempt 1, both steps `SUCCEEDED`, one side effect |
| T-WK-02 | Transient failure | `RETRY_SCHEDULED`, attempt 1, `nextAttemptAt = now + 1000ms`; a cycle before that time does nothing; after it → `SUCCEEDED`, attempt 2 |
| T-WK-03 | Timeout | `RETRY_SCHEDULED` with `TIMEOUT`; adapter's `AbortSignal` aborted; no stack or raw message in state, logs or API view |
| T-WK-04 | Permanent failure | `DEAD_LETTERED` on attempt 1 with `PERMANENT_CLIENT_4XX`; dead-letter journal has one sanitized record |
| T-WK-05 | Max attempts | With `MAX_ATTEMPTS=3`: delays 1000 then 2000; third failure → `DEAD_LETTERED`, `MAX_ATTEMPTS_EXCEEDED`, `lastFailureCategory=UPSTREAM_5XX` |
| T-WK-06 | Partial failure | `normalize` succeeds and `deliver` fails; after restart (new store and worker) and retry, `normalize` was called exactly once and `deliver` twice |
| T-WK-07 | Restart recovery | A new store over the same directory rebuilds all jobs and states; a duplicate POST after restart returns the original `jobId` |
| T-WK-08 | Retry schedule survives restart | After restart, `nextAttemptAt` is unchanged; a cycle 1 ms early does nothing; at the time it runs |
| T-WK-09 | Dead letters not polled | Further cycles leave the `DEAD_LETTERED` job untouched; adapter call count unchanged |
| T-WK-10 | Stale lease recovery | A `PROCESSING` job with an expired lease → `RETRY_SCHEDULED` with `WORKER_INTERRUPTED` (or dead-lettered if attempts are exhausted) |
| T-WK-11 | Dead-letter reconciliation | A `DEAD_LETTERED` job missing from the dead-letter journal gets exactly one record on the next cycle |
| T-WK-12 | Adapter throw | Unexpected throw → `ADAPTER_ERROR`, retryable, no stack or message persisted or logged |
| T-WK-13 | Worker CLI mode | `parseWorkerArgs([])` → usage error; `['--once']` → once mode |
| T-WK-14 | No network | Cycle with the default local adapter succeeds while `globalThis.fetch` is stubbed to throw |

### Replay tests (`tests/integration/replay.test.ts`)

| ID | Validation | Expected result |
|---|---|---|
| T-RP-01 | Replay CLI opt-in | Missing `--confirm-replay`, missing or invalid `--job-id` → usage error |
| T-RP-02 | Replay audit link | New job with `replayOf=<original>`; original has `replayedAs`; original stays `DEAD_LETTERED`; replay skips the already-completed `normalize` |
| T-RP-03 | Replay guards | Non-dead-lettered or already-replayed job → `ReplayRefusedError` |
| T-RP-04 | No HTTP replay | `POST /v1/jobs/:id/replay` → `404` |

### Logging tests (`tests/integration/logging.test.ts`)

| ID | Validation | Expected result |
|---|---|---|
| T-LOG-01 | Required fields | Accept and worker records include `service`, `correlationId`, `jobId`, `event`, `attempt` (worker), and `state` or `failureCategory` |
| T-LOG-02 | Redaction end to end | Captured logs contain none of: note text, email, phone, idempotency key, Authorization header value, `stack` |
| T-LOG-03 | Sanitizer defense in depth | Logging a string with email or phone shapes emits `[redacted-email]` / `[redacted-phone]` |

### Static, document, smoke and CI checks

| ID | Validation | Expected result |
|---|---|---|
| SC-01 | `npm run typecheck` | exit 0 |
| SC-02 | `npm run lint` | exit 0 |
| SC-03 | `npm run check:safety`: `src/` has no outbound network APIs (`fetch(`, `http.request`, `https`, `net.connect`, `undici`, `axios`) and listens on `127.0.0.1` only | passes |
| SC-04 | `npm run build` | exit 0; `dist/` emitted (ignored) |
| SC-05 | `check:safety`: all `package.json` versions are exact | passes |
| SC-06 | `check:safety`: `.gitignore` includes `.runtime/`, `.env`, `*.log`, `coverage/`, `dist/`, `node_modules/` | passes |
| SC-07 | `check:safety`: no `.env` file exists; `.env.example` keys ⊆ allowlist of non-secret settings | passes |
| SC-08 | `check:safety`: every `T-*` ID in this file appears in a test title | passes |
| SC-09 | `npm test` | all tests pass (one command) |
| DOC-01 | `check:safety`: README has limits section, Mermaid block, `Demo walkthrough` section linking `docs/demo-walkthrough.md`, and journal guarantees section | passes |
| DOC-02 | `check:safety`: forbidden claims (`production-ready`, `exactly-once`, `zero data loss`, `HIPAA compliant`, `certified`) appear only on lines that also contain a negation | passes |
| DOC-03 | `docs/architecture.md` (with a correlation-ID flow section), `docs/demo-walkthrough.md`, `docs/limitations.md` exist | present (`check:safety`) |
| DOC-04 | `BUILD_REPORT.md` lists each dependency with purpose and license | manual review |
| SMK-01 | `npm run smoke` against a temp runtime dir: first POST `202`; duplicate returns the same job; `worker --once` processes; GET is safe; API restart preserves a `RETRY_SCHEDULED` job; project has no `.runtime/` afterwards | prints `SMOKE OK` |
| CI-01 | `.github/workflows/ci.yml` review | push and PR triggers; `permissions: contents: read`; `npm ci`, typecheck, lint, `check:safety`, test, build; no secrets, publish or deploy |

## 2. Requirement → validation mapping

| Requirement | Validation items |
|---|---|
| FR-001 | T-API-01, SMK-01 |
| FR-002 | T-API-03, T-API-11 |
| FR-003 | T-API-04 |
| FR-004 | T-API-05 |
| FR-005 | T-API-06, T-WK-07, SMK-01 |
| FR-006 | T-API-07 |
| FR-007 | T-API-01, T-API-02, T-JR-01 |
| FR-008 | T-SM-01, T-SM-02, T-SM-03 |
| FR-009 | T-WK-13, SMK-01 |
| FR-010 | T-WK-01, T-WK-06 |
| FR-011 | T-CL-01, T-WK-02, T-WK-03, T-WK-04, T-WK-12 |
| FR-012 | T-WK-03 |
| FR-013 | T-BO-01, T-CFG-01, T-WK-02, T-WK-05 |
| FR-014 | T-WK-04, T-WK-05, T-WK-11 |
| FR-015 | T-WK-09 |
| FR-016 | T-WK-06, T-RP-02 |
| FR-017 | T-WK-07, SMK-01 |
| FR-018 | T-WK-08, SMK-01 |
| FR-019 | T-WK-10 |
| FR-020 | T-RP-01, T-RP-02, T-RP-03, T-RP-04 |
| FR-021 | T-API-08 |
| FR-022 | T-API-09 |
| FR-023 | T-JR-02, T-JR-03 |
| FR-024 | T-JR-04 (lock timeout + stale break), T-API-02 (any persistence failure, including a lock timeout, maps to `503`) |
| NFR-001 | T-LOG-01 |
| NFR-002 | All `tests/` use the injected `ManualClock` and temp dirs; SC-09 |
| NFR-003 | SC-01, SC-02, SC-04, SC-09, CI-01 |
| NFR-004 | SC-05, DOC-04 |
| NFR-005 | SC-09 |
| SAFE-001 | SC-03, T-WK-14, T-CFG-01 |
| SAFE-002 | T-API-03 (`source` literal), DOC-02 |
| SAFE-003 | T-LOG-02, T-LOG-03, T-WK-03, T-WK-12 |
| SAFE-004 | T-API-10, T-API-03 |
| SAFE-005 | SC-06, SC-07, SMK-01 |
| SAFE-006 | DOC-01, DOC-02 |
| SAFE-007 | T-API-11, T-CFG-01 |
| SAFE-008 | T-API-06 (journal inspected: key absent, hash present) |
