# advanced-context-recovery Specification

## Purpose

Provides verifiable cursors, resume deltas, draft sealing and rebasing, and portable Taric-native snapshots so hosts can safely continue work from a fixed authority sequence.

## Requirements

### Requirement: Advanced context cursor and resume delta

Context Pack SHALL be ordered by scope/ROE, worker role/risk budget, WorkItem acceptance, latest checkpoint, relevant deltas, conflicts/expired/coverage gaps, direct entities, evidence locations, and background summaries. Pack SHALL pin source IDs, hashes, times, revisions, slice metadata, permissions, builder/token-estimator/policy versions, omitted/unexamined ranges, and pinned read_seq. Cursor MUST bind authority, principal, Engagement, filters, ordering, read sequence, fixed read time, policy, budget, and expiry; cursor verification keys SHALL be bound to the authority/content root, persist across process restarts, use a versioned key format, and support explicit rotation that invalidates affected cursors. Cursor payloads MUST contain only fixed snapshot/read sequence and re-fetchable filter/position state, not a complete record set. Resume SHALL return relevant deltas after the checkpoint and SHALL NOT cross Engagements or skip entries. Implementations SHALL use a bounded fixed snapshot and stable keyset or equivalent monotonic position for each page; they MUST report scan/return bounds, cursor size, watermark, and continuation when the requested budget cannot finish the required read. Resume delta SHALL constrain event/record reads by Engagement, sequence range, and relevant subjects rather than requiring an unbounded full event read. If scope, task premise, direct checkpoint references, or authorization changed, resume SHALL return blocked or replan-required rather than presenting the result as safe to continue.

#### Scenario: Mandatory context exceeds budget
- **WHEN** scope, ROE, acceptance, or recovery point cannot fit within the requested budget
- **THEN** the service returns a structured minimum-budget error or continuation, identifies the unexamined range, and does not silently drop mandatory constraints

#### Scenario: Continue a pinned cursor
- **WHEN** a client submits an unexpired cursor belonging to the same principal and Engagement
- **THEN** the next page uses the same read_seq and ordering without duplicates or omissions, while cross-Engagement or tampered cursors are rejected

#### Scenario: Resume after impact
- **WHEN** a new Attempt resumes from an old checkpoint after the authority sequence changed
- **THEN** the resume packet includes relevant deltas, scope/dependency changes, pending actions, and a context manifest, and returns blocked/replan-required when a premise is invalid

#### Scenario: Continue a pinned cursor under concurrent writes
- **WHEN** a client submits an unexpired cursor while authority changes
- **THEN** the next page uses the original read_seq and ordering with no duplicate or omitted eligible item, and exposes bounded continuation metadata

#### Scenario: Resume delta is large
- **WHEN** a checkpoint has a long history or high churn after its source sequence
- **THEN** Taric returns a bounded relevant delta or explicit continuation/error and does not claim a complete delta after silently truncating an unbounded scan

#### Scenario: Cursor binding is changed
- **WHEN** a caller changes principal, Engagement, filter, ordering, policy, budget, or key after receiving a cursor
- **THEN** Taric returns `invalid_cursor` without reading protected records or changing state

#### Scenario: Continue after restart
- **WHEN** a client resumes an unexpired cursor after the original process exits
- **THEN** the service verifies the persisted versioned key and returns the next page from the same pinned read sequence without duplicates or omissions

#### Scenario: Rotate or lose a cursor key
- **WHEN** the configured cursor key is missing, rotated, or has invalid permissions
- **THEN** the service rejects affected cursors with a structured invalid-cursor error and does not silently reinterpret them

#### Scenario: Resume premise is no longer valid
- **WHEN** the scope, WorkItem, checkpoint reference, or host authorization has changed since the checkpoint
- **THEN** the resume response identifies the affected premise and returns blocked or replan-required without initiating execution

#### Scenario: Cursor expires or changes fixed read time
- **WHEN** a cursor is expired or its authority, fixed read time, policy, or ordering binding no longer matches
- **THEN** Taric returns `invalid_cursor` instead of rebuilding the cursor at a new time or authority

### Requirement: Draft sealing and explicit rebase

Uncommitted drafts, late results, and proposals from an old Attempt SHALL retain their original Attempt/generation attribution and be sealed; a new Attempt MUST explicitly rebase or create a new proposal before referencing them. Expired leases, old generations, and cross-Engagement drafts MUST NOT modify current authority.

#### Scenario: Stale draft arrives
- **WHEN** a lost Attempt submits a draft or patch after a new owner has taken over
- **THEN** Taric isolates or rejects it from current state, preserves its attribution, and does not overwrite the new Attempt
