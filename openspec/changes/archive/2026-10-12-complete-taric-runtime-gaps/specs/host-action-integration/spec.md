# Spec Delta

## Scope

本变更只交付宿主动作的结构化建议、三种 host-selected mode、ActionIntent 记录和结果对账接口。Taric 不执行目标工具、不发放授权、不实现 HITL 身份；复杂动作策略和跨宿主适配属于后续变更。

## MODIFIED Requirements

### Requirement: Support host-selected action modes
系统 SHALL 支持记录 host 选择的 `llm_recommend`、`authorized_autonomous`、`host_hitl` 三种 mode。Taric 不设置全局默认，不从 LLM 建议推断授权。`action.recommend` 响应必须是结构化 advisory 数据，至少包含 target/method、rationale、uncertainty、scope/limitations 和 memory/evidence refs；不得包含执行字段、授权 grant 或调用目标工具。

#### Scenario: LLM recommendation mode
- **WHEN** an engagement uses `llm_recommend`
- **THEN** Taric returns a recommendation as advisory information and records no host authorization unless separately supplied by the host

#### Scenario: Authorized autonomous mode
- **WHEN** a host reports `authorized_autonomous`
- **THEN** Taric records the host-selected mode and decision reference but does not execute the action

#### Scenario: Host HITL mode
- **WHEN** a host reports `host_hitl`
- **THEN** Taric records the host-provided authorization outcome without implementing user identity or approval interaction

### Requirement: Record host action outcomes
系统 SHALL 将 host decision/result opaque refs 绑定 ActionIntent、Engagement、WorkRun、Attempt、owner 和 active generation。记录必须包含 target/method、稳定 action idempotency key、mode、host attribution、scope/authorization reference 和结果状态。`recommended` 可进入 `authorized` 或 `denied`；`authorized` 可进入 `executed`、`failed` 或 `unknown`；`denied` 不能进入执行状态。相同幂等 payload 重试不得重复转移。所有决策/结果写入须与 audit event 原子提交；`unknown` 只能经 host reconcile 和结果引用进入 resolved 状态，不能自动重放或清除。

#### Scenario: Host reports an execution outcome
- **WHEN** the adapter submits a host result for an ActionIntent
- **THEN** Taric stores the result state and opaque host reference with attempt attribution

#### Scenario: Retry host outcome
- **WHEN** the host repeats the same action result with the same idempotency key
- **THEN** Taric returns the original result without another state transition

#### Scenario: Wrong host or expired Attempt
- **WHEN** a host result does not match the active owner, lease, or generation
- **THEN** Taric rejects the current-state update and preserves any late result with original attribution

## Follow-up Boundary

复杂 action policy、宿主特定授权策略、异构 action recommendation 评估和跨宿主 adapter conformance 归入后续变更；本期只验证结构化建议、状态迁移、owner/lease/generation fencing、幂等与未知结果对账。
