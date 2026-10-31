# Limitations and deliberate non-goals

`durable-integration-worker-ts` is a **tested local reference implementation**. These limits are deliberate.

## Delivery semantics

- **At-least-once, not exactly-once.** If the process crashes after an adapter performs a side effect
  but before `STEP_SUCCEEDED` is fsynced, that step runs again on retry. Real adapters must be
  idempotent per `(jobId, step)`.
- **Idempotency scope.** Keys are unique per runtime directory, with no expiry or TTL. Reusing a key with a
  different body is rejected with `409`, never merged.

## Durability

- Durability is only as strong as the OS and disk honour `fsync`. Windows doesn't support
  directory `fsync`.
- There's one local file and no replication, so a disk loss loses the journal.
- There's no compaction, rotation or retention: the journal grows without bound.
- Mid-file corruption stops the service by design. Recovery is a manual operator decision.

## Concurrency and scale

- Single host only. The `journal.lock` file is advisory and local. Stale-lock breaking is a heuristic
  based on lock age.
- The worker runs one explicit cycle per invocation (`--once`). There's no daemon mode, and only one
  worker at a time is in tested scope.
- Every read replays from the in-memory projection. There's no indexing beyond in-memory maps, and no
  throughput or latency figures are claimed.

## Security and privacy

- The local API has no authentication or authorization; it binds to `127.0.0.1` only.
- Payloads are synthetic by contract (`source: "synthetic-demo"`) and are stored in the local journal
  in plain text. Don't put real personal, medical, financial or secret data in events.
- Log redaction is defense in depth, not a data-loss-prevention product.

## Integrations

- The only adapter is a deterministic local mock. There are no HTTP clients, SDKs, brokers or databases.
- Demo outcomes (`data.demoOutcome`) are a server-enabled test feature, off by default.

## Not claimed

- Not production-ready.
- No exactly-once delivery.
- No zero-data-loss guarantee.
- Not HIPAA, PCI or SOC 2 compliant, and not certified for any regime.
- Not deployed, containerised, published or load-tested.
