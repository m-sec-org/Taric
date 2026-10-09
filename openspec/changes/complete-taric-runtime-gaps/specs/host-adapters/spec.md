# Spec Delta

## Scope

本变更只交付 Phase 1 的 Pi TypeScript adapter 与 MCP/CLI fallback 的最小 contract client。DeepSeek Harness、Hermes 真实 hook、宿主安装管理和跨框架完整 conformance 归入 `integrate-native-host-adapters`；本期不以 facade 或 capability 常量冒充已支持的 lifecycle。

## MODIFIED Requirements

### Requirement: Versioned adapter contract
系统 SHALL 定义 versioned adapter contract，至少覆盖 session lifecycle、context injection、proposal submission、worker/task attribution、checkpoint/handoff、action mode 和 host decision/result。Phase 1 Pi adapter 和 MCP/CLI fallback 只能声明已通过测试的 capability；每个请求必须经 authenticated Core service client 施加 Engagement/capability scope，不得直达 store/DB。adapter health/version 可报告支持矩阵；install/remove/config 及宿主专属诊断不属于本期。

#### Scenario: Adapter connects
- **WHEN** an adapter connects with a supported contract version
- **THEN** Taric validates its declared capabilities and exposes only compatible operations

#### Scenario: Adapter version is unsupported
- **WHEN** an adapter declares an unsupported contract version or capability
- **THEN** Taric reports incompatibility and does not infer unsupported lifecycle or enforcement behavior

#### Scenario: Capability is declared but hook is unavailable
- **WHEN** the supported runtime does not provide a declared hook in its current mode
- **THEN** the adapter reports that capability unavailable and does not silently simulate it

### Requirement: Host-specific adapters remain thin
Pi native adapter SHALL map已测试的 host lifecycle events 到共享 Taric contract，且不得实现第二份 authority store 或 admission 规则。MCP/CLI-only host 只能使用本期公开的 read/context/proposal/action recommendation；缺失 lifecycle capability 必须显式报告。retry、host reload 和 cancellation 不得丢失已提交状态，也不得重复确认过的幂等操作。

#### Scenario: Host lifecycle event is received
- **WHEN** a supported host event requests context, submits a proposal, commits a checkpoint, or reports an action result
- **THEN** the adapter maps it to the corresponding versioned Taric API operation

#### Scenario: MCP-only host connects
- **WHEN** a host uses MCP without native lifecycle hooks
- **THEN** it can use supported read, context, proposal, and recommendation operations while missing lifecycle capabilities remain explicit

#### Scenario: Host reload after checkpoint
- **WHEN** a host reloads after a checkpoint commit
- **THEN** the adapter can retrieve committed state without duplicating the checkpoint or claiming uncommitted progress

#### Scenario: Load the tested Pi extension
- **WHEN** a Pi extension is loaded through the tested extension API with pinned version metadata
- **THEN** callbacks are registered through the authenticated Core client and the adapter reports only capabilities covered by runtime contract tests

## Follow-up Boundary

`integrate-native-host-adapters` 将承接 DeepSeek Harness Cordis、Hermes general plugin RPC/hooks、adapter install/remove/config/health/version、宿主版本兼容矩阵和完整原生/MCP conformance。Hermes MemoryProvider 共存仍是后续 adapter 的 non-replacement 约束，不是本期可运行能力。
