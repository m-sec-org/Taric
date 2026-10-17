# Spec Delta

## ADDED Requirements

### Requirement: Authenticate a Node host proxy without widening model privileges

非 Node 宿主通过 Node proxy 接入时，proxy SHALL 使用 transport 注入的、经验证的 principal 和 Engagement 绑定调用同一个 Core service。请求体中的 role、host_id、trust、capabilities 或 evidence 字段 MUST NOT 改写 transport 身份或授予 host、writer、reviewer 或 operator 权限。代理 SHALL 返回 Core 的结构化业务结果和错误，不复制 authority、admission、review 或 fencing 逻辑。

#### Scenario: Model payload claims host authority
- **WHEN** a model-facing bridge sends a request containing host or writer fields
- **THEN** Core authorizes only the transport-verified model principal, rejects host-only operations, and leaves authority unchanged

#### Scenario: Bun host uses the Node proxy
- **WHEN** a supported non-Node host submits a proposal and receives a Core response through the authenticated proxy
- **THEN** the response preserves pending/L1/L2 state, idempotency, stale-generation errors, and Engagement isolation from the direct Node path

#### Scenario: Proxy is restarted
- **WHEN** the proxy process restarts while the authority remains available
- **THEN** a new authenticated connection can read committed state and retry an idempotent request without creating a second transition

### Requirement: Identify custom adapters without granting authority

Taric SHALL accept format-validated custom adapter identifiers and record framework package, distribution, version, and commit separately. Identity registration and capability negotiation MUST NOT grant principal permissions, certify a host release, or bypass authentication. Status and published support documents SHALL use the same composition rules; quality-release evidence pending MUST remain separate from technical capability availability.

#### Scenario: Custom adapter declares privileged capabilities
- **WHEN** a custom adapter registers a valid identifier and self-declares writer or reviewer capability
- **THEN** its identifier is retained but operation permissions come only from the authenticated principal and native certification is not inferred

#### Scenario: Only quality evidence is missing
- **WHEN** technical capability evidence is valid but representative independent quality evidence is pending
- **THEN** status keeps the tested technical result and reports the quality-release claim blocked rather than treating all capabilities as unavailable

## MODIFIED Requirements

### Requirement: Authenticated adapter transport and capability evidence

Native adapters MUST call the shared Taric contract through an authenticated, Engagement-scoped Core transport. The compatibility manifest SHALL bind host version/commit, Taric contract version, the capabilities actually exposed by the pinned host API, fallback operations, stable errors, and test evidence. Core SHALL validate the transport principal and Engagement before dispatch; run-scoped Core operations SHALL continue to enforce Attempt and lease fencing. Adapters MUST NOT expose authority stores or database handles. Adapter status SHALL distinguish implementation, runtime, authorization, evidence, and quality-release state, and SHALL list only capabilities whose required hook, authenticated binding, backend readiness, and matching package/version/commit evidence are present. An unknown host version or self-declared capability MUST remain unsupported or pending and MUST NOT silently simulate a missing hook.

#### Scenario: Adapter connects with verified capabilities
- **WHEN** a pinned adapter connects through the scoped transport
- **THEN** Core diagnostics report its contract and only the tested host capabilities are advertised

#### Scenario: Unknown host release connects
- **WHEN** a host version or commit is absent from the manifest
- **THEN** the adapter reports `unsupported_capability`, exposes no native capabilities, and lists only actual MCP/CLI fallback operations

#### Scenario: Adapter requests another Engagement
- **WHEN** an authenticated adapter dispatches a request outside its principal's Engagement
- **THEN** Core returns `authorization_error` without changing authority state

#### Scenario: Hook is not bound
- **WHEN** a descriptor declares checkpoint support but the current host binding lacks a valid run callback
- **THEN** status reports checkpoint unavailable and the adapter does not expose it as an enabled capability

#### Scenario: Evidence is for another build
- **WHEN** stored evidence has a different implementation, schema, policy, package, or commit digest
- **THEN** runtime status is blocked/disabled and no historical report is used as current activation evidence

#### Scenario: Generic protocol remains available
- **WHEN** an unknown native host version calls a documented generic Core operation through an authenticated transport
- **THEN** the operation is evaluated by its generic contract while native hooks remain unsupported
