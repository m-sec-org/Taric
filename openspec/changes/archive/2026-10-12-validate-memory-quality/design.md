# Design

## Context

本变更依据 `docs/taric-design.md` §5、§9–11、§15.2–15.4，建立从 L0 proposal 到 L1 candidate 和 L2 verified finding 的可审计状态机。Phase 3 提供 revision/impact/coverage 载体；本变更增加策略和评估，不把 auditor 变成 Taric 的调度器或目标执行器。

策略、生命周期、质量指标、doctor 和 §15 验收的覆盖关系以同目录 `coverage.md` 为索引。

## Goals / Non-Goals

**Goals:**

- 用非 LLM policy engine 重算硬门，阻止 caller 或模型 verdict 直接授予 writer/L2 权限。
- 让高风险 claim 可要求异构 reviewer/model/ruleset 或人工 reviewer，并固定 evidence snapshot、input hash、policy digest。
- 让 coverage cell 以 resource revision × test category × identity × operation/parameter × conditions 记录正、负、blocked、blocked-by-control 和 not-applicable。
- 通过分层盲测、calibration error、95% CI 和 replay/rebuild 形成可复核 release evidence。

**Non-Goals:**

- 不提供扫描器、模型供应商、目标动作、HITL 身份系统或动作授权。
- 不把 auditor agreement 当作事实证明，不把 edge block 当作 origin coverage closure。
- 不删除历史、不静默全 engagement 撤销、不跨 Engagement 共享知识。

## Decisions

### 1. 硬门与 advisory review 分离

Auditor A/B 输出 advisory verdict；policy engine 根据 schema、scope、evidence、freshness、independence 和风险 profile 重新计算 admission。L1 candidate 与 L2 finding 是不同状态；缺少 reviewer/model 时 fail closed 保持 proposal/L1。

### 2. 风险分层的独立性

普通 claim 可由独立 reviewer 验证；高/严重或高影响 claim 的 policy SHALL 要求不同模型、提示、规则栈或人工 reviewer，并固定其版本和输入 hash。相同模型同提示的一致性只能作为线索，不能满足强独立性。

### 3. Coverage 与反证作为可查询状态

每个 cell 单独更新并引用 WorkItem/Run/Evidence/time。bounded negative 只说明条件下未观察到；反证使 claim/finding stale/inconclusive 并进入 revalidation，历史 observation 不变。blocked-by-control 不关闭 origin cell。

### 4. 可重复评估和 release report

fixture corpus 版本化，按 web/host、风险类别、证据等级分层。报告记录样本量、人类 baseline、precision/recall、unsupported claim、coverage miss、calibration error、review agreement、FP/FN、传播错误、延迟、恢复成功率和 95% CI；任一 required gate 失败即报告失败。

### 5. Doctor、replay 和 rebuild

authority event 是派生视图恢复源。doctor 检查 operation marker、hash chain、sequence、counter、idempotency、outbox、projection drift；operator 只能显式 preview/replay/rebuild，恢复写入必须产生事件，不静默覆盖历史。

## Risks / Trade-offs

- [样本量不足] → 报告样本量和置信区间，不能用小样本通过替代门槛。
- [异构 reviewer 成本高] → 仅按 risk class 强制，低风险仍保留可审计独立 reviewer。
- [影响传播未完成] → coverage/report 标记 pending watermark，禁止宣称全量当前。
- [修复误改 authority] → replay/rebuild 只更新派生状态，权威历史漂移阻塞并输出 repair action。

## Migration Plan

先导入 fixture、policy/risk profiles 和 report schema，再启用 L1/L2 transition 与 coverage/lifecycle guards。随后接入 poisoning/盲测和 doctor/replay/rebuild。旧 finding 无法绑定固定 evidence/reviewer 时降级为 L1 或 quarantine，不自动补默认审核。
