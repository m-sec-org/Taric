# Proposal

## Why

Taric 是面向通用 LLM 智能体框架的渗透测试长期记忆与协作独立插件，不是 agent 平台。

The archived Taric design and first implementation define the intended contracts, but the repository still contains only a partial single-host runtime. CLI and MCP are name lists, the Pi integration is a facade, the public writer can bypass proposal governance, and the minimum projection, context, recovery, and action boundaries are incomplete.

This change delivers the independently usable Phase 0-1 release described by `docs/taric-design.md`: one Taric Core service backed by SQLite WAL, a real Pi adapter, executable CLI and MCP entry points, minimum governance and collaboration state, bounded context retrieval, allowlisted projection, and local Git checkpoints.

## Release Profile

The release profile for this change is **single-host Taric plugin v1**:

- one Core service owns one SQLite WAL authority for multiple local processes and workers;
- Core, schemas, writer isolation, proposal/review/admission, independent L2 review, audit, context, minimum controls/coverage, WorkRun/Attempt fencing, action recommendation/result recording, projection, and local Git checkpoints are in scope;
- MCP and CLI are executable model/operator surfaces; Pi is the only native adapter in scope;
- unsupported capabilities are reported as `unsupported_capability` and are not inferred from a package name, host version, or descriptor.

This change does not claim implementation of deferred capabilities merely because their contracts or package placeholders exist. Deferred specs must be moved to a follow-up change before those capabilities can be marked complete.

## What Changes

- Add a versioned Core service boundary with transport-verified principals, engagement permissions, structured errors, idempotency, and allowlist projections.
- Implement executable operator CLI and MCP stdio using the same Core service. Model-facing MCP tools remain proposal/read/recommendation only.
- Enforce non-LLM writer authority. Reject caller-supplied trust levels, admission states, display IDs, invalid references, stale versions, and unbound reviewer identities.
- Complete the Phase 1 domain contracts and guards for Engagement, Scope, Resource, Observation, Claim, Evidence, Finding, ProtectiveControl, ControlObservation, AccessDecisionObservation, Coverage, WorkItem, WorkRun, Attempt, Checkpoint, ActionIntent, and audit envelopes.
- Make SQLite authority commits, display IDs, proposal governance, CAS, audit, idempotency, and outbox updates atomic. Provide pinned authority reads and read-your-writes responses.
- Implement the minimum control/coverage guards: unknown-layer handling, origin evidence requirements, edge-block `blocked_by_control`, bounded negative observations, and dimension-preserving coverage cells.
- Implement host-driven WorkRun/Attempt claim, lease, fencing, complete minimum checkpoint fields, action intent, host decision/result recording, unknown-result reconciliation, and late-result quarantine without replaying target actions.
- Generate distinct allowlisted Engagement Brief and Attack Surface Index projections, publish generations atomically, enforce principal/engagement permissions, and create local Git checkpoints bound to the manifest and authority sequence.
- Implement a real Pi extension entry point and authenticated Core client. Report unsupported native capabilities instead of simulating them.
- Add clean-checkout build-then-test validation and deterministic release gates for the single-host profile, including the documented 100-worker concurrency gate.

## Explicitly Deferred Follow-Ups

The following concrete changes are outside this change and are tracked independently:

- **`integrate-native-host-adapters` (Phase 2)**: DeepSeek Harness Cordis adapter, Hermes general plugin RPC integration, host compatibility installation/diagnostics, and shared native/MCP adapter conformance.
- **`evolve-engagement-memory` (Phase 3)**: Resource revisions and variants, typed relation graph, PatchSet three-way merge, conflict queue, ImpactEvent traversal, dependency invalidation, resume delta, snapshot round-trip, local migration/backup, remote Git push, and external secrets-scanner integration.
- **`validate-memory-quality` (Phase 4)**: Full policy/reviewer maturity beyond the minimum independent L2 gate, quality corpus, poisoning benchmarks, human-baseline precision/recall, confidence intervals, full coverage propagation, and replay/reconcile enhancements.
- **`add-shared-authority-backend` (Phase 5)**: PostgreSQL authority, multi-host leases/event ordering, multi-host backup/restore, and deployment runbook.
Remote Git push and external secrets-scanner integration belong to `evolve-engagement-memory`; this release only creates local Git checkpoints.

Deferred capability names may appear in diagnostics or documentation only when explicitly labeled unsupported. No deferred operation may silently fall back to weaker behavior that changes trust, authorization, scope, or coverage semantics.

## Capabilities

### New Capabilities

- `taric-runtime-api`: versioned single-host Core service, operator CLI, MCP handlers, permissions, idempotency, and stable errors.
- `authority-storage`: the single-host subset of SQLite WAL transactions, installation-wide IDs, pinned reads, audit, outbox, startup verification, and schema compatibility rejection.
- `quality-evaluation`: deterministic single-host conformance, concurrency, fault, poisoning, and release gates; full statistical evaluation is deferred to `validate-memory-quality`.

### Modified Capabilities

- `engagement-memory`: Phase 1 domain contracts, cross-field validation, engagement-scoped query/context, minimum control semantics, and bounded coverage.
- `memory-governance`: proposal-only model writes, deterministic admission, minimum independent L2 review, atomic audit, and writer isolation.
- `collaboration-state`: host-created WorkRun/Attempt baseline, lease/fencing, validated checkpoints, unknown action state, and late-result quarantine.
- `host-action-integration`: structured recommendations and host-selected mode/decision/result recording without Taric authorization or execution.
- `host-adapters`: executable Pi lifecycle hooks and authenticated Core transport; other native adapters are explicitly unsupported in this release.
- `markdown-projection`: distinct allowlisted projections, generation manifests, principal/engagement ACL, and local Git checkpoints.

## Impact

- In scope: `packages/core`, `packages/cli`, `packages/mcp`, `packages/schemas`, and the Pi adapter path in `packages/core`.
- DeepSeek, Hermes, PostgreSQL, remote Git push, and full statistical evaluation are not implementation targets of this change.
- Direct public `AuthorityStore.commit(record, trustLevel)` and database handles become internal writer-only behavior; model and adapter clients use scoped Core operations.
- Tests must exercise executable CLI/MCP/Pi paths, clean checkout build order, concurrent single-host writes, writer bypass resistance, pinned reads with fixed-sequence continuation, control/coverage guards, recovery fencing, projection ACL, and local Git failure/retry.
- This change does not add a platform, model provider, agent loop, worker scheduler, target-system tool execution, action authorization, HITL identity/approval, credential or Artifact-content storage/redaction, cross-Engagement automatic sharing, old KB/Link runtime compatibility, or audit-signing key custody.

The archived checklist is historical. Only the tasks and gates in the single-host release profile are completion criteria for this change; deferred follow-ups are not silently counted as complete, and this change must not be described as implementing the entire `taric-design.md` roadmap.
