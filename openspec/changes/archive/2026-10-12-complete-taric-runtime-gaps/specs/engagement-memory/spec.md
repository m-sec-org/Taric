# Spec Delta

## ADDED Requirements

### Requirement: Engagement isolation invariant
所有 authority record、proposal、review、WorkItem、WorkRun、Attempt、Checkpoint、ActionIntent、projection 和 snapshot SHALL 带有且只能属于一个 `engagement_id`。任何引用、查询、写入、恢复、投影和导出都必须先验证 principal 对该 Engagement 的 capability；跨 Engagement 引用、隐式扩 scope、通过 body 自报 Engagement 权限或通过任意路径读取其他 Engagement 都必须拒绝，不得泄漏目标是否存在。

#### Scenario: Cross-engagement mutation
- **WHEN** 一个已授权 principal 提交包含其他 Engagement 引用的 proposal、checkpoint、action 或 patch
- **THEN** 服务返回结构化 engagement-isolation 错误，不写入当前或目标 Engagement

#### Scenario: Cross-engagement read
- **WHEN** principal 没有目标 Engagement 的读取 capability，却请求 query、context、projection 或 snapshot
- **THEN** 服务在读取 protected data 之前拒绝请求，且不返回记录、generation 或路径元数据

#### Scenario: Caller self-asserts engagement ownership
- **WHEN** 请求 body 中的 `engagement_id` 与 transport-verified principal capability 不一致
- **THEN** 服务以 transport 身份为准并拒绝请求，不接受 body 中的自报权限

### Requirement: Canonical identity is writer-owned and immutable
canonical 主键 SHALL 由 Core writer 分配全局 UUIDv7，不接受 caller 指定的 canonical UUID、非 UUIDv7 ID、旧 TYPE-NNN 或 ULID。proposal 可以携带受约束的 proposal/request identity，但不能把它升级为 canonical 主键。已存在实体的 `engagement_id`、kind 和逻辑 identity 字段不可由 update 改写；同一 ID 在不同 Engagement 或 kind 下复用必须拒绝，不能造成 SQL 索引列与 record body 不一致。

#### Scenario: Reuse a canonical ID across engagements
- **WHEN** 一个已存在 canonical ID 被提交到另一个 Engagement 或更换 kind/逻辑 identity
- **THEN** writer 返回 identity conflict，保留原记录及其归属，不写入新 body 或 object reference

#### Scenario: Caller supplies a privileged canonical ID
- **WHEN** model/adapter proposal 尝试把 caller UUID、ULID 或旧格式 ID 作为新 canonical 主键
- **THEN** writer 只保留候选来源关联并自行分配 UUIDv7，或按契约拒绝该字段

## MODIFIED Requirements

### Requirement: Engagement-scoped domain records
The system SHALL represent engagement scope, resources and revisions, observations, typed relations, claims, test hypotheses, work items, evidence references, findings, and coverage state with versioned schemas and globally unique identifiers. PTES phases SHALL be classification and indexing dimensions, not a mandatory linear workflow. Every persisted type SHALL be validated at every write boundary, including required fields, allowed fields, enums, formats, engagement ownership, references, and legal state transitions.

#### Scenario: Create a domain record
- **WHEN** an authorized writer commits a valid proposal for an engagement
- **THEN** the record receives a globally unique identifier, an engagement reference, a committed version, and provenance

#### Scenario: Reject a cross-engagement reference
- **WHEN** a proposal links a record to an object outside its authorized engagement boundary
- **THEN** the system rejects the commit and records the validation result

#### Scenario: Reject an invalid domain record
- **WHEN** a write through any transport omits a required field, uses an invalid value, or references a missing object
- **THEN** the write returns a structured validation error and makes no state change

#### Scenario: Validate protective-control outcome
- **WHEN** an access decision reports that the edge blocked a request before origin access
- **THEN** the origin outcome is recorded as not reached and the coverage cell remains blocked by control

### Requirement: Evidence references
The system SHALL store evidence metadata and references to host-managed Artifacts without requiring Taric to ingest, store, redact, or retain Artifact contents. Claims and findings SHALL retain evidence references and applicable limitations.

#### Scenario: Attach host Artifact reference
- **WHEN** a host submits an allowed Artifact reference with source metadata and optional hash/location
- **THEN** Taric stores the reference and associates it with the Observation, Claim, or Finding

#### Scenario: Artifact content is unavailable
- **WHEN** a host Artifact reference cannot be resolved by the host
- **THEN** Taric preserves the reference state and does not represent the Artifact content as available evidence

### Requirement: Trust-aware retrieval
The system SHALL distinguish proposals, machine-reviewed candidates, and independently verified records in queries and Context Packs. Proposals SHALL be excluded from ordinary recall; machine-reviewed candidates SHALL only appear when explicitly requested as candidate leads. Model-facing reads SHALL apply field allowlists and engagement permissions before returning any record.

#### Scenario: Retrieve candidate leads
- **WHEN** a worker explicitly requests candidate leads for a task
- **THEN** results identify their trust level, provenance, evidence state, and limitations

#### Scenario: Ordinary context retrieval
- **WHEN** a worker requests ordinary engagement context
- **THEN** L0 proposals and unrequested L1 candidates are omitted

#### Scenario: Reject cross-engagement read
- **WHEN** a principal requests context or records for an engagement without read permission
- **THEN** the service denies the request without returning record metadata

### Requirement: Budgeted context packs
系统 SHALL 基于固定 authority `read_seq` 构建一致的 Context Pack，分配不可变 `context_snapshot_id`，声明预算单位及使用量（token 或 character）、adapter/builder/schema/policy 版本、Engagement/WorkItem/Attempt、worker role 和 risk budget。manifest 至少包含每条来源的 ID/hash/time/revision、可共享 Evidence 的 byte/line/HTTP request locator、host-authorized slice 元数据和访问限制。pack 须包含 Engagement 状态摘要、已知相关 stale/conflict 标记和 coverage gaps；选择顺序必须优先 scope/ROE、任务目标与验收、最近已提交 checkpoint，再选相关实体/证据和背景摘要。强制约束无法容纳时返回结构化 minimum-budget 错误；省略项须记录范围及 `unexamined`。续页 cursor 绑定 principal、Engagement、过滤条件、read_seq、稳定排序和预算，不能跨 Engagement 或换序列使用，也不能跳过或重复记录。

#### Scenario: Context exceeds budget
- **WHEN** relevant context exceeds the requested budget
- **THEN** the pack preserves mandatory scope and task constraints, marks omitted material as unexamined, and returns a continuation cursor

#### Scenario: Read a consistent snapshot
- **WHEN** records change while a Context Pack is being assembled
- **THEN** every item in that pack reflects the same pinned read sequence

#### Scenario: Continue a context query
- **WHEN** client 提交与 principal、Engagement、过滤条件和固定 read_seq 匹配的有效 continuation cursor
- **THEN** 服务返回稳定排序的下一页，不产生遗漏或重复；失效、篡改或跨 Engagement cursor 返回结构化错误

### Requirement: Coverage and negative observations
The system SHALL record bounded positive and negative observations with method, conditions, identity, time, evidence references, and limitations. Coverage cells SHALL distinguish untested, tested without observation, positive, inconclusive, blocked, blocked by control, and not applicable states. Coverage SHALL identify the applicable resource revision, test category, identity, operation, and test conditions.

#### Scenario: Record a negative observation
- **WHEN** a test does not reproduce a claim under stated conditions
- **THEN** the result is stored as a bounded negative observation and does not assert that the issue is universally absent

#### Scenario: Test blocked before reaching origin
- **WHEN** a protective control blocks a test before the origin is reached
- **THEN** coverage remains blocked-by-control and does not close origin-level coverage

#### Scenario: Preserve coverage dimensions
- **WHEN** a test result applies to one identity, operation, or condition
- **THEN** Taric updates only matching coverage cells and leaves other dimensions open

## ADDED Requirements

### Requirement: Preserve protective-control and access semantics
Phase 1 SHALL provide the minimum protective-control contract: a ControlObservation and an AccessDecisionObservation must record Engagement/resource reference, operation, principal or auth metadata when available, network condition when available, evidence references, limitations, observed response layer, `origin_reached`, and the applicable control reference or explicit unknown. Control outcome (`observed|suspected|not_observed|inconclusive`) SHALL remain distinct from access decision (`allow|deny|challenge|filtered|unknown`). Unknown layers must not be attributed to a specific WAF/RASP/control; `origin_reached=true` requires supporting evidence. An edge/network block before origin SHALL create `blocked_by_control` coverage and SHALL NOT close origin coverage. Fingerprints alone produce only a suspected control observation.

#### Scenario: Unknown decision layer
- **WHEN** evidence cannot identify the response layer
- **THEN** Taric records unknown or inconclusive attribution and does not claim a specific WAF/RASP or origin outcome

#### Scenario: Claim origin was reached
- **WHEN** a proposal sets origin reached to true without supporting evidence references
- **THEN** the service rejects the inconsistent proposal

### Requirement: Apply minimum memory lifecycle rules in recall
本期 SHALL 支持带归属事件的 `stale`、`supersede`、`retract` 和 `archive` canonical transition。retracted/superseded/archived 不进入普通当前 recall；已过 `expires_at` 的动态观察保留历史并以 stale/谨慎、低权重线索返回，不能冒充当前事实。授权 as-of 查询可追踪原状态。摘要必须保留 source IDs、time、hash、applicability 和 limitations，不能替代 Evidence。review-after 调度、依赖驱动失效和大 impact queue 归入 `evolve-engagement-memory`。

#### Scenario: Retract a remembered claim
- **WHEN** an authorized transition retracts a claim
- **THEN** current recall omits it and an authorized as-of query can still retrieve the earlier version and retraction event

#### Scenario: Dynamic observation expires
- **WHEN** an observation passes its configured review or expiry time
- **THEN** current context identifies its applicability as stale instead of presenting it as current fact

## Follow-up Boundary

`evolve-engagement-memory` 将承接 ResourceRevision/variant、PatchSet 三方合并、Conflict/ImpactEvent、依赖传播、完整控制 revision/applicability、攻击路径图、resume delta 和复杂关系历史。本变更只要求 Phase 1 的最小 schema、隔离、固定上下文、负面结果边界和 blocked-by-control gate。
