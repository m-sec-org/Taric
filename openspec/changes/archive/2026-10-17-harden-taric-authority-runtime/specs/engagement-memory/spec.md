# Spec Delta

## MODIFIED Requirements

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

#### Scenario: Preserve an evidence-incomplete proposal
- **WHEN** a structurally valid candidate awaits evidence, review, or an asynchronously produced reference
- **THEN** the system stores it only as an explicit pending/quarantine proposal and does not treat it as canonical or admitted

#### Scenario: Validate protective-control outcome
- **WHEN** an access decision reports that the edge blocked a request before origin access
- **THEN** the origin outcome is recorded as not reached and the coverage cell remains blocked by control

### Requirement: Canonical identity is writer-owned and immutable
canonical 主键 SHALL 由 Core writer 分配全局 UUIDv7，不接受 caller 指定的 canonical UUID、非 UUIDv7 ID、旧 TYPE-NNN 或 ULID。proposal 可以携带受约束的 proposal_id 或 client_request_id，但不能把它升级为 canonical 主键。已存在实体的 `engagement_id`、kind 和逻辑 identity 字段不可由 update 改写；更新必须使用独立的 `target_id`/`subject_ref`、Engagement 和 expected version，由 Core 校验目标类型与归属。同一 ID 在不同 Engagement 或 kind 下复用必须拒绝，不能造成索引列与 record body 不一致。

#### Scenario: Assign identity for a new record
- **WHEN** a proposal creates a new canonical entity with a caller-supplied id or no id
- **THEN** Core ignores or rejects that canonical id, allocates a UUIDv7, and retains any accepted request identity only as proposal metadata

#### Scenario: Update an existing record
- **WHEN** a proposal updates an existing entity
- **THEN** it names a separate target reference and expected version, and Core rejects a missing, cross-engagement, wrong-kind, or stale target without changing the entity

#### Scenario: Reuse a canonical ID across engagements
- **WHEN** an existing canonical ID is submitted to another Engagement or with a changed kind/identity
- **THEN** the writer returns an identity conflict and preserves the original record and ownership

#### Scenario: Caller supplies a privileged canonical ID
- **WHEN** a model or adapter proposal attempts to promote a caller UUID, ULID, or legacy ID to a new canonical primary key
- **THEN** the writer rejects the privileged field or stores it only as a constrained source/request reference
