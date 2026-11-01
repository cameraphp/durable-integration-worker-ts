# Build Report: durable-integration-worker-ts (Phase 4A)

- **Date:** 2026-10-31
- **Project path:** `C:\Users\camer\github\improvement-plan\durable-integration-worker-ts`
- **Status:** a tested local reference implementation, built and validated locally, then published as
  an initial commit on `main` at `https://github.com/cameraphp/durable-integration-worker-ts`. One
  GitHub Actions verification run for that commit succeeded (see §6 and §9). No deployment.

## 1. Environment

| Item | Value |
|---|---|
| Node.js | v24.9.0 (active LTS line) |
| npm | 11.6.0. The package manager is npm, with project-local dependencies only and no global installs. |
| OS | Windows 11 Pro (development machine) |
| Prerequisite | The Phase 3A history audit was reviewed. It found no credential needing rotation, and no code or data from the Phase 2 or Phase 3A repositories was used. |

## 2. Specification (spec-driven development)

- **Location:** [`specs/2026-10-31-durable-integration-worker/`](specs/2026-10-31-durable-integration-worker/)
  - `plan.md`: scope, boundaries, non-goals, stages, risk controls, durable-journal design decision
  - `requirements.md`: 24 FR, 5 NFR and 8 SAFE requirements (37 IDs)
  - `validation.md`: 42 test IDs plus static, doc, smoke and CI items, with a requirement-to-validation table
- The spec was written **before** any application source.
- It was updated during implementation in the same session:
  - FR-021 gained `lastFailureCategory`;
  - FR-024 gained `LOCK_ACQUIRE_TIMEOUT_MS` → `503`;
  - T-API-02 was extended to cover a real lock timeout.
- **Every requirement ID is mapped to validation evidence.** `npm run check:safety` (SC-08) checks this
  mechanically: 37 of 37 requirement IDs are mapped, and all 42 `T-*` IDs appear as test titles.

## 3. Final file inventory

The source is 2,993 lines across `src/`, `tests/` and `scripts/`.

| Area | Files |
|---|---|
| Root | `.env.example` (non-secret settings), `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `vitest.config.ts`, `README.md`, `BUILD_REPORT.md` |
| CI | `.github/workflows/ci.yml` |
| Spec | `specs/2026-10-31-durable-integration-worker/{plan,requirements,validation}.md` |
| Docs | `docs/architecture.md`, `docs/demo-walkthrough.md`, `docs/limitations.md` |
| `src/api/` | `app.ts`, `errors.ts`, `intake.ts`, `jobView.ts` |
| `src/domain/` | `backoff.ts`, `classification.ts`, `clock.ts`, `event.ts`, `events.ts`, `reducer.ts`, `stateMachine.ts`, `types.ts` |
| `src/persistence/` | `journal.ts`, `jobStore.ts`, `lock.ts`, `deadLetterJournal.ts` |
| `src/adapters/` | `types.ts`, `localMockAdapter.ts`, `sideEffects.ts` |
| `src/worker/` | `worker.ts`, `runStep.ts`, `replay.ts` |
| `src/observability/` | `logger.ts` |
| `src/cli/` | `api.ts`, `worker.ts`, `replay.ts`, `args.ts`, `runtime.ts` |
| Other `src/` | `config.ts` |
| `tests/` | `unit/domain.test.ts`, `integration/{api,journal,worker,replay,logging}.test.ts`, `support/harness.ts` |
| `scripts/` | `safety-check.mjs`, `smoke.mjs` |

Generated or local-only folders, none of them deliverables:
- `node_modules/` and `dist/` exist locally and are Git-ignored.
- `.git/` is local Git metadata. It is not a deliverable.
- `.runtime/`, `.env`, `coverage/` and logs were absent when this report was written.

## 4. Architecture and durability choices

**Layering**, with a single responsibility per directory:
- **API:** strict Zod validation, idempotent intake, safe errors and job view.
- **Domain:** a pure state machine and immutable reducer, deterministic backoff, server-side classification.
- **Persistence:** the journal, lock file, projection store and dead-letter journal.
- **Adapters:** a typed boundary and the local mock.
- **Worker:** explicit single cycles, `AbortController` timeouts, retries, dead letters, stale-lease recovery, replay.
- **Observability:** Pino plus redaction.

The clock is injected everywhere.

**State machine:**
```text
RECEIVED → READY → PROCESSING → SUCCEEDED | RETRY_SCHEDULED → READY | DEAD_LETTERED
```
It has six allowed transitions, enforced on both write and replay.

**Durable journal** (`jobs.journal.jsonl`):
- **Writes:** append-only JSON Lines, one `write` plus `FileHandle.sync()` per logical write, before any acknowledgement.
- **Ordering:** `seq` is strictly increasing.
- **Startup:** a full rebuild of jobs and the idempotency index.
- **Torn final record:** preserved, ignored, warned about and acknowledged with a `JOURNAL_TAIL_RECOVERED` marker. History is never rewritten.
- **Mid-file corruption:** startup is refused with `JOURNAL_CORRUPT`.

**Idempotency:**
- Keys are stored as SHA-256 hashes, alongside a canonical-JSON body fingerprint.
- A duplicate returns `200` with the original job.
- Reusing a key with a different body returns `409`.

**Cross-process coordination:** an advisory `journal.lock` (created with `O_EXCL`) is shared by the API and worker processes, with stale-lock breaking.

**Claim:** durable, idempotency-aware, **at-least-once** processing in a single-host, local-file
reference implementation. No exactly-once or production claim is made.

## 5. Dependencies

All versions are pinned exactly (verified by SC-05), and the lockfile is v3 with 207 packages.

| Package | Version | License | Why it exists |
|---|---|---|---|
| `fastify` | 5.12.7 | MIT | Small HTTP framework: routing, body limit, `inject()` for in-process API tests |
| `zod` | 4.6.7 | MIT | Runtime schemas: strict webhook envelope, headers, journal records, config bounds |
| `pino` | 10.4.0 | MIT | Structured JSON logging with redaction paths and formatters |
| `typescript` (dev) | 6.0.3 | Apache-2.0 | Type-checking and build. 7.x was skipped because `typescript-eslint` 8.72 supports `<6.1.0`. |
| `vitest` (dev) | 5.0.5 | MIT | Focused test runner |
| `eslint` (dev) | 10.14.0 | MIT | Linting |
| `@eslint/js` (dev) | 10.0.1 | MIT | ESLint recommended rules |
| `typescript-eslint` (dev) | 8.72.1 | MIT | TypeScript lint rules |
| `@types/node` (dev) | 24.19.2 | MIT | Node 24 type definitions |

**License review of the lockfile:**
- **Runtime tree:** 55 packages, all MIT (46), BSD-3-Clause (6) or ISC (3).
- **Dev-only tooling:** also includes Apache-2.0, BSD-2-Clause and BlueOak-1.0.0, plus `lightningcss` and its platform binaries under **MPL-2.0**.
  - `lightningcss` arrives transitively through Vite/Vitest.
  - It's used only at test time and is not part of the runtime or shipped code.
  - It's noted here for the owner's license decision.

No ORM, message broker, cloud SDK, Docker or external database is used.

## 6. Validation commands and results

These were run inside the project directory after a clean `npm ci`.

| Command | Result |
|---|---|
| `npm ci --no-audit --no-fund` | ✅ exit 0, 207 packages installed from the lockfile |
| `npm run typecheck` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0 (0 problems) |
| `npm run check:safety` | ✅ exit 0. All 8 checks passed: SC-03, SC-05, SC-06, SC-07, SC-08, DOC-01, DOC-02, DOC-03. |
| `npm test` | ✅ exit 0: **6 test files, 42 tests passed** |
| `npm run build` | ✅ exit 0 (`dist/` emitted, Git-ignored) |
| `npm run smoke` | ✅ exit 0: `SMOKE OK`, 16 assertions |

**Honest note:** the first attempt at this sequence failed at `npm ci` with a transient Windows
`EBUSY` while it was removing `node_modules/@fastify/ajv-compiler`. No node process was running at
the time, so something else on the machine likely had a file open. The rest of that run then failed
because the install was incomplete. Re-running the identical sequence passed every step. No test or
check was weakened.

**Test breakdown (42):**

| Area | IDs | Tests |
|---|---|---|
| Domain and config | `T-SM-01`–`03`, `T-BO-01`, `T-CL-01`, `T-CFG-01` | 6 |
| Journal | `T-JR-01`–`04` | 4 |
| API | `T-API-01`–`11` | 11 |
| Worker | `T-WK-01`–`14` | 14 |
| Replay | `T-RP-01`–`04` | 4 |
| Logging | `T-LOG-01`–`03` | 3 |

All 14 required test scenarios are covered:
- persist-before-`202`;
- schema, header, size and unknown-field rejection;
- duplicate delivery with a single side effect;
- transient retry, timeout, permanent dead letter and max-attempts dead letter;
- partial-failure resume;
- restart rebuild, and the retry schedule surviving a restart;
- replay opt-in with an audit link;
- log fields and redaction;
- torn-tail handling;
- the safe job view.

**CI verification after publication:** `.github/workflows/ci.yml` was first reviewed locally (CI-01):
- push and PR triggers;
- `permissions: contents: read`;
- runs `npm ci`, typecheck, lint, `check:safety`, test and build;
- no secrets, publishing or deployment.

GitHub Actions then ran once after the initial push:
- **Commit:** `5c1985b2f374f1ad972359758330c9a85283ae67`
- **Run:** https://github.com/cameraphp/durable-integration-worker-ts/actions/runs/41253716593
- **Result:** completed successfully.
- **Steps:** the `verify` job ran checkout, setup-node, `npm ci`, typecheck, lint, `check:safety`, tests and build. Every step succeeded.

This records one observed successful run for that commit. It is not a promise that later commits will pass CI.

## 7. Local demo (smoke) result

`npm run smoke` ran the **built** CLI processes:
- **Setup:** a runtime directory under the OS temp folder, an API on a free `127.0.0.1` port, synthetic events, and `MOCK_SCENARIOS_ENABLED=true`.
- **Delivery and idempotency:** the first POST returned `202`, and a duplicate returned the same job with `200 created:false`.
- **Worker:** a `transient_once` event was accepted. `worker --once` exited 0 and printed a structured summary; `worker` without `--once` was refused with exit 2.
- **Results:** job A was `SUCCEEDED`, and its view had no payload fields. Job B was `RETRY_SCHEDULED (UPSTREAM_5XX)`.
- **Restart:** after killing and restarting the API, job B kept the same `nextAttemptAt`, job A was still `SUCCEEDED`, and the idempotency index survived.
- **Side effects:** exactly one mock side effect for job A.
- **Logs:** API logs carried correlation IDs and no idempotency keys.
- **Hygiene:** no `.runtime/` was created inside the project.

The temp directory was removed afterwards. The human-run 3–5 minute walkthrough is in
[`docs/demo-walkthrough.md`](docs/demo-walkthrough.md). It hasn't been recorded, and no video was created.

## 8. Known limits and deliberate non-goals

Full detail is in [`docs/limitations.md`](docs/limitations.md).

- **Delivery:** at-least-once only. Adapters must be idempotent per `(jobId, step)`.
- **Scope:** single host, one worker at a time. The lock file is advisory, and stale-lock detection is age-based.
- **Durability:** bounded by OS and disk `fsync` behaviour. Windows has no directory `fsync`. There's no replication, compaction or rotation.
- **Security:** no authentication on the loopback-only API. Synthetic payloads are stored in plain text in the local journal.
- **Integrations:** mock adapter only. No outbound network, deployment, container, package or load test.
- **Not claimed:** production readiness, exactly-once delivery, zero data loss, or any compliance or certification.
- **License:** none chosen yet; that's the owner's decision.

## 9. Actions taken and not taken

### Initial local build actions not taken (Phase 4A)

The Phase 4A build itself did **not**:
- create a GitHub repository or use `gh`;
- run `git init`, commit, push or configure a remote;
- modify any existing repository or earlier audit folder;
- deploy, publish an npm package, build a container image or create a release;
- trigger CI;
- use any real API key, webhook, customer, medical, bank or vendor data;
- make any third-party integration or outbound application network call;
- record or commit a video.

All Phase 4A files were created only inside the project directory.

### Subsequent publication record (Phase 4B)

With owner approval, Phase 4B later:
- initialized the local Git repository on `main`;
- made one normal commit, `5c1985b2f374f1ad972359758330c9a85283ae67`
  (`feat: add durable integration worker reference`);
- pushed `main` once to `origin` (`https://github.com/cameraphp/durable-integration-worker-ts.git`);
- observed one successful GitHub Actions run:
  https://github.com/cameraphp/durable-integration-worker-ts/actions/runs/41253716593.

Before that commit, line endings in three files (`src/api/app.ts`, `src/config.ts`,
`tests/support/harness.ts`) were changed from CRLF to LF, and a trailing blank line was removed from
`src/worker/worker.ts`. These were whitespace-only changes, made with owner approval after
`git diff --cached --check` flagged them. The full validation sequence in §6 was then re-run and passed.

The following did **not** happen: a force push, release, deployment, package publication, license
selection, video, or any GitHub settings change.

## 10. Report freshness

This report is accurate through the initial publication and CI observation. Its verifiable anchors
are commit `5c1985b2f374f1ad972359758330c9a85283ae67` and Actions run
https://github.com/cameraphp/durable-integration-worker-ts/actions/runs/41253716593. Later commits,
including the one that updates this report, aren't covered by the evidence above.
