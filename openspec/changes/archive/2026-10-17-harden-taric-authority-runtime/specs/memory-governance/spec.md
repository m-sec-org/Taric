# Spec Delta

## MODIFIED Requirements

### Requirement: Deterministic admission
The system SHALL revalidate schema, references, scope, base version, state transition, provenance, and applicable policy before committing a machine-reviewed candidate. L0-to-L1 admission SHALL be explicitly limited to deterministic structural, reference, ownership, provenance, and version checks. L1-to-L2 promotion SHALL be a separate writer operation that re-evaluates evidence, freshness, independence, risk policy, and the fixed proposal/evidence snapshot. A model verdict alone SHALL NOT grant writer authority or determine either admission. Proposal transition, canonical mutation, audit, ID allocation, idempotency, and outbox SHALL commit atomically. Version checks SHALL occur in the same transaction as the mutation.

#### Scenario: Admission succeeds
- **WHEN** a pending proposal passes deterministic schema, scope, reference, provenance, and base-version checks
- **THEN** the non-LLM writer commits it as L1 with explicit machine-approved provenance and policy version

#### Scenario: L1 admission does not claim L2 review
- **WHEN** a proposal lacks the fixed evidence snapshot or independent reviewer required for L2
- **THEN** L1 admission may succeed only as machine-approved and the result remains ineligible for L2 or ordinary fact recall

#### Scenario: Admission is incomplete or rejected
- **WHEN** a required check fails, conflicts, or has an invalid candidate shape
- **THEN** the proposal remains uncommitted or is rejected with a structured reason and no partial state change

#### Scenario: Concurrent admission conflict
- **WHEN** two proposals use the same entity base version
- **THEN** at most one commits and the other remains a recorded conflict for rebase

### Requirement: Trust-level boundary
系统 SHALL 明确区分 L0 `proposal`、L1 `machine_approved` 和 L2 `independently_verified`。L0 只进入审核/提交者可见的 quarantine；L1 只能在显式 candidate 查询中作为带 provenance、evidence 状态和 limitations 的待验证线索；L2 只能由 non-LLM writer 在固定 proposal/evidence 输入上，经 service-verified 独立 reviewer 和确定性硬门后产生。任何模型 verdict、host action mode 或普通 `accept` 字段都不能提升 trust level。对外接口必须区分结构准入与 finding 晋升，不能将 L1 admission 响应解释为 L2 policy promotion。

#### Scenario: Candidate is not an ordinary fact
- **WHEN** 普通 query/context/projection 未显式请求 candidate leads
- **THEN** L0 和 L1 均不作为普通事实返回；L2 结果保留 reviewer、provenance 和 evidence refs

#### Scenario: Promote a finding to L2
- **WHEN** an authorized writer invokes the explicit promotion operation with a fixed input/evidence snapshot and an independent reviewer that satisfies the risk policy
- **THEN** the writer atomically records the L2 transition, review reference, policy digest, and audit event

#### Scenario: Trust escalation is attempted by a model
- **WHEN** model submission 携带 L1/L2、admitted、verified、reviewed 或 `accept=true`
- **THEN** service 拒绝或降为 L0 proposal，并记录原因，不授予 writer capability
