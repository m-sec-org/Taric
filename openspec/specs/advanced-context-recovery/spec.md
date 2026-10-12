# advanced-context-recovery Specification

## Purpose

Provides verifiable cursors, resume deltas, draft sealing and rebasing, and portable Taric-native snapshots so hosts can safely continue work from a fixed authority sequence.

## Requirements

### Requirement: Advanced context cursor and resume delta

Context Pack SHALL be ordered by scope/ROE, worker role/risk budget, WorkItem acceptance, latest checkpoint, relevant deltas, conflicts/expired/coverage gaps, direct entities, evidence locations, and background summaries. Pack SHALL pin source IDs, hashes, times, revisions, slice metadata, permissions, builder/token-estimator/policy versions, omitted/unexamined ranges, and pinned read_seq. Cursor MUST bind principal, Engagement, filters, ordering, sequence, and budget; resume SHALL return relevant deltas after the checkpoint and SHALL NOT cross Engagements or skip entries.

#### Scenario: Mandatory context exceeds budget
- **WHEN** scope, ROE, acceptance, or recovery point cannot fit within the requested budget
- **THEN** the service returns a structured minimum-budget error or continuation and identifies the unexamined range without silently dropping mandatory constraints

#### Scenario: Continue a pinned cursor
- **WHEN** a client submits an unexpired cursor belonging to the same principal and Engagement
- **THEN** the next page uses the same read_seq and ordering without duplicates or omissions, while cross-Engagement or tampered cursors are rejected

#### Scenario: Resume after impact
- **WHEN** a new Attempt resumes from an old checkpoint after the authority sequence changed
- **THEN** the resume packet includes relevant deltas, scope/dependency changes, pending actions, and a context manifest, and returns blocked/replan-required when a premise is invalid

### Requirement: Draft sealing and explicit rebase

Uncommitted drafts, late results, and proposals from an old Attempt SHALL retain their original Attempt/generation attribution and be sealed; a new Attempt MUST explicitly rebase or create a new proposal before referencing them. Expired leases, old generations, and cross-Engagement drafts MUST NOT modify current authority.

#### Scenario: Stale draft arrives
- **WHEN** a lost Attempt submits a draft or patch after a new owner has taken over
- **THEN** Taric isolates or rejects it from current state, preserves its attribution, and does not overwrite the new Attempt

### Requirement: Portable authority snapshot migration

Taric SHALL support JSON/JSONL snapshots with schema version, Engagement identity, source sequence, UUIDv7/display alias, provenance, revision, and integrity metadata. Import MUST validate schema, references, hashes, and conflicts in a temporary target before atomic switching; incompatible or damaged input MUST cause no partial write and SHALL return recovered sequence and verification result.

#### Scenario: Snapshot round-trip
- **WHEN** an operator imports a compatible snapshot into an empty authority
- **THEN** records, revisions, provenance, source sequence, and historical references are equivalent to the exported state

#### Scenario: Invalid snapshot
- **WHEN** snapshot schema, integrity, Engagement, or destination conflict validation fails
- **THEN** import fails and the destination authority, counter, outbox, and projection remain unchanged
