# Spec Delta

## MODIFIED Requirements

### Requirement: Fence late results

Each host session used for a write, checkpoint, result, or Artifact association SHALL persist an explicit `host-session` or `run-bound` mode. In `run-bound` mode, all writes, Artifact associations, execution sidecars, and result attachments SHALL be bound to the current Attempt and fencing generation. WorkRun, Attempt, generation, owner, lease, and session SHALL resolve from the trusted binding and the operation's documented envelope; missing required envelope fields or durable associations, conflicting ownership, expired leases, or attempted mode changes MUST NOT downgrade to host-session. Generation, lease, owner, and task-session checks SHALL occur atomically with the authority write; late data SHALL remain separately attributable to the old Attempt, MUST NOT overwrite current action/observation state, and SHALL require explicit review or rebase plus current checks before reuse. Invalid envelopes SHALL return validation errors, unauthorized binding changes authorization errors, and expired/stale writes the existing typed rejection or documented quarantine result. In `host-session` mode, writes SHALL use host/operator, Engagement, explicit session, server-owned ID, schema/reference/version/idempotency checks and MUST NOT claim WorkRun lease fencing. Only host/operator binding operations may establish a mode; changing mode requires a new explicit binding. Model requests MUST NOT establish, weaken, or reinterpret a host session binding.

#### Scenario: Late tool result arrives
- **WHEN** an adapter submits a result or Artifact sidecar from a stale Attempt
- **THEN** Taric quarantines or rejects it as a current observation, preserves its original attribution and hash, and does not expose it as current execution state

#### Scenario: Old Attempt submits a proposal
- **WHEN** a stale Attempt submits a proposal, observation, patch, checkpoint, host result, or content association
- **THEN** the service rejects current-state attachment and records its original Attempt, generation, and task-session attribution

#### Scenario: Run-bound request omits generation
- **WHEN** a run-bound session submits a checkpoint, proposal, host result, or Artifact begin without run fields required by that operation's envelope
- **THEN** Taric rejects it without publishing current state or downgrading the request to host-session

#### Scenario: Explicit host-session capture
- **WHEN** a host creates a host-session binding and submits a deterministic observation without run fields
- **THEN** Taric accepts it under host-session isolation while reporting that WorkRun lease fencing is not provided

#### Scenario: Upload resumes without repeated run fields
- **WHEN** Artifact append or commit supplies an upload ID whose durable association is run-bound
- **THEN** Taric resolves the saved run association and validates the current lease and ownership without treating the request as host-session, even though the envelope does not repeat run fields

#### Scenario: All run attribution is missing
- **WHEN** a request known by its trusted transport/session to be run-bound omits every required run field and has no valid durable upload association
- **THEN** Taric rejects or applies the existing stale-proposal quarantine contract and never interprets it as an unbound host-session write

## ADDED Requirements

### Requirement: Apply the same fencing contract to all execution attachments

Proposal/capture, checkpoint, action result, execution sidecar, Artifact begin/append/commit, and recovery publication SHALL apply the session mode and current generation checks atomically with the authority mutation. Model requests MUST NOT establish, weaken, or reinterpret a host session binding.

#### Scenario: Model attempts to bind a run
- **WHEN** a model request supplies WorkRun, owner, or generation fields to obtain host execution privileges
- **THEN** Taric denies the request based on the transport principal before reading or writing protected execution state

#### Scenario: Replayed idempotent attachment
- **WHEN** a valid attachment is retried with the same principal, session, operation, and payload hash
- **THEN** Taric returns the original result without duplicating the execution side effect; a different payload returns an idempotency conflict

#### Scenario: Recovery publishes an expired run upload
- **WHEN** restart reconciliation finds a publication marker with an expired lease or replaced run binding
- **THEN** Taric preserves the marker's original attribution, rejects or quarantines publication, and exposes no newly available content for the current run
