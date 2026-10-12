# memory-governance Specification

## Purpose
Defines the controlled write and review lifecycle that keeps model-generated proposals separate from canonical memory and verified findings.

## Requirements

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
本期 SHALL 要求独立 reviewer service capability、固定 proposal/evidence input hash、作者/验证 worker 排除、evidence refs/limitations/scope/time/policy digest 和原子 promotion。Reviewer context 至少包含 claim、evidence、counter-evidence、limitations 与 rubric，不得读取先前 reviewer 的结论正文；model/version/input hash 必须保留。异构模型、多 Auditor 编排和质量统计归入 `validate-memory-quality`，但不得降低本期 L2 硬门。

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

#### Scenario: Verify the startup doctor marker
- **WHEN** operator 执行 `audit.doctor` 或服务启动发现 pending operation marker
- **THEN** 服务报告受影响 operation/sequence、可重试或需人工修复状态，不把未完成派生工作标为成功

#### Scenario: Record a proposal or review transition
- **WHEN** a proposal is submitted, a review is recorded, or admission is rejected
- **THEN** the corresponding attributable event records its input hash and reason

### Requirement: Trust-level boundary
系统 SHALL 明确区分 L0 `proposal`、L1 `machine_approved` 和 L2 `independently_verified`。L0 只进入审核/提交者可见的 quarantine；L1 只能在显式 candidate 查询中作为带 provenance、evidence 状态和 limitations 的待验证线索；L2 只能由 non-LLM writer 在固定 proposal/evidence 输入上，经 service-verified 独立 reviewer 和确定性硬门后产生。任何模型 verdict、host action mode 或普通 `accept` 字段都不能提升 trust level。

#### Scenario: Candidate is not an ordinary fact
- **WHEN** 普通 query/context/projection 未显式请求 candidate leads
- **THEN** L0 和 L1 均不作为普通事实返回；L2 结果保留 reviewer/provenance/evidence refs

#### Scenario: Trust escalation is attempted by a model
- **WHEN** model submission 携带 L1/L2、admitted、verified、reviewed 或 `accept=true`
- **THEN** service 拒绝或降为 L0 proposal，并记录原因，不授予 writer capability
