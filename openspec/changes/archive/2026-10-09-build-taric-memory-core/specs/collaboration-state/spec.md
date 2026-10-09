# Spec Delta

## Purpose

Defines durable collaboration state that lets host-managed workers hand off and resume long-running engagement work without making Taric an agent scheduler.

## ADDED Requirements

### Requirement: Persist work runs and attempts
The system SHALL represent WorkItems and host-created WorkRuns/Attempts with owner attribution, status, lease generation, heartbeat, checkpoint reference, read sequence, and execution result references. Taric SHALL NOT create or schedule worker processes.

#### Scenario: Host claims a work run
- **WHEN** an authorized host claims an available WorkRun
- **THEN** Taric atomically assigns the owner, advances its fencing generation, and returns a lease

#### Scenario: Reclaim an expired run
- **WHEN** a lease expires and an authorized host reclaims the WorkRun
- **THEN** Taric advances the fencing generation and rejects subsequent writes from the stale generation

### Requirement: Commit checkpoints and handoffs
The system SHALL allow an authenticated host adapter with the current WorkRun lease to commit checkpoints containing actionable progress, evidence references, unresolved work, external action state, next steps, and source read sequence. Checkpoints SHALL NOT contain hidden model reasoning requirements.

#### Scenario: Commit a checkpoint
- **WHEN** the current host adapter submits a checkpoint against its active lease
- **THEN** Taric commits it and makes it available in the next resume context

#### Scenario: Stale checkpoint commit
- **WHEN** a checkpoint uses an expired lease or stale fencing generation
- **THEN** Taric rejects it without overwriting the current checkpoint

### Requirement: Safe recovery and external action reconciliation
The system SHALL support resuming from the latest committed checkpoint and recording unknown external action outcomes. Taric SHALL NOT blindly replay an external action during recovery.

#### Scenario: Resume after worker interruption
- **WHEN** a host starts a new attempt for an interrupted WorkRun
- **THEN** Taric supplies the latest checkpoint, pinned read sequence, and changes since that checkpoint

#### Scenario: External action result is unknown
- **WHEN** a host reports that an action may have executed but its outcome is unknown
- **THEN** Taric records the unknown state for host reconciliation and does not initiate a replay

### Requirement: Fence late results
All writes and result attachments SHALL be bound to the current attempt and fencing generation. Late results SHALL remain attributable to the old attempt and require explicit review or rebase before use by a new attempt.

#### Scenario: Late tool result arrives
- **WHEN** an adapter submits a result from a stale attempt
- **THEN** Taric quarantines or rejects it as a current observation and preserves its original attribution
