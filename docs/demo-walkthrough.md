# Demo walkthrough (human-run, 3–5 minutes)

This plan is for a person to run and record in a terminal. It uses **synthetic events, local state
and the mock adapter only**: no real data and no external calls. Nothing is recorded or published
by this repository.

The commands use `bash` (Git Bash, macOS or Linux). In Windows PowerShell, call `curl.exe` instead of
`curl`. Use two terminals: **A** runs the API, **B** sends requests and runs the worker.

## 0. Clean local runtime (≈20 s)

```bash
npm ci && npm run build
rm -rf .runtime                      # runtime state lives here and is Git-ignored
export RUNTIME_DIR=.runtime/demo MOCK_SCENARIOS_ENABLED=true BASE_BACKOFF_MS=5000 JOB_TIMEOUT_MS=1500 MAX_ATTEMPTS=3
```

Say: *"Local only, synthetic events, mock adapter. The demo outcomes are a server-side switch."*

## 1. Start the API (terminal A, ≈10 s)

```bash
npm run start:api      # binds 127.0.0.1:3000 and logs JSON lines
```

## 2. Webhook acceptance and duplicate idempotency (terminal B, ≈40 s)

```bash
# Define this in B (export the same variables as step 0 there too)
post() { curl -s -X POST http://127.0.0.1:3000/v1/webhooks/events -H 'content-type: application/json' \
  -H "Idempotency-Key: $1" -H "X-Correlation-ID: $2" -d "$3"; echo; }
ev() { echo "{\"eventId\":\"evt_DEMO$1\",\"type\":\"synthetic.order.created\",\"occurredAt\":\"2026-10-31T12:00:00Z\",\"source\":\"synthetic-demo\",\"data\":{\"referenceId\":\"SYN-$1\"$2}}"; }

post demo-key-success-01 corr-demo-ok   "$(ev 000101)"        # 202 created:true
post demo-key-success-01 corr-demo-ok-2 "$(ev 000101)"        # 200 created:false, same jobId
post demo-key-success-01 corr-demo-ok-3 "$(ev 000999)"        # 409 IDEMPOTENCY_KEY_CONFLICT
```

Point out: *the job was fsynced to the journal before the 202; the key is stored only as a hash.*

## 3. Worker success (≈30 s)

```bash
npm run worker:once
curl -s http://127.0.0.1:3000/v1/jobs/<jobId-from-step-2>; echo   # SUCCEEDED, attempt 1, no payload fields
```

## 4. Transient retry and timeout classification (≈50 s)

```bash
post demo-key-transient-01 corr-demo-retry   "$(ev 000201 ',"demoOutcome":"partial_once"')"
post demo-key-timeout-0001 corr-demo-timeout "$(ev 000301 ',"demoOutcome":"timeout_once"')"
npm run worker:once
curl -s http://127.0.0.1:3000/v1/jobs/<retry-jobId>; echo    # RETRY_SCHEDULED, UPSTREAM_5XX, normalize SUCCEEDED
curl -s http://127.0.0.1:3000/v1/jobs/<timeout-jobId>; echo  # RETRY_SCHEDULED, TIMEOUT (no stack anywhere)
```

Say: *"Timeouts use AbortController and are retryable. The delay is deterministic: 5 s, then 10 s."*

## 5. Dead-letter result (≈30 s)

```bash
post demo-key-permanent-01 corr-demo-dlq "$(ev 000401 ',"demoOutcome":"permanent"')"
npm run worker:once
curl -s http://127.0.0.1:3000/v1/jobs/<dlq-jobId>; echo     # DEAD_LETTERED, PERMANENT_CLIENT_4XX
cat .runtime/demo/dead-letters.journal.jsonl                 # sanitized record, no payload
```

Optional: `npm run replay:dead-letter -- --job-id <dlq-jobId>` is refused without `--confirm-replay`.

## 6. Restart recovery (≈40 s)

In terminal A, press Ctrl+C, then run `npm run start:api` again. Then in terminal B:

```bash
curl -s http://127.0.0.1:3000/v1/jobs/<retry-jobId>; echo   # still RETRY_SCHEDULED, same nextAttemptAt
post demo-key-success-01 corr-demo-ok-4 "$(ev 000101)"      # still the original job (index rebuilt from journal)
sleep 6 && npm run worker:once                              # retry due: only `deliver` runs (normalize skipped)
curl -s http://127.0.0.1:3000/v1/jobs/<retry-jobId>; echo   # SUCCEEDED, attempt 2
```

## 7. Structured logs and correlation IDs (≈30 s)

Show terminal A and the worker output. Each job line has `service`, `correlationId`, `jobId`,
`event`, `attempt`, and `state` or `failureCategory`. Point out what is absent: no bodies, no
idempotency keys, no stacks. For example:

```bash
post demo-key-logs-000001 corr-demo-logs "$(ev 000501)"
npm run worker:once 2>&1 | grep corr-demo-logs   # every line for this job carries the same correlationId
```

## 8. Limitations and close (≈20 s)

Say: *"This is a tested local reference implementation: single host, local-file journal,
at-least-once, mock adapter. It's not a production service, and there's no exactly-once claim."*
Point to [`limitations.md`](limitations.md). Then clean up with `rm -rf .runtime`.
