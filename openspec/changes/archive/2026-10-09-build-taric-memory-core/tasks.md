# Tasks

## 1. Repository and Contract Foundation

- [x] 1.1 Create the TypeScript workspace, Core package, CLI/MCP package boundaries, and shared validation setup; verify install and typecheck commands run from a clean checkout.
- [x] 1.2 Define versioned JSON Schemas and generated types for Engagement, Scope, Resource, Observation, Relation, Claim, WorkItem, Evidence reference, Finding, coverage, proposal, and review; verify valid/invalid fixture tests cover required fields and reference constraints.
- [x] 1.3 Define UUIDv7 IDs, installation-wide display alias allocation, and schema-version metadata; verify concurrent allocator tests produce unique monotonic aliases and stable UUID references.
- [x] 1.4 Document the initial CLI/MCP/adapter API and host-owned Artifact/action boundaries; verify examples match the schemas and expose no Artifact body, credential, canonical-writer, or action-execution operation.

## 2. Authority Store and Memory Governance

- [x] 2.1 Implement SQLite WAL storage, a single writer, transaction events, idempotency records, and outbox; verify crash-injection tests leave each committed mutation and audit event atomic.
- [x] 2.2 Implement proposal/private-draft submission and deterministic admission checks for scope, schema, references, state transitions, policy version, and base version; verify invalid proposals remain non-canonical with structured rejection reasons.
- [x] 2.3 Implement L0 proposal and L1 machine-reviewed candidate state and trust-aware retrieval; verify ordinary recall excludes L0 and unrequested L1 while explicit candidate queries preserve provenance and limitations.
- [x] 2.4 Implement independent L2 finding review bound to a fixed input/evidence snapshot; verify self-review, stale snapshot, and missing-evidence attempts cannot promote a finding.
- [x] 2.5 Implement normalized append-only hash-chained audit events and `audit verify`; verify event continuity and materialized-view mismatches are detected without rewriting history.
- [x] 2.6 Implement optimistic concurrency/CAS and authority read-sequence pinning; verify concurrent conflicting patches preserve both proposals and readers observe a complete committed sequence.

## 3. Engagement Retrieval and Coverage

- [x] 3.1 Implement engagement/resource/observation/claim/relation/evidence-reference/finding queries and typed relation revisions; verify cross-engagement references are rejected and evidence references retain source/limitations.
- [x] 3.2 Implement coverage cells and bounded positive/negative observation records, including `blocked_by_control`; verify a negative result is condition-bound and control-blocked coverage does not close origin testing.
- [x] 3.3 Implement token-budgeted Context Pack generation with pinned read sequence, provenance manifest, omitted-range markers, and continuation cursor; verify budget overflow preserves mandatory scope and marks omitted coverage unexamined.
- [x] 3.4 Implement stale/review-needed propagation for changed evidence, resources, controls, and claims; verify affected findings and action recommendations are marked stale without mutating historical observations.

## 4. Collaboration State and Host Action Exchange

- [x] 4.1 Implement WorkItem, WorkRun, Attempt, lease, heartbeat, fencing generation, and host claim/reclaim APIs; verify expired leases advance generation and stale writes are rejected.
- [x] 4.2 Implement host-authenticated checkpoint/handoff commit with source read sequence and evidence references; verify models cannot commit checkpoints and stale attempts cannot overwrite current state.
- [x] 4.3 Implement ActionIntent and host decision/result recording for `llm_recommend`, `authorized_autonomous`, and `host_hitl`; verify recommendations are advisory and Taric never authorizes or invokes target tools.
- [x] 4.4 Implement resume packets, late-result attribution, and unknown-action reconciliation state; verify recovery returns the latest checkpoint and does not replay unknown external actions.

## 5. Projection and Git Checkpoints

- [x] 5.1 Implement default Markdown engagement brief/index projections from committed authority generations using an explicit field allowlist; verify canary Artifact refs, tokens, private paths, unreviewed proposals, and sensitive drafts are excluded.
- [x] 5.2 Implement atomic generation publication and engagement permission checks for projection reads; verify readers see complete old/new generations and unauthorized reads fail.
- [x] 5.3 Implement local Git checkpoints and explicit per-engagement remote-push configuration; verify default operation remains local and remote push is rejected unless repository privacy, access control, retention, and secret-scan settings are present.

## 6. Host Adapters and Integration Verification

- [x] 6.1 Implement Adapter Contract v1 and shared conformance fixtures for identity attribution, context injection, proposals, checkpoints, action modes, and result callbacks; verify unsupported capabilities are reported rather than inferred.
- [x] 6.2 Implement the Pi TypeScript adapter and verify its lifecycle callbacks produce the same Core state as MCP fixtures for supported operations.
- [x] 6.3 Implement a pinned DeepSeek Harness Cordis adapter and verify each declared upstream release against adapter contract tests before publishing compatibility metadata.
- [x] 6.4 Implement the Hermes Python general plugin and MCP fallback; verify enabling the default plugin does not change the selected external MemoryProvider.
- [x] 6.5 Run cross-adapter integration tests for concurrent submissions, context snapshot consistency, checkpoint recovery, projection permissions, host action result recording, and storage conformance; verify documented MVP boundaries match observed capabilities.
