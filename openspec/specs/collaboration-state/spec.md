# collaboration-state Specification

## Purpose
Defines durable collaboration state that lets host-managed workers hand off and resume long-running engagement work without making Taric an agent scheduler.

## Requirements

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

### Requirement: Model checkpoint proposals remain untrusted
模型接口 SHALL 只暴露 checkpoint.propose。该操作将结构化进度建议保存为绑定作者、WorkRun、Attempt 和 generation 的 L0 候选，不更新有效 checkpoint、不续租、不改变 WorkRun 状态、不影响 resume 安全边界。host adapter 必须重新读取候选、校验当前 lease、引用及工具结果并提交独立 checkpoint.commit；模型的完成声明不能替代 host attestation。

#### Scenario: Model proposes progress
- **WHEN** 当前 Attempt 的模型提交 checkpoint.propose
- **THEN** 服务保存 L0 候选并返回 proposal_id，有效 checkpoint_id、lease 和 WorkRun 状态保持不变

#### Scenario: Host commits a proposed checkpoint
- **WHEN** authenticated host adapter 基于当前 lease 校验进度候选和 tool-result references
- **THEN** host-only checkpoint.commit 按完整 checkpoint 契约生成新的已提交安全边界并保留候选来源

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
