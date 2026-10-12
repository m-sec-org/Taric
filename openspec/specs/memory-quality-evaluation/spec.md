# memory-quality-evaluation Specification

## Purpose

为 Taric 的信任升级、覆盖闭环、投毒防护、事件恢复和发布决策提供分层、可重复、带置信区间的质量证据；评估不会替代宿主动作或扫描策略。

## Requirements

### Requirement: Deterministic trust promotion and heterogeneous review

Taric SHALL 由 non-LLM policy engine 根据 schema、scope、provenance、evidence、freshness、limitations、reproducibility、risk profile 和 policy digest 重算 L1 admission。L2 finding MUST 绑定固定 claim/evidence snapshot、独立 reviewer capability、input hash 和 review/model/ruleset versions；高/严重风险 policy SHALL 可要求异构 reviewer、模型、提示、规则栈或人工。模型 verdict、同模型同提示 agreement 或 caller trust field 不得直接 promotion。

#### Scenario: Missing independent review
- **WHEN** L1 candidate 没有固定证据快照、独立 capability 或满足风险 profile 的 reviewer
- **THEN** promotion 被拒且记录结构化原因，内容保持 L1/proposal

#### Scenario: Heterogeneous review for high risk
- **WHEN** 高风险 finding 仅提供与 Auditor A 相同模型/提示的 reviewer verdict
- **THEN** policy 要求额外异构审核或人工审核，不将一致意见当作 L2 事实

### Requirement: Complete coverage and bounded negative semantics

Coverage SHALL 按 resource revision × test category × identity/role/tenant × operation/path/parameter × conditions 维护独立 cell，并区分 not_tested、queued、in_progress、tested_no_observation、positive、inconclusive、blocked、blocked_by_control、not_applicable。Negative observation MUST 带 method、baseline/control、conditions、identity、time、limitations 和 evidence；edge/control block 不得关闭 origin-level coverage。

#### Scenario: Bounded negative
- **WHEN** 指定主体、路径和条件下未复现 claim
- **THEN** 仅更新匹配 cell 为 bounded negative/tested_no_observation，不声称普遍不存在

#### Scenario: Contradictory evidence
- **WHEN** 新 evidence 反驳关键 claim
- **THEN** claim/finding 进入 inconclusive/contradicted 或 stale，排入 revalidation；历史 evidence 和 observation 保持原值

### Requirement: Memory lifecycle and recall guard

Taric SHALL 支持 review_after、expires_at、supersede、retract、archive 和 dependency-stale 状态。当前普通 recall SHALL 排除 retracted/superseded/archived/过期 stale 项并展示适用性、来源和限制；authorized as-of query SHALL 仍可读取历史版本和事件。未完成 impact/revalidation、conflict evidence 或外部 result SHALL 在 report/context 中可见。

#### Scenario: Expired dynamic observation
- **WHEN** observation 超过 review-after 或 expiry 时间
- **THEN** current recall 标记 stale/降低可用性，不作为当前事实呈现

#### Scenario: Retracted claim as-of
- **WHEN** authorized operator 查询已 retract 的 claim
- **THEN** ordinary recall 排除它，而 as-of 查询返回旧版本、retraction event 和来源

### Requirement: Reproducible poisoning evaluation and release report

项目 SHALL 维护版本化 positive/negative/blocked/stale/conflict/forged evidence、web/host、prompt injection 和 memory poisoning fixtures。release report SHALL 按 web/host、risk category、evidence level 分层报告 sample count、finding/retrieval precision/recall、unsupported-claim rate、coverage miss、calibration error、erroneous propagation、review agreement、guard FP/FN、write latency、recovery success 和 95% confidence intervals，并记录 fixture/schema/policy/commit digests。任一 required gate 失败 SHALL 阻止通过报告；缺失模型审核 SHALL remain proposal-only，不得 fail open。

#### Scenario: Poisoning input
- **WHEN** 恶意指令出现在 Artifact reference、HTTP/tool response、Markdown draft、proposal 或 reviewer payload
- **THEN** policy、trust、writer capability、host authorization 和 projection allowlist 不改变

#### Scenario: Failed release gate
- **WHEN** L1→L2 bypass、high/critical unsupported claim、known-positive recall、coverage visibility、adapter compatibility、100-worker ID/event 或 p95 gate 失败
- **THEN** report 标记 failed，不能报告 implementation-complete

### Requirement: Explicit authority doctor and replay

Authority event SHALL 作为派生 view/outbox 恢复源。系统 MUST 支持 operation marker pending→applied→indexed 与 failed/recovered、启动 doctor、hash chain/sequence/counter/idempotency/outbox/projection drift 检查。replay/rebuild/reconcile MUST 是 operator-only、可 preview、保留权威历史；权威漂移必须阻塞写入并输出 repair/recovery report。

#### Scenario: Doctor detects drift
- **WHEN** operator 在派生 view 或 outbox 部分失败后运行 doctor
- **THEN** 系统报告 sequence/hash/counter/view drift 和 repair action，不声称静默修复

#### Scenario: Explicit rebuild
- **WHEN** operator 明确请求支持的 view replay/rebuild
- **THEN** view 从 authority event 重建并报告结果 sequence/未解决错误，权威历史不被覆盖
