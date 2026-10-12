# host-adapters Specification

## Purpose
Defines a versioned, host-independent integration contract so supported agent frameworks can exchange context and collaboration state without moving host execution policy into Taric.

## Requirements

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

### Requirement: Hermes default integration coexists with memory providers
The default Hermes integration SHALL use a general plugin and SHALL NOT replace the host's selected external memory provider. A MemoryProvider integration is outside the default capability set.

#### Scenario: Install default Hermes integration
- **WHEN** the general plugin is enabled
- **THEN** Taric lifecycle integration is available without changing Hermes' external memory provider selection

### Requirement: Authenticated adapter transport and capability evidence
Native adapters MUST call the shared Taric contract through an authenticated, Engagement-scoped Core transport. The compatibility manifest SHALL bind host version/commit, Taric contract version, the capabilities actually exposed by the pinned host API, fallback operations, stable errors, and test evidence. Core SHALL validate the transport principal and Engagement before dispatch; run-scoped Core operations SHALL continue to enforce Attempt and lease fencing. Adapters MUST NOT expose authority stores or database handles.

#### Scenario: Adapter connects with verified capabilities
- **WHEN** a pinned adapter connects through the scoped transport
- **THEN** Core diagnostics report its contract and only the tested host capabilities are advertised

#### Scenario: Unknown host release connects
- **WHEN** a host version or commit is absent from the manifest
- **THEN** the adapter reports `unsupported_capability`, exposes no native capabilities, and lists only actual MCP/CLI fallback operations

#### Scenario: Adapter requests another Engagement
- **WHEN** an authenticated adapter dispatches a request outside its principal's Engagement
- **THEN** Core returns `authorization_error` without changing authority state

### Requirement: DeepSeek Harness session-event adapter
The pinned DeepSeek Harness/Cordis integration SHALL register only the session events present in its tested API: `session/created`, `session/event`, `session/flush`, and `session/disposed`. It SHALL report session lifecycle only. Context injection, proposal submission, checkpoint, action/result, cancellation, and reload capabilities MUST remain unavailable unless a pinned host API and its contract test provide those hooks. Duplicate identified session events SHALL return the same in-process adapter result. Unknown releases SHALL report unsupported.

#### Scenario: Session lifecycle event arrives
- **WHEN** the pinned Cordis session service emits a supported event
- **THEN** the adapter preserves session/event identity and returns a structured observer result without claiming a Taric state transition

#### Scenario: Required operation has no Harness hook
- **WHEN** a caller requests context, proposal, checkpoint, action/result, cancel, or reload integration
- **THEN** diagnostics list the capability as missing and do not simulate a callback

### Requirement: Hermes general plugin coexistence
The Hermes general plugin SHALL register only documented `pre_llm_call`, `pre_tool_call`, `post_tool_call`, and session lifecycle hooks. It MAY request a Core Context Pack from `pre_llm_call` and observe tool/session events; it SHALL NOT claim proposal, checkpoint, action-result, or cancellation integration. It MUST NOT change the selected external MemoryProvider. Core transport failures SHALL produce stable plugin errors and MUST NOT be reported as saved Taric state.

#### Scenario: General plugin runs with an external MemoryProvider
- **WHEN** the Taric plugin is enabled
- **THEN** it registers its supported general hooks and leaves Hermes provider configuration untouched

#### Scenario: Core is unavailable
- **WHEN** a callback cannot reach Core
- **THEN** it raises a stable integration error and does not return a successful write or saved-state result

#### Scenario: MemoryProvider replacement is requested
- **WHEN** an operator requests Taric as Hermes' MemoryProvider
- **THEN** the plugin reports that this capability is unsupported

### Requirement: Adapter management and truthful fallback
Taric SHALL provide install/remove/config/health/version commands that only manage Taric adapter configuration. Health output SHALL identify host version/commit, Core connection state, supported and missing capabilities, and fallback. Missing host hooks MUST remain unavailable. Removing an adapter MUST NOT alter authority or Hermes provider configuration.

#### Scenario: Remove an adapter
- **WHEN** an operator removes an installed adapter
- **THEN** only its Taric adapter configuration is removed

#### Scenario: Use fallback for a missing lifecycle hook
- **WHEN** a native host hook is unavailable and MCP/CLI is available
- **THEN** diagnostics allow only documented fallback operations and do not claim automatic checkpoint or reliable resume
