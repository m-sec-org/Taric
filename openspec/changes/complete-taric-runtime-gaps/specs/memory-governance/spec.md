# Spec Delta

## MODIFIED Requirements

### Requirement: Proposal-only model writes
Model-facing interfaces SHALL allow agents to submit proposals, observations, patches, and private drafts, but SHALL NOT expose canonical writer or admission commands. Clients SHALL NOT set proposal admission status or trust level. The Core service SHALL retain writer capability internally and SHALL NOT expose the database handle through an adapter.

#### Scenario: Agent submits a patch
- **WHEN** an agent submits a valid patch through a model-facing interface
- **THEN** the patch is stored as a proposal or private draft and does not change canonical state

#### Scenario: Agent attempts canonical write
- **WHEN** an agent attempts to call a canonical writer operation
- **THEN** the operation is unavailable or rejected and canonical state remains unchanged

#### Scenario: Agent sets an admitted status
- **WHEN** an agent supplies admitted status or an L2 trust level in a submission
- **THEN** the service rejects the privileged fields and does not create an admitted record

### Requirement: Deterministic admission
The system SHALL revalidate schema, references, scope, base version, state transition, provenance, and applicable policy before committing a machine-reviewed candidate. A model verdict alone SHALL NOT grant writer authority or determine admission. Proposal transition, canonical mutation, audit, ID allocation, idempotency, and outbox SHALL commit atomically. Version checks SHALL occur in the same transaction as the mutation.

#### Scenario: Admission succeeds
- **WHEN** a proposal passes deterministic admission checks and policy
- **THEN** the non-LLM writer commits it as L1 with provenance and policy version

#### Scenario: Admission is incomplete or rejected
- **WHEN** a required check fails, conflicts, or lacks evidence
- **THEN** the proposal remains uncommitted or is rejected with a structured reason

#### Scenario: Concurrent admission conflict
- **WHEN** two proposals use the same entity base version
- **THEN** at most one commits and the other remains a recorded conflict for rebase

### Requirement: Independent finding review
The system SHALL require an independent review record bound to a fixed proposal/evidence snapshot before promoting a finding to L2. A proposal author or validating worker SHALL NOT approve its own result under the same reviewer identity. The reviewer SHALL possess a service-verified review capability, and promotion SHALL validate evidence freshness, limitations, reproducibility, applicable scope/time, and policy digest before an atomic transition. Independent reviewer context SHALL contain claim, evidence, counter-evidence, limitations, and rubric without the earlier reviewer's conclusion text; reviewer/model versions and input hashes SHALL be retained.

#### Scenario: Independent review passes
- **WHEN** a distinct reviewer examines the fixed claim, evidence, counter-evidence, and limitations and records a passing verdict
- **THEN** the writer may promote the finding to L2 and retain the review reference

#### Scenario: Review is not independent
- **WHEN** reviewer identity matches the proposal author or validating worker, or snapshot binding differs
- **THEN** promotion is rejected and the record remains below L2

#### Scenario: Review capability is missing
- **WHEN** a client names a reviewer without a review capability
- **THEN** the service rejects review submission and does not promote the finding

### Requirement: Append-only audit events
The system SHALL append an audit event for every governance and canonical state transition, including writer/actor/host/worker/dispatch attribution where applicable, WorkItem/WorkRun/Attempt, proposal/review/entity references, commit sequence, policy digest, input/evidence hashes, idempotency key, changed fields, before/after hashes, and prior-event hash. Audit events SHALL NOT contain Artifact contents or credential material. Verification SHALL check the hash chain, sequence, materialized views, display sequence, writer source, and outbox consistency. Reconcile SHALL report drift and offer explicit rebuild/recovery actions without silently altering history. Taric SHALL NOT manage audit-signing key custody.

#### Scenario: Commit a canonical transition
- **WHEN** the writer commits, rejects, retracts, or supersedes a record
- **THEN** an attributable event is atomically committed with the state change

#### Scenario: Verify audit continuity
- **WHEN** an operator verifies the event ledger
- **THEN** the system reports sequence, hash-chain, and materialized-view inconsistencies without silently repairing authoritative history

#### Scenario: Record a proposal or review transition
- **WHEN** a proposal is submitted, a review is recorded, or admission is rejected
- **THEN** the corresponding attributable event records its input hash and reason
