# Spec Delta

## ADDED Requirements

### Requirement: Authenticated adapter transport and capability evidence

原生适配器 MUST 通过受认证的 scoped Core transport 调用共享 Taric contract。每个 adapter manifest SHALL 绑定 host/version/commit、contract version、capabilities、fallback 和测试证据；服务 SHALL 在读取或写入前验证 transport principal、Engagement 权限及 Attempt/lease 归属。适配器不得暴露 authority store、数据库句柄或复制 admission 规则。

#### Scenario: Adapter connects with verified capabilities
- **WHEN** 已锁定 host/version 的适配器携带匹配 manifest 和 transport capability 连接
- **THEN** Core 只开放 manifest 中已通过测试的操作，并返回 contract、host、commit 和 capability 诊断

#### Scenario: Declared hook is unavailable
- **WHEN** manifest 声明的 hook 在当前 host 模式不存在
- **THEN** 适配器将该 capability 标记为 unavailable，拒绝模拟生命周期行为，并保留可用 fallback

#### Scenario: Adapter attempts direct authority access
- **WHEN** 适配器尝试取得数据库句柄或绕过 Core 提交 canonical state
- **THEN** 服务拒绝请求且不改变 authority、projection、lease 或审计状态

### Requirement: DeepSeek Harness lifecycle bridge

锁定的 DeepSeek Harness Cordis adapter SHALL 将真实 session、context、proposal、checkpoint、action/result、cancel 和 reload 事件映射到对应 Taric API。未在 compatibility manifest 中的版本 SHALL 报告 unsupported，不得推断兼容或虚报 lifecycle 能力。回调 SHALL 保留 host/agent/dispatch/Attempt 归属并使用幂等键。

#### Scenario: Supported Harness event
- **WHEN** 受支持的 Harness 触发 session 或 tool lifecycle event
- **THEN** adapter 调用对应 Core contract，并返回结构化结果、稳定错误和正确归属

#### Scenario: Unsupported Harness release
- **WHEN** Harness release 或 preview commit 不在测试 manifest 中
- **THEN** adapter 返回 unsupported diagnostic，只提供实际可用的 MCP/CLI fallback

#### Scenario: Reload after committed checkpoint
- **WHEN** Harness reload 后再次请求同一 session 的 checkpoint/context
- **THEN** adapter 读取已提交状态且重复请求不产生第二次 transition

### Requirement: Hermes general plugin coexistence

Hermes 默认集成 SHALL 使用 general plugin 与 Core 通信，并注册已验证的 pre-LLM、pre-tool、post-tool 和 session-end hooks。它不得替换或修改 Hermes 选择的 external MemoryProvider；Core 不可用时 SHALL 返回明确错误，不得声称状态已保存。该插件不实现模型、工具执行或人工授权。

#### Scenario: Install general plugin
- **WHEN** operator 启用 Hermes general plugin
- **THEN** lifecycle integration 可用且 external MemoryProvider 配置保持不变

#### Scenario: Core is unavailable
- **WHEN** plugin 无法连接 Core
- **THEN** 宿主获得稳定 integration error，proposal/checkpoint 不被伪造为已提交，既有 provider 配置不变

#### Scenario: MemoryProvider mode is requested
- **WHEN** 用户要求由 Taric 替换 Hermes MemoryProvider
- **THEN** 默认 plugin 拒绝该模式并报告不属于本变更的 capability

### Requirement: Adapter management and truthful fallback

Taric SHALL 提供 adapter install/remove/config/health/version 操作，只管理 Taric adapter 文件和配置。健康结果 SHALL 包含 Core connection、contract version、host version/commit、已验证和缺失 capabilities。取消、超时、重载和安装失败 SHALL 使用稳定错误，保留 authority 不变；fallback 只宣称其实际支持的 read/context/proposal/recommendation 能力。

#### Scenario: Remove an adapter
- **WHEN** operator 移除一个 adapter
- **THEN** 只删除该 adapter 的 Taric 配置和文件，不删除 authority 或宿主 provider 配置

#### Scenario: Fallback after native failure
- **WHEN** 原生 hook 不可用但 MCP/CLI 可用
- **THEN** 诊断标记 lifecycle 缺失并允许受限 fallback，不能声称自动 checkpoint 或可靠 resume
