# Design

## Context

See `proposal.md` for the motivation and capability scope. The repository currently contains the design document and reference material, but no Taric runtime implementation or existing OpenSpec specs. The implementation therefore establishes the first Core contracts and storage behavior. Host-owned Artifact contents, credential handling, action execution/authorization, HITL identity, and audit signing-key custody stay outside this change's runtime boundary.

## Goals / Non-Goals

**Goals:**

- Establish one authoritative Taric Core and a versioned contract shared by CLI, MCP, and native adapters.
- Preserve proposal/review separation, deterministic canonical writes, consistent reads, and recoverable collaboration state.
- Deliver a useful single-host release first, while keeping storage and adapter contracts extensible.

**Non-Goals:**

- Implement an agent loop, worker scheduler, target-system tool runner, or host authorization policy.
- Store, redact, scan, or assign retention to Artifact contents or credentials.
- Implement Hermes MemoryProvider as the default, human approver identity, or audit signing-key custody.

## Decisions

### One TypeScript Core owns contracts and state transitions

Implement the authority service, CLI, MCP server, JSON Schemas, and TypeScript client around one Core. Python is limited to the Hermes general-plugin adapter. Adapters translate host lifecycle events and must not carry independent admission or storage rules. This keeps Pi and DeepSeek Harness integrations aligned while preserving a Python-native Hermes hook surface. A multi-language Core would duplicate policy and schema behavior without an existing implementation to justify it.

### Versioned JSON Schema and stable IDs form the public contract

Use versioned JSON Schema for Engagement records, proposals, evidence references, context packs, checkpoints, action intents, and adapter requests. Use UUIDv7 for canonical identifiers and an installation-wide monotonic display alias allocated by the authority writer. Schema validation occurs at API boundaries; host-specific objects remain opaque adapter metadata. This supports evolution without exposing framework-private types or inheriting the reference projects' file formats.

### SQLite WAL is the first authority backend

Use a single Taric writer and SQLite WAL for the initial single-host deployment. Canonical event append, record mutation, ID allocation, idempotency state, and outbox publication intent belong in one database transaction. Readers pin a committed sequence; projections and indexes are rebuilt from committed state and published as complete generations. PostgreSQL is a later backend when multi-host shared authority is required. Do not emulate shared authority with concurrent SQLite files, shared Git clones, or network filesystem locks.

### Proposal processing and canonical writes are separate

Model-facing APIs create proposals, observations, and private drafts only. A deterministic non-LLM admission path rechecks references, scope, schema, base version, and policy before an L1 commit. L2 findings require a separate reviewer record bound to the same evidence snapshot. The writer and event ledger remain inaccessible to model-facing tools. Action recommendation and host decision recording are separate operations and never grant target execution.

### Taric references host-managed Artifacts

Store Artifact references, optional hashes, and domain associations only. Context construction may include host-authorized references or slices; Taric does not fetch or retain Artifact bodies unless the host explicitly exposes a content interface in a later, separately specified integration. The host owns content redaction, retention, and credentials. This keeps the authority database and projections independent from customer data lifecycle decisions.

### Collaboration state records host execution, not scheduling

Persist WorkItem, WorkRun, Attempt, lease/fencing generation, checkpoint, handoff, ActionIntent, and host result references. Hosts start and schedule workers. Taric atomically claims leases and rejects stale-generation writes. On recovery it returns the latest committed checkpoint and relevant state changes; unknown external outcomes are recorded for host reconciliation rather than replayed by Taric.

### Thin adapters declare tested capabilities

Define Adapter Contract v1 around lifecycle events, context injection, proposal submission, worker attribution, checkpoints, action modes, and host results. Implement Pi TypeScript first. Ship DeepSeek Harness separately against pinned, contract-tested releases because its upstream is pre-release. Use a Hermes general plugin by default so existing external memory-provider selection remains intact. MCP/CLI provide reduced integration without implying lifecycle automation.

### Projection and Git remain derived and permission-controlled

Generate allowlisted Markdown projections by default, including engagement brief and attack-surface index. Exclude raw Artifact contents, SecretRef, tokens, private paths, unreviewed proposals, and sensitive drafts. Enforce Taric engagement permissions when serving projections. Local Git checkpoints are the default. Remote push is opt-in per engagement and requires private repository access, access control, retention configuration, and secrets scanning. Git never participates in authority transactions.

### Audit integrity uses an internal hash chain without key custody

Append normalized audit events with monotonic sequence and previous-event hash; verify event continuity and materialized-view consistency. Do not add signed chain heads or key management. Hash chaining helps detect internal inconsistency but is not presented as externally authenticated tamper evidence.

## Risks / Trade-offs

- [The initial domain schema spans memory, governance, and collaboration] → Keep contracts versioned and implement the narrow, testable single-host path before PostgreSQL or advanced graph features.
- [Host Artifact references may be unavailable or may point to changed content] → Preserve reference status, optional host-supplied hash/location, and source attribution; never claim unavailable content was reviewed.
- [A host may not expose lifecycle hooks consistently] → Require capability declarations and contract tests; report missing behavior rather than infer enforcement or reliable recovery.
- [Markdown/Git output can expose sensitive metadata] → Apply a strict allowlist before projection, enforce engagement permissions, keep checkpoints local by default, and test remote-push preconditions.
- [SQLite is not suitable for multiple independent host writers across machines] → Keep one local authority service for the first release and define PostgreSQL as the explicit multi-host path.
- [Host authorization state may be stale when an action is executed] → Record host mode and decision/result references with attempt attribution; the host remains responsible for rechecking authorization at execution time.

## Migration Plan

This is a new runtime, so there is no existing Taric authority database to migrate. Create the versioned schema and SQLite database at initialization. Keep schema migrations forward-only and record the schema version in the authority metadata. Build projections from committed events; if a projection is invalid, regenerate it without changing canonical state. Add PostgreSQL only as a separate backend after the storage contract suite passes against SQLite. Existing KB, Link, and pentest-skills data is reference material only; importing or migrating those formats is out of scope.

## Open Questions

- The exact DeepSeek Harness versions supported at each adapter release will be recorded in adapter release metadata after contract tests pass.
- Whether Hermes MemoryProvider support is ever needed can be revisited independently; it is not part of the default integration.
