# Proposal

## Why

首发与 Phase 3 能保存候选、证据、覆盖和版本，但不能仅凭格式校验或两个相同 auditor 的一致意见证明 finding 可靠。该变更交付 Phase 4 的非 LLM policy guard、异构 A/B 独立审核、完整 coverage/反证/lifecycle 语义、投毒盲测和可重复 release report，继续保持 Taric 是独立插件而非扫描平台。

## What Changes

- 完善 machine admission、L1/L2 trust transition、reviewer capability、固定输入快照和异构 A/B 审核策略。
- 完整实现 coverage matrix、bounded negative、blocked-by-control、反证和 lifecycle guard；未测/阻塞/矛盾结果保持可见。
- 为过期、supersede、retract、archive、stale 和 review-after 建立当前召回与历史查询边界。
- 建立 HTTP/tool/Markdown/proposal poisoning、权限旁路、writer bypass 和 prompt-injection 评估。
- 按 web/host、风险类别、证据等级输出 precision/recall、unsupported claim、coverage miss、calibration error、FP/FN、传播错误、延迟和恢复指标及 95% CI。
- 完成 authority event replay、projection rebuild、doctor/reconcile 验收，并以 release report 阻止失败发布。

## Capabilities

### New Capabilities

- `memory-quality-evaluation`: 质量、投毒、覆盖和发布闸门的可重复评估。

### Modified Capabilities

- `memory-governance`: 增加 Phase 4 的异构独立审核、L2 promotion 和 lifecycle guard。
- `engagement-memory`: 增加完整 coverage、反证、负结果和召回生命周期语义。
- `quality-evaluation`: 增加分层 calibration error、95% CI、replay/rebuild 和 release report。

## Impact

- 影响 Core policy/admission/review/recall/coverage、evaluation fixtures、doctor/replay/rebuild、报告生成和 CI release gate。
- 依赖首发与 Phase 3 的 authority、revision/impact、pinned Context、projection、快照和 adapter contract；本变更不创建 host runtime。
- 不实现模型供应商、扫描器、目标工具、凭据、HITL 身份、动作授权或跨 Engagement 知识共享。
- 质量评估只衡量 Taric 记忆治理对结果的贡献，不宣称代替宿主扫描能力或保证模型无幻觉。

设计章节、数据类型、质量指标和 §15 验收的逐项映射见同目录 `coverage.md`。
