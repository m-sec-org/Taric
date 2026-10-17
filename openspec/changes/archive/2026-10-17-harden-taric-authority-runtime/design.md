# Design

## Context

See `proposal.md` and the eight capability deltas. The current Core writes caller-provided `content.id`, persists mostly unvalidated candidate bodies before admission, and exposes one public admission path for behavior that is actually split between `admitProposal`, `evaluateAdmission`, and `promoteFinding`. CLI already has startup/profile resolution, while MCP opens `TARIC_DB ?? ":memory:"` directly. SQLite is synchronous and authoritative; PostgreSQL currently supplies narrower storage primitives without a complete Core service integration. Context cursors are encrypted with a process-local random key and contain the full selected record set.

## Goals / Non-Goals

**Goals:**

- Make identity allocation, proposal validation, trust transitions, and error outcomes unambiguous at every transport boundary.
- Give CLI and MCP one startup decision path with persistent single-host defaults and fail-closed multi-host selection.
- Preserve SQLite's single-writer semantics while making large reads, cursor continuation, Artifact recovery, and maintenance behavior measurable and bounded.
- Provide a staged backend and release-evidence contract so a capability is not reported enabled merely because a storage primitive or algorithm exists.

**Non-Goals:**

- Do not implement a PostgreSQL duplicate of Core governance logic in this change.
- Do not make snapshot import, general event replay, search indexing, or arbitrary Artifact path access supported.
- Do not lower the 64 MiB Artifact chunk contract or add fsync unconditionally before benchmark evidence establishes the deployment trade-off.
- Do not move operator maintenance onto asynchronous workers until measurements show event-loop impact and a separate-connection design is ready.

## Decisions

### 1. Separate proposal envelope, candidate subject, and canonical identity

Introduce explicit envelope fields for `proposal_id`/`client_request_id`, an optional `target_id`/`subject_ref` for updates, and an expected version. New canonical objects are allocated by Core with UUIDv7 inside the commit transaction. `source_ref` remains an authority-object reference and cannot be used as a generic request id. The schema and snapshot/import/export formats are updated together so an old body cannot silently populate the new identity fields.

The alternative of simply replacing `content.id` with `uuidv7()` is rejected because the existing field is also used for update lookup and base-version checks; it would make create and update semantics ambiguous and could detach references from their indexed subject.

### 2. Validate in two explicit stages

The write boundary first validates an envelope and candidate domain shape without making state visible. It accepts a small, explicit proposal-only provenance vocabulary (including model submissions) and maps it to canonical provenance only during deterministic admission. It rejects malformed fields, privileged fields, subject/kind mismatches, invalid references, and illegal ownership before inserting the proposal. A structurally valid proposal may remain pending when evidence or reviewer input is intentionally unavailable.

`admission.evaluate` remains the L0-to-L1 deterministic operation and reports its phase. A separate promotion operation calls the existing policy/evidence/reviewer path for L1-to-L2 finding promotion. Both paths reuse shared validation and writer-owned ID allocation; neither trusts a caller status or model verdict.

### 3. Centralize startup resolution and preserve backend state

Move authority/profile resolution into a Core-owned startup facade consumed by CLI and MCP. The facade resolves backend, database path, content root, principal context, and deployment guard before constructing a service. The default path is `~/.taric/authority.sqlite` (or the configured equivalent); `:memory:` is test-only or explicit. PostgreSQL construction is guarded by the shared profile and conformance/health result. A failed multi-host check returns a blocked diagnostic and never instantiates an unrelated SQLite store.

The alternative of making MCP inherit the CLI module directly is rejected because it couples transport packaging to CLI configuration discovery. The shared facade exposes the same decision data without duplicating transport-specific command handling.

### 4. Use bounded indexed reads and measurable snapshots

Add indexes for engagement/kind/version and object-reference lookup, batch reference checks by the submitted reference set, and use keyset cursors for large lists. Snapshot/export continues to pin one read sequence and may materialize an O(N) result; its memory, latency, and source sequence are reported separately from commit/admission p95. Operator operations use read transactions or an isolated maintenance process while respecting SQLite's single writer.

The alternative of promising O(1) snapshot memory is rejected because a portable fixed snapshot must serialize the selected state. The contract instead makes the unavoidable cost visible and testable at 10k/50k fixtures.

### 5. Persist and slim context cursor state

Create a 0600 key file below the authority/content root with a versioned format and explicit rotation behavior. Cursor payloads retain principal/Engagement/filter/order/budget bindings, pinned snapshot/read sequence, offset, and delivered IDs; continuation reconstructs records from the fixed as-of source rather than embedding all records. Missing or rotated keys invalidate cursors rather than falling back to a new interpretation.

### 6. Treat Artifact durability as a deployment profile

Keep the existing 64 MiB decoded-byte contract until concurrent-upload benchmarks measure peak memory and latency. Record transport bytes separately from decoded bytes. Publication markers and reconcile remain the process-crash recovery mechanism. A profile may claim power-loss durability only when its fsync/rename policy and tests support that claim; otherwise the capability report states process-crash-only recovery.

### 7. Keep backend policy in Core and gate PostgreSQL activation

Define a sync/async-capable backend facade for persistence operations, then run the same conformance suite against SQLite and PostgreSQL. Governance and policy code remains in Core. PostgreSQL is enabled only when proposal/review/admission/checkpoint/action/Artifact/lease/audit/outbox/pinned-read behavior is covered; primitive-only support remains visible as `runtime_state=disabled`.

The concrete unit of work uses one asynchronous `AuthorityStore` implementation for both backends. SQLite and PostgreSQL adapters own SQL execution, dialect expressions, connection lifecycle, and transaction-scoped time. Nested Core operations reuse the current transaction; independent operations never share its transaction context. SQLite queues access to each database file, while PostgreSQL checks out one client per transaction and serializes authority writes with a schema-scoped transaction lock. Proposal validation, identity allocation, L1/L2 policy, checkpoints, actions, Artifact markers, audit, idempotency, and outbox remain in the common Core implementation. Persisted API callers await completion, and Artifact catalog hydration/recovery has an explicit asynchronous initialization step.

The full conformance harness runs the same executable domain scenarios against isolated SQLite and live PostgreSQL authorities, including audit-failure rollback, lease fencing, process restart, fixed reads, and restore into an independent destination. It is an explicit operator verification step; startup does not create conformance fixtures in a production authority. Structural readiness alone cannot authorize activation, and missing or failed scenario evidence keeps the runtime disabled.

### 8. Make transport framing and errors structural

Adapter RPC keeps line-delimited JSON but processes every complete line in a buffer and retains incomplete trailing bytes; it does not close a connection after the first request unless the client closes it. Core errors carry stable codes and sanitized public messages. Unknown exceptions map to a generic internal error, and adapters never infer codes from message substrings.

## Risks / Trade-offs

- [Breaking identity migration] Existing callers that supply `content.id` for creates or updates will fail. Mitigation: migrate fixtures and snapshot/export schemas together and provide an explicit update target field; no silent reinterpretation.
- [Proposal compatibility] Model provenance currently uses a value absent from the canonical schema. Mitigation: define a proposal-only provenance schema and deterministic mapping at admission instead of persisting an invalid canonical-shaped body.
- [Cursor key loss] A deleted or rotated key invalidates outstanding cursors. Mitigation: report a stable invalid-cursor error, document rotation, and provide a fresh-query path.
- [Snapshot cost] Fixed exports still scale with selected data. Mitigation: separate benchmarks and operator-only execution; do not claim small-fixture p95 for large stores.
- [PostgreSQL scope] A facade can expose a disabled profile for a long period. Mitigation: publish capability states and require a complete conformance report before enabling multi-host.
- [Artifact memory/durability] Lower chunks or fsync can reduce throughput. Mitigation: collect benchmark and fault-injection data first, then choose profile defaults.
- [RPC compatibility] Pipelined clients may rely on connection closure. Mitigation: add framing/pipeline tests and document the supported request lifecycle before changing defaults.

## Migration Plan

1. Add schemas and validation for proposal envelope, target references, UUIDv7 allocation, explicit L1/L2 operations, capability state, and structured errors.
2. Introduce the shared startup facade and switch MCP to the persistent default; retain `:memory:` only in tests or explicit configuration.
3. Add SQLite indexes/batched queries, persistent cursor keys, keyset pagination, maintenance authorization, and scale/fault benchmarks.
4. Add the backend facade and PostgreSQL conformance harness while keeping the multi-host runtime disabled until all gates pass.
5. Update docs, release reports, fixtures, CLI/MCP/adapter tests, and snapshot/export/import validation.

Rollback is a versioned API/schema deployment decision: do not downgrade a store after new identity fields or cursor-key metadata have been committed. A failed rollout remains blocked and can be repaired using the operator doctor/reconcile paths; no fallback authority is created.

## Open Questions

None that change the contracts or implementation order. The exact PostgreSQL driver/facade method names and benchmark thresholds can be chosen during implementation within the stated behavior.
