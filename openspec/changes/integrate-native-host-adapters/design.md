# Design

## Context

本变更依赖 `complete-taric-runtime-gaps` 的单机 Core service 和 versioned contract。当前 Pi/DeepSeek facade 与 Hermes 事件转换不能证明真实 hook、身份归属或错误处理；本变更只处理宿主边界，宿主仍负责模型、调度和目标动作。

设计条款到规格、任务和 §15 验收的覆盖关系以同目录 `coverage.md` 为索引。

## Goals / Non-Goals

**Goals:**

- 让每个适配器通过受认证的 scoped Core client 调用共享规则。
- 以 capability manifest 描述真实可用的 lifecycle hooks、host/version、contract version 和 fallback。
- 让 DeepSeek Harness 与 Hermes 的失败、取消、重载和重复回调可观察、可重试且不重复提交。
- 让安装管理和诊断反映测试证据，而不是根据声明推断能力。

**Non-Goals:**

- 不实现 agent loop、worker 调度、工具执行、动作授权、凭据、Artifact 内容管理或 host 人员身份。
- 不替换 Hermes external MemoryProvider，不创建第二套 authority、admission 或 policy。
- 不把未测试 host/version 当作兼容，也不以 MCP fallback 模拟缺失 lifecycle hook。

## Decisions

### 1. 受认证 Core client

原生适配器只持有服务签发的 scoped transport capability，提交前由服务验证 principal、engagement、Attempt/lease 和 contract version。适配器不取得 `AuthorityStore` 或数据库句柄。直接嵌入 store 的方案会绕过首发 writer 边界，因此不采用。

### 2. Capability manifest 驱动加载

每个 host/version/commit 的 manifest 列出已验证的 hooks、错误映射、cancel 语义和 fallback；连接时交叉验证运行时元数据。声明了但运行时缺少的 hook 标记 unavailable，不能由空函数模拟。

### 3. 独立桥接与共享契约

DeepSeek 使用锁定 Cordis 版本的生命周期桥接，Hermes 使用 general plugin RPC；二者只映射事件到 Core contract。admission、writer、scope、idempotency 和动作授权保持在 Core/宿主，不在适配器复制。

### 4. 管理操作的可逆性

install/remove/config 只改 Taric 适配器文件与配置，健康诊断读取 manifest 和 Core connection 状态。加载失败保留原配置并返回稳定错误；MCP/CLI fallback 只展示实际支持的能力。

## Risks / Trade-offs

- [宿主 preview API 变化] → 按 host commit 锁定 manifest，契约测试失败时标记 unsupported 并降级 MCP/CLI。
- [原生插件与宿主共享 OS 身份] → 文档说明 sandbox/profile 责任，transport capability 不宣称 OS 隔离。
- [回调重复或重载] → 使用 Core idempotency key 与 session identity，测试重载后不会重复 proposal/checkpoint。
- [Hermes provider 冲突] → general plugin 不修改 provider 选择，安装诊断明确 MemoryProvider 不属于默认能力。

## Migration Plan

先发布 manifest、Core client 和诊断，再逐个启用真实 host contract tests。现有 facade 只保留为未支持状态的诊断入口；通过测试的 host 才切换为 native capability。回滚时禁用适配器配置并使用 MCP/CLI，不迁移 authority 数据。
