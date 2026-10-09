# Spec Delta

## Purpose

Defines durable, consistent authority state for Taric across concurrent operations, pinned reads, restart recovery, and portable snapshots. It also defines the conditional storage contract for explicitly configured multi-host deployments.

## ADDED Requirements

### Requirement: Atomic authority commits and identifiers
The system SHALL commit canonical records, monotonically increasing record versions, installation-wide display identifiers, audit events, idempotency results, and outbox entries atomically. Display identifiers SHALL be unique and monotonic across engagements and entity types; callers SHALL NOT choose or reuse them. Revisions SHALL retain the logical entity's existing display identifier. A failed transaction SHALL leave none of its state visible.

#### Scenario: Commit one authority change
- **WHEN** a validated authority mutation succeeds
- **THEN** its record version, display identifier, audit event, idempotency result, and outbox entry are committed together

#### Scenario: Fail during a transaction
- **WHEN** a process or storage error interrupts a mutation before commit
- **THEN** restart exposes either the complete committed change or none of it, never a partial success

#### Scenario: Concurrent display identifier allocation
- **WHEN** writers in different engagements allocate display identifiers concurrently
- **THEN** every committed identifier is unique and the installation sequence does not move backward or reset by engagement or record kind

### Requirement: Conditional writes and pinned snapshots
The system SHALL perform expected-version checks in the same transaction as each mutation. A snapshot SHALL return records as of its reported authority sequence, and every page of a continued query SHALL use the same sequence and stable ordering. Write responses SHALL return committed sequence and generation; reads SHALL expose projected/indexed watermarks and support read-your-writes against the committed sequence without presenting stale indexes as current.

#### Scenario: Two writers use the same base version
- **WHEN** concurrent mutations target one record version
- **THEN** at most one mutation commits and the other receives a version conflict with no overwritten update

#### Scenario: Read while authority changes
- **WHEN** authority records change while a snapshot or context query is in progress
- **THEN** the result contains only records visible at its pinned sequence and continuation pages preserve that sequence without gaps or duplicates

#### Scenario: Read after a successful mutation
- **WHEN** a client queries using the committed sequence returned by its write while the projection or index is behind
- **THEN** Taric returns authority-consistent results or a clear pending response and exposes the derived view's lower watermark

### Requirement: Reconcile durable views and event delivery
The system SHALL make authoritative events the recovery source for derived views and outbox work. Verification SHALL report divergence among events, records, counters, idempotency state, and pending projection work. Rebuild or replay SHALL be an explicit operator action and SHALL preserve the authoritative history.

#### Scenario: Detect derived-state drift
- **WHEN** an operator runs authority verification after a partial derived-view failure
- **THEN** Taric reports the inconsistent sequence and affected view without claiming silent repair

#### Scenario: Rebuild a derived view
- **WHEN** an operator explicitly requests reconciliation for a supported view
- **THEN** Taric rebuilds it from committed authority events and reports the resulting sequence and any unresolved errors

### Requirement: Portable authority snapshots and migrations
The system SHALL export and import versioned Taric-native JSON/JSONL snapshots with schema version, engagement identity, source sequence, and integrity metadata. Storage schema migrations SHALL be versioned, repeatable, and preserve committed authority state. Snapshot recovery SHALL report the recovered authority sequence and verification result.

#### Scenario: Round-trip a snapshot
- **WHEN** an operator exports and imports a valid snapshot into an empty compatible store
- **THEN** the imported records, provenance, revisions, and sequence are equivalent to the exported authority state

#### Scenario: Reject an incompatible snapshot
- **WHEN** a snapshot has an unsupported schema, invalid integrity metadata, or conflicting destination state
- **THEN** import fails without partially applying the snapshot

#### Scenario: Upgrade a local store
- **WHEN** Taric starts with a supported older schema version
- **THEN** it applies the required migration or reports a recoverable migration error without silently discarding authority data

### Requirement: Support an optional shared-authority backend
When an operator explicitly configures multi-host shared authority, Taric SHALL provide a PostgreSQL backend with the same storage conformance behavior for transactions, conditional writes, identifier allocation, audit ordering, leases, and snapshots as the supported local backend. PostgreSQL SHALL NOT be required for single-host deployments.

#### Scenario: Run the conformance suite against both backends
- **WHEN** the storage conformance suite runs against SQLite and PostgreSQL
- **THEN** both backends produce equivalent externally visible commit, conflict, snapshot, and recovery behavior

#### Scenario: Use a single-host default deployment
- **WHEN** Taric runs with the default single-host configuration
- **THEN** it operates without PostgreSQL configuration or service availability
