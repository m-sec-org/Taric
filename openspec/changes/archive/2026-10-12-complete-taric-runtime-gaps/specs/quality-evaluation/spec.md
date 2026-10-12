# Spec Delta

## Purpose

定义 Phase 1 单机首发的可重复契约、隔离、恢复、投影和 writer 安全验收。质量研究、盲测和统计评估不是本变更的 runtime gate。

## ADDED Requirements

### Requirement: Provide reproducible Phase 1 conformance and fault evaluation
项目 SHALL 提供可重复测试，覆盖本期 versioned API/CLI/MCP 操作、admission、model/host/operator/writer 隔离、writer bypass、幂等、CAS、display ID、Engagement isolation、projection allowlist、Pi capability、lease takeover、stale generation、checkpoint/action fencing 和 doctor marker。测试必须覆盖事务边界故障、投影发布故障和未知 action 对账；snapshot import、完整 replay/rebuild 和多机 backend 不属于本期。

#### Scenario: Run the clean-checkout suite
- **WHEN** a clean checkout installs dependencies and runs the documented build-then-test command
- **THEN** Core, CLI, MCP, projection, storage, recovery, and adapter conformance tests execute without relying on pre-existing build artifacts

#### Scenario: Exercise a forbidden path
- **WHEN** a model client, stale attempt, or self-asserted reviewer tries a protected operation
- **THEN** the suite observes a stable denial, verifies that canonical/projection/current action state is unchanged, and checks any attributable rejection or late-result event without allowing unauthorized history modification

#### Scenario: Exercise a crash point
- **WHEN** the test terminates the process at each declared commit, outbox, checkpoint, or projection publication boundary
- **THEN** restart either recovers a complete state or reports an explicit repair state, with no silent partial success

### Requirement: Run minimum trust and poisoning regressions
本期 SHALL 至少使用 canary 字段、恶意 proposal/Markdown/tool response、作者自审、模型 `accept=true`、edge block 和 bounded negative fixtures 验证：它们不能改变 writer capability、trust level、host authorization、projection allowlist 或 origin coverage。样本统计、人工基线、precision/recall、unsupported-claim rate、误报/漏报置信区间和大规模 poisoning benchmark 归入 `validate-memory-quality`。

#### Scenario: Run a known-positive case
- **WHEN** a representative fixture contains a supported finding and evidence
- **THEN** the evaluation records whether the finding is retrieved, preserved through review, and eligible for the required trust level

#### Scenario: Run a known-negative or blocked case
- **WHEN** a fixture contains a bounded negative observation or edge control block
- **THEN** the evaluation verifies that Taric does not convert it into a universal absence claim or origin-level coverage closure

#### Scenario: Inject untrusted instructions
- **WHEN** malicious instructions appear in an Artifact reference, tool response, Markdown draft, or proposal
- **THEN** they cannot alter policy, trust level, writer capability, host authorization, or projection allowlists

### Requirement: Enforce Phase 1 release gates
release report SHALL 明确以下本期 gate：单 Engagement 100 worker 并发写入无重复/回退 display ID；每个成功 commit 有唯一审计事件；L1→L2 未授权升级为 0；高危 Finding 缺少必需证据或独立 reviewer 时不得进入 L2；所有 active 可恢复 WorkRun 都有 checkpoint、lease/owner、context manifest 和 action state；未测和 blocked coverage 在白名单 projection/report 中可见，L0 仍只在获授权 proposal/review 工具可见；Pi/MCP/CLI contract tests 通过；单机 proposal/CAS mutation 到 query 可见的 p95 目标不高于 2 秒（以 Phase 0 基线确认）；模型审核不可用时保持 proposal-only，不 fail open。完整质量指标不作为本期 gate。

#### Scenario: Gate fails
- **WHEN** a required release metric or security/conformance test fails
- **THEN** the release is marked failed with the failing evidence and is not reported as implementation-complete

#### Scenario: Gate passes
- **WHEN** all required tests and documented thresholds pass for the pinned versions and configuration
- **THEN** the report records the exact commit, schema/policy digests, fixture versions, sample sizes, and pass result

## Follow-up Boundary

`validate-memory-quality` 承接 known-positive/negative 分层语料、人工基线、finding/retrieval precision-recall、unsupported-claim/coverage miss、95% CI、异构 review agreement、规模化 poisoning 和恢复/延迟统计。其未交付不作为本期发布 gate；本期最小安全、功能和性能 gate 必须独立报告，不能用延期掩盖失败。
