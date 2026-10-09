# Proposal

## Why

单机 Core 首发后，Pi/MCP/CLI 之外的宿主接入仍停留在 facade，DeepSeek Harness 和 Hermes 无法在真实生命周期中获得上下文、提交提案或回传 checkpoint。该变更把 Phase 2 的适配器能力落到经过版本锁定和契约测试的宿主入口，同时保持 Taric 只是独立记忆与协作插件。

## What Changes

- 为适配器建立受认证的 Core transport、版本和 capability manifest。
- 实现锁定版本的 DeepSeek Harness Cordis 生命周期桥接，并在未测试版本上明确报告 unsupported。
- 实现 Hermes Python general plugin，连接 Core 生命周期，不替换 Hermes 已选 MemoryProvider。
- 提供 adapter install/remove/config/health/version 管理和取消、重载、错误映射。
- 让原生适配器与 MCP/CLI fallback 使用同一契约；不复制 admission、writer、scope 或动作授权规则。
- 用真实宿主 contract tests 验证 session、context、proposal、checkpoint、action/result、cancel 和 reload；未提供 hook 时只报告缺失能力。

## Capabilities

### New Capabilities

- `host-adapter-management`: 管理已验证的宿主适配器安装、能力和诊断。

### Modified Capabilities

- `host-adapters`: 增加 DeepSeek Harness 生命周期桥接、Hermes general plugin、认证 transport 和真实能力回退。

## Impact

- 影响 `packages/core`、`packages/hermes-plugin`、适配器包、compatibility manifest、CLI 管理命令和接入文档。
- 依赖 `complete-taric-runtime-gaps` 归档后提供的 Core service、scoped client、capability、checkpoint 和稳定错误契约。
- 只在已锁定且通过真实 contract tests 的 host/version 上宣称原生支持；不实现 agent loop、worker 调度、目标工具执行、凭据、HITL 身份或新的 authority store。
- 该变更只交付宿主接入层，不扩大 Taric 为平台或宿主运行时。

设计章节、数据类型、任务和 §15 验收的逐项映射见同目录 `coverage.md`。
