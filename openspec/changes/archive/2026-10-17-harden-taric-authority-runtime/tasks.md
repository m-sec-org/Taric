# Tasks

## 1. Identity and proposal boundary

- [x] 1.1 Update `packages/schemas` and Core validation types for proposal envelope fields (`proposal_id`, `client_request_id`, `target_id`/`subject_ref`, expected version), proposal-only provenance, explicit candidate `kind`, and UUIDv7 canonical identity; verify schema tests reject generic/non-v7 canonical IDs and privileged create fields.
- [x] 1.2 Refactor `AuthorityStore` and service proposal submission so new canonical IDs are allocated by Core, updates resolve an explicit target, and invalid subject/kind, required fields, references, ownership, provenance, and schema version fail before inserting a proposal; verify zero-state-change tests cover the minimal claim-without-kind reproduction and valid evidence-incomplete proposals remain pending.
- [x] 1.3 Migrate engagement initialization, commit/update paths, snapshot export/import validation, and existing fixtures to the new identity model; verify create/update/id-reuse/cross-engagement/wrong-kind tests and snapshot contract tests pass.

## 2. Governance phase semantics

- [x] 2.1 Separate L1 deterministic admission response data from L2 policy inputs in Core, including `trust_phase`, policy digest/version, and explicit remaining L2 requirements; verify L1 tests do not claim evidence/freshness/independence gates.
- [x] 2.2 Add the explicit `admission.promote_l2` Core operation and registry entries with writer/operator authorization, finding-only target validation, fixed evidence/reviewer binding, and atomic promotion; verify model, host, reviewer-only, stale, and independent-review cases return stable errors or L2 success.
- [x] 2.3 Update CLI, MCP, adapter operation inventories, schemas, API docs, and governance fixtures for the new operation and roles; verify registry/release-support tests agree on operation availability and capability states.

## 3. Unified runtime startup and errors

- [x] 3.1 Extract the shared authority startup resolver used by CLI and MCP, including persistent single-host default, content root, deployment diagnostics, explicit `:memory:` test behavior, and fail-closed multi-host selection; verify CLI/MCP resolve identical configuration and restart preserves a committed record.
- [x] 3.2 Switch MCP construction to the shared resolver and ensure initialize/diagnostic output never exposes local paths; verify stdio protocol tests use a persistent temporary authority and remain JSON-only on stdout.
- [x] 3.3 Replace message-substring error classification with typed/stable Core error codes and sanitized unknown-error handling; verify service, CLI, MCP, and adapter tests assert public codes/messages without leaking internal exception text.
- [x] 3.4 Repair adapter RPC buffering to process all complete newline-delimited frames and retain partial frames; verify pipelined, partial, malformed, authorization, and connection-lifecycle tests.

## 4. Authority scale and maintenance isolation

- [x] 4.1 Add SQLite indexes and batched reference validation for Engagement/kind/version/object-reference queries; verify query plans or instrumentation demonstrate one bounded lookup per reference batch and preserve isolation results.
- [x] 4.2 Add keyset pagination for large authority lists and distinguish commit/admission p95 from snapshot/export materialization; verify deterministic no-duplicate/no-omission pagination and 10k/50k benchmark fixtures record time, peak memory, and source sequence.
- [x] 4.3 Enforce operator-only authorization and pinned read/watermark reporting for doctor, verify, reconcile, and snapshot export, with an isolated process/connection path where used; verify concurrent-writer and no-history-mutation tests.
- [x] 4.4 Update authority-storage documentation and runbook with the benchmark interpretation and maintenance profile; verify documented commands match the capability report.

## 5. Persistent context cursors

- [x] 5.1 Implement versioned 0600 cursor key storage bound to the authority/content root with explicit rotation and invalidation behavior; verify key permission, missing-key, rotation, and restart tests.
- [x] 5.2 Replace full-record cursor payloads with fixed snapshot/read-sequence bindings and re-fetchable filter/offset/delivered-id state; verify restart, multi-instance, tampering, principal/Engagement/filter/budget binding, and no-duplicate/no-omission tests.
- [x] 5.3 Add first-page versus continuation benchmarks and update context recovery documentation; verify the report separates initial snapshot cost from cursor continuation cost.

## 6. Shared backend activation gate

- [x] 6.1 Define the sync/async-capable backend facade required by Core governance, Artifact catalog, lease/fencing, audit/outbox, pinned reads, and backup operations; verify SQLite behavior remains unchanged through its conformance adapter.
- [x] 6.2 Extend PostgreSQL persistence and health/conformance coverage for proposal, review, admission, checkpoint, action, Artifact, lease, fencing, audit/outbox, snapshot, and restore semantics; verify any mismatch reports failed and does not enable multi-host runtime.
- [x] 6.3 Wire the multi-host service factory only after conformance and health checks pass, with no SQLite fallback; verify primitive-only PostgreSQL reports `implementation_state=available` and `runtime_state=disabled`.
- [x] 6.4 Update shared-authority runbook and release report to distinguish backend primitives from runtime enablement; verify single-host releases remain PostgreSQL-independent.

## 7. Artifact durability and bounded transport

- [x] 7.1 Add Artifact deployment profile metadata and benchmark harness for decoded chunk bytes, transport envelope, peak RSS, throughput, latency, and concurrent uploads; verify reports are reproducible for textual and binary fixtures without changing the 64 MiB contract.
- [x] 7.2 Add failure injection around publication rename, manifest/catalog commit, restart, and reconcile; verify markers, hashes, unavailable/integrity states, and absence of unverified content for every fault point.
- [x] 7.3 Document process-crash versus power-loss durability and fsync/rename costs, and update capability evidence; verify non-durable profiles do not advertise power-loss guarantees.

## 8. Capability evidence and release integration

- [x] 8.1 Add explicit capability metadata fields for implementation, runtime, evidence, and follow-up state; update compatibility/release-support checks so archived changes do not automatically imply enabled runtime capabilities. Verify PostgreSQL and quality-evidence pending states are represented accurately.
- [x] 8.2 Add quality evidence provenance for annotators/review process, dataset version, sample digest, time range, and human baseline; verify insufficient-sample layers fail closed in release reports.
- [x] 8.3 Update `docs/taric-implementation-analysis-review.md` references, API/design/runbook documentation, and capability inventory for the corrected 14-spec baseline, actual test counts, L1/L2 semantics, and Artifact behavior; verify documented paths/anchors resolve.
- [x] 8.4 Run the clean-checkout build, typecheck, unit/conformance suite, adapter tests, scale/fault benchmarks, and release report; technical/runtime failures block implementation completion. Per the operator decision on 2026-10-15, missing human quality evidence affects the quality release gate only and does not block `implementation_complete`.
