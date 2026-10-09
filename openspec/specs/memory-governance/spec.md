# memory-governance Specification

## Purpose
Defines the controlled write and review lifecycle that keeps model-generated proposals separate from canonical memory and verified findings.

## Requirements

### Requirement: Proposal-only model writes
Model-facing interfaces SHALL allow agents to submit proposals, observations, patches, and private drafts, but SHALL NOT expose canonical writer or admission commands.

#### Scenario: Agent submits a patch
- **WHEN** an agent submits a valid patch through a model-facing interface
- **THEN** the patch is stored as a proposal or private draft and does not change canonical state

#### Scenario: Agent attempts canonical write
- **WHEN** an agent attempts to call a canonical writer operation
- **THEN** the operation is unavailable or rejected and canonical state remains unchanged

### Requirement: Deterministic admission
The system SHALL revalidate schema, references, scope, base version, state transition, provenance, and applicable policy before committing a machine-reviewed candidate. A model verdict alone SHALL NOT grant writer authority or determine admission.

#### Scenario: Admission succeeds
- **WHEN** a proposal passes deterministic admission checks and policy
- **THEN** the non-LLM writer commits it as L1 with provenance and policy version

#### Scenario: Admission is incomplete or rejected
- **WHEN** a required check fails, conflicts, or lacks evidence
- **THEN** the proposal remains uncommitted or is rejected with a structured reason

### Requirement: Independent finding review
The system SHALL require an independent review record bound to a fixed proposal/evidence snapshot before promoting a finding to L2. A proposal author or validating worker SHALL NOT approve its own result under the same reviewer identity.

#### Scenario: Independent review passes
- **WHEN** a distinct reviewer examines the fixed claim, evidence, counter-evidence, and limitations and records a passing verdict
- **THEN** the writer may promote the finding to L2 and retain the review reference

#### Scenario: Review is not independent
- **WHEN** reviewer identity matches the proposal author or validating worker, or snapshot binding differs
- **THEN** promotion is rejected and the record remains below L2

### Requirement: Append-only audit events
The system SHALL append an audit event for every canonical state transition, including actor attribution, commit sequence, policy/review references, input hash, changed fields, and prior-event hash. Audit events SHALL NOT contain Artifact contents or credential material.

#### Scenario: Commit a canonical transition
- **WHEN** the writer commits, rejects, retracts, or supersedes a record
- **THEN** an attributable event is atomically committed with the state change

#### Scenario: Verify audit continuity
- **WHEN** an operator verifies the event ledger
- **THEN** the system reports sequence, hash-chain, and materialized-view inconsistencies without silently repairing authoritative history
