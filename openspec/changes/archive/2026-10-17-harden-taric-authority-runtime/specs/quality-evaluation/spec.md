# Spec Delta

## MODIFIED Requirements

### Requirement: Enforce Phase 1 release gates
release report SHALL 明确以下本期 gate：单 Engagement 100 worker 并发写入无重复/回退 display ID；每个成功 commit 有唯一审计事件；L1→L2 未授权升级为 0；高危 Finding 缺少必需证据或独立 reviewer 时不得进入 L2；所有 active 可恢复 WorkRun 都有 checkpoint、lease/owner、context manifest 和 action state；未测和 blocked coverage 在白名单 projection/report 中可见，L0 仍只在获授权 proposal/review 工具可见；Pi/MCP/CLI contract tests 通过；单机 proposal/CAS mutation 到 query 可见的 p95 目标不高于 2 秒（以 Phase 0 基线确认）；模型审核不可用时保持 proposal-only，不 fail open。发布报告还必须分别声明每个 capability 的 `implementation_state`、`runtime_state`、`evidence_state` 和 follow-up，不能用已实现的存储原语或已归档 change 自动推导 runtime enabled。完整质量指标不作为本期 gate。

#### Scenario: Gate fails
- **WHEN** a required release metric, security/conformance test, or capability evidence consistency check fails
- **THEN** the release is marked failed with the failing evidence and is not reported as implementation-complete

#### Scenario: Gate passes
- **WHEN** all required tests and documented thresholds pass for the pinned versions and configuration
- **THEN** the report records the exact commit, schema/policy digests, fixture versions, sample sizes, capability states, and pass result

### Requirement: Layered statistical evidence
质量报告 SHALL 使用预先版本化的 web/host、risk category、evidence level 分层，记录每层样本量、人工 baseline、precision/recall、calibration error 和 95% confidence intervals；人工 baseline 必须记录标注者/审核流程、数据集版本、样本 digest 和时间范围，不能用 auditor 一致率、小样本 fixture 或调用方自报字段替代真实 truth/recall 证据。

#### Scenario: Insufficient sample layer
- **WHEN** 某风险/证据层样本量不足以支持预定置信区间或缺少标注 provenance
- **THEN** 报告明确标记不充分和限制，required release gate 不得被默认视为通过

#### Scenario: Reproduce a quality report
- **WHEN** an operator reruns a report with the pinned dataset, fixture, schema, policy, and commit digests
- **THEN** the report can reconstruct the sample and baseline provenance before comparing metrics
