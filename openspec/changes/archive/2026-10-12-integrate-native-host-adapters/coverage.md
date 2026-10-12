# 设计覆盖索引

本变更交付当前锁定宿主 API 实际提供的接入能力。宿主能力缺失时保持 `unavailable`，不以 MCP/CLI 模拟原生生命周期。

| 范围 | 承接内容 | 规格/任务 | 验收证据 |
|---|---|---|---|
| Core/adapter 信任边界 | 认证 principal、Engagement scope、Core 独占 authority | Authenticated transport；1.2 | Unix socket token/scope test、writer bypass test |
| 版本与能力证据 | host version/commit、contract、capability、fallback、test evidence | Manifest requirement；1.1、2.3、4.3 | 固定版本 descriptor 和 unknown-version fixture |
| DeepSeek Cordis | session/created、session/event、session/flush、session/disposed | Session-event requirement；2.1、2.2 | host API shape contract test、duplicate event idempotency |
| Hermes general plugin | pre_llm context、pre/post tool observer、session start/end/finalize/reset | Hermes requirement；3.1–3.3 | plugin callback/RPC tests、provider coexistence、failure tests |
| 缺失生命周期能力 | 不支持 proposal/checkpoint/action-result/cancel/reload 的 DeepSeek/Hermes 原生 hook | capability requirement；2.2、3.1 | missing capability assertions 和 compatibility diagnostics |
| 管理与 fallback | Taric-only install/remove/config/health/version；MCP/CLI fallback | Management requirement；4.1–4.3 | CLI command tests、config isolation tests、docs |

## 数据类型覆盖

`AdapterDescriptor` 和 compatibility manifest 只声明已测试宿主能力。WorkRun、Attempt、Checkpoint 与 ActionIntent 的状态和 fencing 仍由 Core contract 管理；本变更不会从 session/tool observer 推断这些状态。

## 明确不在本变更

DeepSeek/Hermes 原生 proposal、checkpoint、action decision/result、cancel 和 reliable reload/resume hooks；Hermes MemoryProvider replacement；完整 agent loop、worker 调度、目标工具执行、凭据及新的 authority store。
