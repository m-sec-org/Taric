# Spec Delta

## MODIFIED Requirements

### Requirement: Advanced context cursor and resume delta
Context Pack SHALL be ordered by scope/ROE, worker role/risk budget, WorkItem acceptance, latest checkpoint, relevant deltas, conflicts/expired/coverage gaps, direct entities, evidence locations, and background summaries. Pack SHALL pin source IDs, hashes, times, revisions, slice metadata, permissions, builder/token-estimator/policy versions, omitted/unexamined ranges, and pinned read_seq. Cursor MUST bind principal, Engagement, filters, ordering, sequence, and budget; resume SHALL return relevant deltas after the checkpoint and SHALL NOT cross Engagements or skip entries. Cursor verification keys SHALL be bound to the authority/content root, persist across process restarts, use a versioned key format, and support explicit rotation/invalidating old cursors. Cursor payloads SHALL contain only the fixed snapshot/read sequence and re-fetchable filter/offset/delivered-id state, not the complete record set.

#### Scenario: Continue after restart
- **WHEN** a client resumes an unexpired cursor after the original process exits
- **THEN** the new process verifies the persisted key and returns the next page from the same pinned read sequence without duplicates or omissions

#### Scenario: Rotate or lose a cursor key
- **WHEN** the configured cursor key is missing, rotated, or has invalid permissions
- **THEN** the service rejects affected cursors with a structured invalid-cursor error and does not silently reinterpret them

#### Scenario: Mandatory context exceeds budget
- **WHEN** scope, ROE, acceptance, or recovery point cannot fit within the requested budget
- **THEN** the service returns a structured minimum-budget error or continuation and identifies the unexamined range without silently dropping mandatory constraints

#### Scenario: Continue a pinned cursor
- **WHEN** a client submits an unexpired cursor belonging to the same principal and Engagement
- **THEN** the next page uses the same read_seq and ordering without duplicates or omissions, while cross-Engagement or tampered cursors are rejected

#### Scenario: Resume after impact
- **WHEN** a new Attempt resumes from an old checkpoint after the authority sequence changed
- **THEN** the resume packet includes relevant deltas, scope/dependency changes, pending actions, and a context manifest, and returns blocked/replan-required when a premise is invalid
