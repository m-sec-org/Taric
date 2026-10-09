# Spec Delta

## MODIFIED Requirements

### Requirement: Persist work runs and attempts
The system SHALL represent WorkItems and host-created WorkRuns/Attempts with owner attribution, status, lease generation, heartbeat, checkpoint reference, read sequence, and execution result references. Taric SHALL NOT create or schedule worker processes. The system SHALL validate WorkItem references, persist every Attempt, support heartbeat/lease renewal, and enforce the documented queued, claimed, running, checkpointed, blocked, completed, failed, cancelled, and lost transitions. Terminal or actively leased runs SHALL NOT be reclaimed through an invalid transition.

#### Scenario: Host claims a work run
- **WHEN** an authorized host claims an available WorkRun
- **THEN** Taric atomically assigns the owner, advances its fencing generation, creates an Attempt, and returns a lease

#### Scenario: Reclaim an expired run
- **WHEN** a lease expires and an authorized host reclaims the WorkRun
- **THEN** Taric advances the fencing generation, marks the prior Attempt lost, and rejects subsequent writes from the stale generation

#### Scenario: Renew active lease
- **WHEN** the current owner renews an active WorkRun lease
- **THEN** Taric updates heartbeat and expiry without changing generation

### Requirement: Commit checkpoints and handoffs
The system SHALL allow an authenticated host adapter with the current WorkRun lease to commit checkpoints containing actionable progress, evidence references, unresolved work, external action state, next steps, and source read sequence. Checkpoints SHALL NOT contain hidden model reasoning requirements. The service SHALL validate checkpoint schema, owner, Attempt, lease, generation, and referenced evidence before atomically updating the checkpoint and WorkRun.

#### Scenario: Commit a checkpoint
- **WHEN** the current host adapter submits a checkpoint against its active lease
- **THEN** Taric commits it and makes it available in the next resume context

#### Scenario: Stale checkpoint commit
- **WHEN** a checkpoint uses an expired lease or stale fencing generation
- **THEN** Taric rejects it without overwriting the current checkpoint

#### Scenario: Model client commits checkpoint
- **WHEN** a model-facing client invokes checkpoint commit
- **THEN** the service rejects the host-only operation

### Requirement: Safe recovery and external action reconciliation
The system SHALL support resuming from the latest committed checkpoint and recording unknown external action outcomes. Taric SHALL NOT blindly replay an external action during recovery. A resume packet SHALL contain source sequence, relevant current delta, changed scope or dependencies, and unresolved ActionIntents. Recovery SHALL revalidate current scope, WorkItem validity, resource/dependency revisions, and applicable host authorization references; changed or unresolved premises SHALL produce blocked or replan-required advice to the host. Host reconciliation results SHALL be recorded before clearing unknown outcome state. Old uncommitted drafts SHALL be sealed under the original Attempt and require explicit rebase before use by a new Attempt.

#### Scenario: Resume after worker interruption
- **WHEN** a host starts a new attempt for an interrupted WorkRun
- **THEN** Taric supplies the latest checkpoint, pinned read sequence, and changes since that checkpoint

#### Scenario: External action result is unknown
- **WHEN** a host reports that an action may have executed but its outcome is unknown
- **THEN** Taric records the unknown state for host reconciliation and does not initiate a replay

#### Scenario: Host resolves unknown outcome
- **WHEN** the host supplies a reconciled outcome and result reference for an unknown ActionIntent
- **THEN** Taric appends the reconciliation event and updates only that intent

#### Scenario: Scope changed after checkpoint
- **WHEN** resume detects a changed scope, invalid task, stale premise, or unresolved host authorization reference
- **THEN** the packet identifies the affected premise and returns blocked or replan-required advice without initiating execution

### Requirement: Fence late results
All writes and result attachments SHALL be bound to the current attempt and fencing generation. Late results SHALL remain attributable to the old attempt and require explicit review or rebase before use by a new attempt. Generation, lease, and owner checks SHALL occur atomically with the write; late data SHALL be stored separately from current action or observation state.

#### Scenario: Late tool result arrives
- **WHEN** an adapter submits a result from a stale attempt
- **THEN** Taric quarantines or rejects it as a current observation and preserves its original attribution

#### Scenario: Old Attempt submits a proposal
- **WHEN** a stale Attempt submits a proposal, observation, patch, checkpoint, or host result
- **THEN** the service rejects current-state attachment and records its original attribution
