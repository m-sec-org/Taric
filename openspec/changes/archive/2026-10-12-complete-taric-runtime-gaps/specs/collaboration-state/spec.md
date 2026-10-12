# Spec Delta

## Scope

本变更交付 Phase 0–1 单机协作状态：WorkItem/WorkRun/Attempt、lease/fencing、动作边界 checkpoint/handoff 和保守恢复建议。宿主创建、调度、取消及恢复 worker；Taric 不启动进程、不恢复隐藏推理、不自动重放目标动作。

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
系统 SHALL 仅允许 authenticated host adapter 在当前 owner/Attempt/lease/generation 下提交 checkpoint。契约必须包含 Engagement、WorkItem、run/attempt、scope 与任务目标版本、read_seq、context_snapshot_id/manifest hash、已完成步骤、待做步骤、Observation/Evidence 引用、限定阴性结果引用、未决假设、宿主决策引用、ActionIntent/外部动作状态、下一步、预算消耗及私有 draft/handoff 引用；无结果的列表须显式为空，不得靠省略字段暗示已验证。服务须校验引用归属/类型、scope/WorkItem 有效性、host attestation 和可核验 tool-result references，再原子更新 checkpoint、WorkRun 和事件。checkpoint 保存可执行状态，不要求或接受模型隐藏推理作为恢复依据。

#### Scenario: Commit a checkpoint
- **WHEN** the current host adapter submits a checkpoint against its active lease
- **THEN** Taric commits it and makes it available in the next resume context

#### Scenario: Stale checkpoint commit
- **WHEN** a checkpoint uses an expired lease or stale fencing generation
- **THEN** Taric rejects it without overwriting the current checkpoint

#### Scenario: Model client commits checkpoint
- **WHEN** a model-facing client invokes checkpoint commit
- **THEN** the service rejects the host-only operation

## ADDED Requirements

### Requirement: Model checkpoint proposals remain untrusted
模型接口 SHALL 只暴露 checkpoint.propose。该操作将结构化进度建议保存为绑定作者、WorkRun、Attempt 和 generation 的 L0 候选，不更新有效 checkpoint、不续租、不改变 WorkRun 状态、不影响 resume 安全边界。host adapter 必须重新读取候选、校验当前 lease、引用及工具结果并提交独立 checkpoint.commit；模型的完成声明不能替代 host attestation。

#### Scenario: Model proposes progress
- **WHEN** 当前 Attempt 的模型提交 checkpoint.propose
- **THEN** 服务保存 L0 候选并返回 proposal_id，有效 checkpoint_id、lease 和 WorkRun 状态保持不变

#### Scenario: Host commits a proposed checkpoint
- **WHEN** authenticated host adapter 基于当前 lease 校验进度候选和 tool-result references
- **THEN** host-only checkpoint.commit 按完整 checkpoint 契约生成新的已提交安全边界并保留候选来源

## MODIFIED Requirements

### Requirement: Safe recovery and external action reconciliation
系统 SHALL 支持从最近已提交 checkpoint 返回恢复包，并记录未知外部动作结果，不能自动重放动作。本期恢复包须含 checkpoint 及其固定 read_seq/manifest、当前 committed_seq、owner/Attempt/lease、未决 ActionIntent、scope/WorkItem 当前版本检查和宿主授权引用的可核验状态。scope、任务目标或直接 checkpoint 引用已变化，或授权/动作结果无法核验时，返回 blocked/replan_required 而不是安全续跑。旧 Attempt 私有 draft 保持原归属并封存，不自动纳入新 Attempt。基于依赖图的精细 resume delta、缓存失效和自动 rebase 不属于本期契约；不能把 current_seq 与 checkpoint_seq 相同当作授权证明。

#### Scenario: Resume after worker interruption
- **WHEN** a host starts a new attempt for an interrupted WorkRun
- **THEN** Taric 提供 checkpoint 的固定 read_seq/manifest、当前水位和保守版本/授权检查，宿主决定是否启动新 worker

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

## Deferred Follow-up

Phase 3：dependency graph 的 resume delta、checkpoint applicability 传播、私有 Markdown draft 的显式三方 rebase 和细粒度恢复缓存。Phase 4：完整扫描/工具崩溃 benchmark。其未实现不能阻塞本次首发，但本期所有写路径的 owner/lease/Attempt/generation fencing、未知结果对账和保守恢复检查必须通过。
