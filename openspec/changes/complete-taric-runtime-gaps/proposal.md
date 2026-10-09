# Proposal

## Why

The archived Taric design and first implementation define the intended contracts, but the repository still contains only a partial runtime. CLI and MCP are name lists, native adapters are facades, the public writer can bypass proposal governance, several schemas and guards are missing, and projection/Git/recovery behavior is incomplete. This change closes the remaining runtime gaps so the documented implementation targets become executable and testable.

## What Changes

- Add a real Core service boundary with versioned request/response contracts, capability checks, allowlist projections, idempotency, and structured errors.
- Implement the documented operator CLI and MCP transport using the same Core service. Keep model tools separate from host/operator writer and checkpoint operations.
- Enforce non-LLM writer authority. Reject caller-supplied trust levels, pre-admitted proposal states, invalid references, stale versions, and unbound reviewer identities.
- Complete domain schemas and guards for hypotheses, resource revisions, controls, access decisions, patches, WorkRuns, Attempts, checkpoints, actions, and audit events.
- Make audit state transitions complete and atomic. Add authority, counter, outbox, projection, and replay/reconcile verification.
- Implement true pinned snapshots, prioritized Context Packs, resumable cursors, and coverage/control semantics.
- Complete WorkRun lease renewal/reclaim, Attempt state, checkpoint validation, fencing across every write path, resume deltas, and late-result quarantine.
- Make Markdown generations atomic and permission-checked. Add default local Git checkpoints and explicit, guarded remote-push callbacks.
- Replace adapter facades with contract-driven transport hooks and diagnostics. Add real lifecycle bridges where host APIs are available, and report unsupported capabilities otherwise.
- Add schema migrations, Taric-native JSON/JSONL snapshot round-trip, replay/reconcile, and backup/recovery for the local authority. Add PostgreSQL only as a conditional backend for explicitly configured multi-host deployments; it is not a single-host release blocker.
- Make clean checkout validation build before tests and run CLI, MCP, Core, Hermes, concurrency, crash, poisoning, projection, and quality evaluation suites with explicit release gates.

## Capabilities

### New Capabilities

- `taric-runtime-api`: versioned Core service, operator API, MCP handlers, CLI dispatch, permissions, idempotency, and errors.
- `authority-storage`: atomic transactions and IDs, revisions and snapshots, outbox/replay/recovery, migrations, backups, and optional PostgreSQL shared authority.
- `quality-evaluation`: reproducible conformance, concurrency, crash, poisoning, coverage, and finding-quality release evaluation.

### Modified Capabilities

- `engagement-memory`: extend the existing memory contract with complete schemas, cross-field validation, real query/API access, and complete coverage/control semantics.
- `memory-governance`: enforce writer isolation and make proposal/review/admission/audit transitions atomic and externally observable.
- `collaboration-state`: extend WorkRun behavior with Attempt, renewal/reclaim, fencing on all writes, resume deltas, and validated checkpoints.
- `host-action-integration`: add structured action recommendation, host decision validation, idempotency, and result reconciliation.
- `host-adapters`: replace descriptor-only facades with executable contract operations and truthful capability reporting.
- `markdown-projection`: add generation manifests, service-level permissions, Git checkpoint execution, and retry/pending behavior.

## Impact

- Affects `packages/core`, `packages/cli`, `packages/mcp`, `packages/schemas`, and `packages/hermes-plugin`.
- Adds a service layer between model/host clients and `AuthorityStore`; direct public `commit(record, trustLevel)` access becomes internal writer-only behavior.
- Adds the official MCP SDK and minimal CLI/transport dependencies, selected and pinned during implementation.
- Adds integration and conformance tests for clean install, CLI/MCP operations, writer restrictions, adapters, recovery, projections, and Git callbacks.
- Does not add target-system execution, credential storage, Artifact retention/redaction, HITL identity, or audit key custody to Taric.

The prior archived checklist is historical. Its completed marks are not evidence that these behaviors work. The design's gap matrix and the unchecked tasks below record the observed implementation gaps and their verification criteria.
