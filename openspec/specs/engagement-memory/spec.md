# engagement-memory Specification

## Purpose
Defines Taric's host-independent engagement memory, evidence-reference, retrieval, and context-pack behavior for long-running penetration tests.

## Requirements

### Requirement: Engagement-scoped domain records
The system SHALL represent engagement scope, resources and revisions, observations, typed relations, claims, test hypotheses, work items, evidence references, findings, and coverage state with versioned schemas and globally unique identifiers. PTES phases SHALL be classification and indexing dimensions, not a mandatory linear workflow. Every persisted type SHALL be validated at every write boundary, including required fields, allowed fields, enums, formats, engagement ownership, references, and legal state transitions. Proposal submission SHALL validate its envelope and candidate domain shape before creating a pending row; a legal proposal that is incomplete only because evidence or review is not yet available MAY remain explicitly pending/quarantined.

#### Scenario: Create a domain record
- **WHEN** an authorized writer commits a valid proposal for an engagement
- **THEN** the record receives a Core-assigned globally unique UUIDv7, an engagement reference, a committed version, and provenance

#### Scenario: Reject a cross-engagement reference
- **WHEN** a proposal links a record to an object outside its authorized engagement boundary
- **THEN** the system rejects the commit and records the validation result without changing proposal or canonical state

#### Scenario: Reject an invalid domain record
- **WHEN** a write through any transport omits a required field, uses an invalid value, has an inconsistent subject type/kind, or references a missing object
- **THEN** the write returns a structured validation error and makes no state change

#### Scenario: Validate protective-control outcome
- **WHEN** an access decision reports that the edge blocked a request before origin access
- **THEN** the origin outcome is recorded as not reached and the coverage cell remains blocked by control

#### Scenario: Preserve an evidence-incomplete proposal
- **WHEN** a structurally valid candidate awaits evidence, review, or an asynchronously produced reference
- **THEN** the system stores it only as an explicit pending/quarantine proposal and does not treat it as canonical or admitted

### Requirement: Evidence references

The system SHALL store evidence metadata and Artifact references. When an authenticated host explicitly selects task-session storage and supplies original textual or binary payload bytes through the Artifact content contract, Taric SHALL persist those bytes in the bound task session and associate their verified byte hash, media metadata, provenance, and content status with the Evidence reference. A host may retain the original externally with `content_status=external`. Claims and findings SHALL retain evidence references and applicable limitations. Taric SHALL not imply that a payload is available when the stored content is missing, corrupt, unauthorized, external, or unresolved.

#### Scenario: Attach an external Artifact reference

- **WHEN** a host submits an allowed Artifact reference with source metadata and optional host reference/hash
- **THEN** Taric stores the reference and associates it with the Observation, Claim, or Finding without fetching external content

#### Scenario: Store an Artifact in a bound task session

- **WHEN** an authenticated host opts into storage and uploads exact textual or binary bytes to a registered task session
- **THEN** Taric stores immutable payload chunks outside the authority database, verifies the byte count and SHA-256, and associates the resulting opaque content reference and metadata with the Evidence

#### Scenario: Attach host Artifact reference

- **WHEN** a host submits an allowed Artifact reference with source metadata and exact textual or binary payload bytes for an authorized task session
- **THEN** Taric stores the reference, byte-preserving content manifest, and session association and makes the Evidence available with an integrity-checked content status

#### Scenario: Artifact content is unavailable

- **WHEN** a host Artifact reference is external, cannot be resolved, the payload is missing or corrupt, or the caller lacks content permission
- **THEN** Taric preserves the reference and limitation metadata but does not represent the Artifact payload as available evidence

#### Scenario: Reject an unavailable or corrupt spool payload

- **WHEN** a stored manifest or payload chunk is missing, unreadable, or fails its recorded hash check
- **THEN** Taric returns a structured unavailable or integrity error and does not silently recreate content or claim it is available

### Requirement: Trust-aware retrieval

The system SHALL distinguish proposals, machine-reviewed candidates, and independently verified records in queries and Context Packs. Proposals SHALL be excluded from ordinary recall; machine-reviewed candidates SHALL only appear when explicitly requested as candidate leads. Model-facing reads SHALL apply field allowlists and engagement permissions before returning any record, and SHALL return opaque Artifact references, safe typed metadata, hashes, provenance, and integrity status without raw Artifact payload or task-session sidecar content.

#### Scenario: Retrieve candidate leads

- **WHEN** a worker explicitly requests candidate leads for a task
- **THEN** results identify their trust level, provenance, evidence state, limitations, and associated Artifact metadata without exposing raw content

#### Scenario: Ordinary context retrieval

- **WHEN** a worker requests ordinary engagement context for a task with stored Artifacts
- **THEN** L0 proposals and unrequested L1 candidates are omitted and visible Artifact data is limited to allowlisted references and metadata

#### Scenario: Reject cross-engagement read

- **WHEN** a principal requests context or records for an engagement without read permission
- **THEN** the service denies the request without returning record, Artifact, path, or content metadata

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
canonical 主键 SHALL 由 Core writer 分配全局 UUIDv7，不接受 caller 指定的 canonical UUID、非 UUIDv7 ID、旧 TYPE-NNN 或 ULID。proposal 可以携带受约束的 proposal_id 或 client_request_id，但不能把它升级为 canonical 主键。已存在实体的 `engagement_id`、kind 和逻辑 identity 字段不可由 update 改写；更新必须使用独立的 `target_id`/`subject_ref`、Engagement 和 expected version，由 Core 校验目标类型与归属。同一 ID 在不同 Engagement 或 kind 下复用必须拒绝，不能造成索引列与 record body 不一致。

#### Scenario: Reuse a canonical ID across engagements
- **WHEN** an existing canonical ID is submitted to another Engagement or with a changed kind/identity
- **THEN** the writer returns an identity conflict and preserves the original record and ownership

#### Scenario: Caller supplies a privileged canonical ID
- **WHEN** a model or adapter proposal attempts to promote a caller UUID, ULID, or legacy ID to a new canonical primary key
- **THEN** the writer rejects the privileged field or stores it only as a constrained source/request reference

#### Scenario: Assign identity for a new record
- **WHEN** a proposal creates a new canonical entity with a caller-supplied id or no id
- **THEN** Core ignores or rejects that canonical id, allocates a UUIDv7, and retains any accepted request identity only as proposal metadata

#### Scenario: Update an existing record
- **WHEN** a proposal updates an existing entity
- **THEN** it names a separate target reference and expected version, and Core rejects a missing, cross-engagement, wrong-kind, or stale target without changing the entity

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
