# Spec Delta

## MODIFIED Requirements

### Requirement: Persist work runs and attempts

The system SHALL represent WorkItems and host-created WorkRuns/Attempts with owner attribution, status, lease generation, heartbeat, checkpoint reference, read sequence, execution result references, and a registered task-session reference. Taric SHALL NOT create or schedule worker processes. The system SHALL validate WorkItem and task-session references, persist every Attempt, support heartbeat/lease renewal, and enforce the documented queued, claimed, running, checkpointed, blocked, completed, failed, cancelled, and lost transitions. Durable execution records MAY be written as date/ID-sharded Markdown sidecars or bounded immutable segments with catalog offsets, but canonical lifecycle state remains authority state. Terminal or actively leased runs SHALL NOT be reclaimed through an invalid transition.

#### Scenario: Host claims a work run

- **WHEN** an authorized host claims an available WorkRun with a valid task-session binding
- **THEN** Taric atomically assigns the owner, advances its fencing generation, creates an Attempt, binds the run to the session, and returns a lease

#### Scenario: Reclaim an expired run

- **WHEN** a lease expires and an authorized host reclaims the WorkRun
- **THEN** Taric advances the fencing generation, marks the prior Attempt lost, seals or quarantines its pending execution sidecars, and rejects subsequent writes from the stale generation

#### Scenario: Renew active lease

- **WHEN** the current owner renews an active WorkRun lease
- **THEN** Taric updates heartbeat and expiry without changing generation or changing the task-session binding

### Requirement: Commit checkpoints and handoffs

The system SHALL only allow an authenticated host adapter to submit a checkpoint in the current owner/Attempt/lease/generation and registered task session. The contract MUST contain Engagement, WorkItem, run/attempt, scope and task target versions, read_seq, context_snapshot_id/manifest hash, completed steps, pending steps, Observation/Evidence references, bounded negative-result references, unresolved assumptions, host decision references, ActionIntent/external action state, next steps, budget usage, private draft/handoff references, and Artifact content/execution references when present; empty lists MUST be explicit. The service SHALL validate reference ownership/types, scope/WorkItem/task-session validity, host attestation, content manifest integrity, and verifiable tool-result references, then atomically update checkpoint, WorkRun, authority execution metadata, and the session Markdown sidecar. Checkpoints save executable state and MUST NOT require or accept hidden model reasoning as recovery evidence.

#### Scenario: Commit a checkpoint

- **WHEN** the current host submits a valid checkpoint against its active lease and task session
- **THEN** Taric commits it, writes the linked date/ID-sharded execution sidecar or segment entry, and makes the checkpoint and Artifact associations available in the next resume context with a manifest/catalog cursor

#### Scenario: Stale checkpoint commit

- **WHEN** a checkpoint uses an expired lease, stale fencing generation, invalid content reference, or another session's Artifact
- **THEN** Taric rejects it without overwriting the current checkpoint or publishing a readable sidecar

#### Scenario: Model client commits checkpoint

- **WHEN** a model-facing client invokes checkpoint commit or raw execution-content write
- **THEN** the service rejects the host-only operation

### Requirement: Fence late results

All writes, Artifact associations, execution sidecars, and result attachments SHALL be bound to the current Attempt and fencing generation. Late results SHALL remain attributable to the old Attempt and require explicit review or rebase before use by a new Attempt. Generation, lease, owner, and task-session checks SHALL occur atomically with the authority write; late data SHALL be stored separately from current action or observation state.

#### Scenario: Late tool result arrives

- **WHEN** an adapter submits a result or Artifact sidecar from a stale Attempt
- **THEN** Taric quarantines or rejects it as a current observation, preserves its original attribution and hash, and does not expose it as current execution state

#### Scenario: Old Attempt submits a proposal

- **WHEN** a stale Attempt submits a proposal, observation, patch, checkpoint, host result, or content association
- **THEN** the service rejects current-state attachment and records its original Attempt, generation, and task-session attribution

