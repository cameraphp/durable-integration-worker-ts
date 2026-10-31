# Plan — durable-integration-worker (2026-10-31)

## 1. Purpose and framing

`durable-integration-worker-ts` is a **tested local reference implementation** of durable webhook
processing for integration workloads such as AI gateways, healthcare systems, fintech and SaaS APIs.
It shows engineering boundaries: ingestion, validation, idempotency, durable state, bounded
retries, timeout classification, dead letters, restart recovery and structured logs.

It is **not** a production service, a deployment, a hosted queue or a compliance artifact. It makes
no throughput, exactly-once or zero-data-loss claims. The correct claim is:

> durable, idempotency-aware, at-least-once processing in a single-host, local-file reference implementation.

## 2. Scope (local only)

In scope:
- The HTTP API, bound to `127.0.0.1`:
  - `POST /v1/webhooks/events`
  - `GET /v1/jobs/:jobId`
  - `GET /healthz`
- A separate worker CLI with an explicit single-cycle mode (`npm run worker:once`).
- A local dead-letter replay CLI that needs explicit opt-in flags.
- An append-only JSONL journal in a runtime directory (default `.runtime/`, ignored by Git).
- Deterministic mock adapters only. No network access at runtime.
- Unit and integration tests, a smoke script, and a CI workflow file (not triggered).

## 3. Explicit non-goals

- Multi-node or distributed queueing, consensus, replication, or HA.
- Exactly-once delivery or exactly-once side effects.
- Real third-party integrations, outbound HTTP, cloud SDKs, brokers, ORMs or external databases.
- Authentication or authorization for the local API. Documented as a limit; the API binds to loopback only.
- Journal compaction, rotation or retention policies.
- Continuous worker daemon mode. Only `--once` cycles are provided.
- Containers, deployment, package publishing or release automation.
- HIPAA, PCI or SOC 2 compliance, or any certification claim.

## 4. Architecture boundaries

| Layer | Directory | Responsibility | Must not |
|---|---|---|---|
| API | `src/api/` | HTTP contract, header and body validation, safe errors, safe job view | touch files directly; return payloads, paths or stacks |
| Domain | `src/domain/` | Types, state machine, transition rules, backoff, failure classification | perform I/O |
| Persistence | `src/persistence/` | Journal append and fsync, replay and rebuild, torn-tail handling, lock file, job store, idempotency index, dead-letter journal | make business decisions about retries |
| Adapters | `src/adapters/` | Typed step-execution boundary; deterministic mock adapters | contact the network |
| Worker | `src/worker/` | Claim eligible jobs, run steps with timeout, classify outcomes, schedule retries, dead-letter, recover stale leases, replay service | parse HTTP |
| Observability | `src/observability/` | Pino logger factory, redaction, safe field helpers | log raw bodies, idempotency keys, stacks |
| CLI | `src/cli/` | Process entry points: API server, `worker --once`, `replay` | contain business logic |

The clock is injected everywhere (`Clock` interface), so tests are deterministic.

## 5. Durable-journal design decision

**Decision:** use an append-only JSON Lines journal (`jobs.journal.jsonl`) as the single source of
truth for job state and the idempotency index, plus a separate sanitized operator log
(`dead-letters.journal.jsonl`).

**Why:**
- It's transparent and auditable: every transition is a line.
- It needs no external database.
- It makes restart recovery an explicit, testable replay.
- It suits a single-host reference implementation.

**Mechanics:**
1. **Writes.** Each logical write (one or more records) is serialized as `JSON + "\n"`, written with
   one `write` call through a file handle opened in append mode, then `FileHandle.sync()` (fsync)
   runs **before** the caller acknowledges anything. Directory fsync is attempted on POSIX when the
   file is first created; Windows doesn't support it, and that's documented.
2. **Records.** Every record carries `v` (schema version), `seq` (strictly increasing) and `at` (ISO
   time). Records are validated with a Zod discriminated union when read.
3. **Rebuild.** On startup (and on every refresh), the store replays records in order through the
   domain reducer. Any state-machine violation is treated as corruption.
4. **Torn tail.** If the **final** record can't be parsed (an interrupted write), the bytes stay in
   place and the record is ignored. The store emits a structured warning, and under the write lock
   it appends a newline plus a `JOURNAL_TAIL_RECOVERED` marker naming the ignored line number. Later
   reads see the malformed line immediately followed by its marker and skip it with a warning. History is never rewritten or truncated.
5. **Mid-file corruption.** An unparseable record that isn't acknowledged by a marker, an invalid
   record shape, a non-increasing `seq` or an invalid transition makes startup fail with a
   structured `JOURNAL_CORRUPT` error. Nothing is auto-repaired.
6. **Cross-process writes.** The API and worker are separate processes, so every
   refresh-decide-append sequence runs under an exclusive lock file (`journal.lock`, created with
   `O_EXCL`). It holds the pid and timestamp. A lock older than `STALE_LOCK_MS` is broken and logged.
   This is advisory locking between cooperating local processes, **not** a distributed lock.
7. **Idempotency keys** are stored only as SHA-256 hashes. A request fingerprint (SHA-256 of
   canonical JSON of the validated body) detects key reuse with a different body.

**What the journal does *not* guarantee:**
- durability beyond what the OS and disk honor for fsync;
- protection against disk loss;
- multi-host safety;
- bounded file growth.

A side effect performed by an adapter, followed by a crash before `STEP_SUCCEEDED` is synced, will
be **repeated** on retry. That is at-least-once. Adapters must therefore be idempotent per
`(jobId, step)`.

## 6. Job state machine

```text
RECEIVED -> READY -> PROCESSING -> SUCCEEDED
                         |  \
                         |   -> RETRY_SCHEDULED -> READY
                         v
                    DEAD_LETTERED
```

- `RECEIVED` is the persisted acceptance. `READY` is eligible for a worker. Both are appended in one synced write before `202`.
- `PROCESSING` carries `attempt` and `leaseExpiresAt`.
- **Terminal states:** `SUCCEEDED` and `DEAD_LETTERED`. Replay creates a **new** job linked by
  `replayOf`; the original records `replayedAs` and stays `DEAD_LETTERED`.

## 7. Implementation stages

1. **Spec:** these three files, kept internally consistent.
2. **Scaffold:** `package.json` with pinned versions, lockfile with licenses reviewed, tsconfig, ESLint, `.gitignore`, `.env.example`.
3. **Domain:** types, state machine, backoff, classification, with unit tests.
4. **Persistence:** journal, lock and job store, with journal tests (fsync count, torn tail, corruption).
5. **API:** Fastify app, schemas, error mapping, with API integration tests.
6. **Worker and adapters:** cycle, timeout, retry, dead letter, stale-lease recovery, replay, with worker tests.
7. **Observability:** logger and redaction, with log-capture tests.
8. **CLI entry points and smoke script:** run against a temporary runtime directory.
9. **Documentation:** README, `docs/`, CI workflow.
10. **Validation:** `npm ci`, typecheck, lint, test, build, smoke, then `BUILD_REPORT.md`.

## 8. Risk controls

| Risk | Control |
|---|---|
| Overclaiming | README and `docs/limitations.md` carry explicit limits; validation includes a doc check for forbidden claims (DOC-02). |
| Secret or PII leakage in logs | No body or key logging by construction; Pino redact paths; string sanitizer for email/phone shapes; log-capture tests. |
| Silent data loss on a torn write | Marker-based tail recovery; corruption refuses startup; tests. |
| Duplicate side effects | Idempotency index rebuilt from the journal; per-step completion records; tests count adapter calls. |
| Client steering server behavior | Strict schema without retry, delay, state, path or adapter fields. Demo outcomes are honored only when the server enables `MOCK_SCENARIOS_ENABLED`, and only from a closed enum. |
| Runtime data committed | `.gitignore` covers `.runtime/`, `.env`, logs, coverage and `dist/`. Tests and the smoke script use OS temp directories. |
| Real data | Schema requires `source: "synthetic-demo"`; examples are synthetic only. |
