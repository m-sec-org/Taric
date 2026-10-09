# Spec Delta

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
The system SHALL build a consistent Context Pack against a fixed authority sequence and declared token/character budget. Packs SHALL identify included sources, omitted or truncated ranges, and a continuation cursor where applicable. The system SHALL prioritize scope, rules, task acceptance criteria, and latest checkpoint before optional context. A continuation request SHALL use the same pinned sequence and SHALL not skip or duplicate entries.

#### Scenario: Context exceeds budget
- **WHEN** relevant context exceeds the requested budget
- **THEN** the pack preserves mandatory scope and task constraints, marks omitted material as unexamined, and returns a continuation cursor

#### Scenario: Read a consistent snapshot
- **WHEN** records change while a Context Pack is being assembled
- **THEN** every item in that pack reflects the same pinned read sequence

#### Scenario: Continue a context query
- **WHEN** a client submits a valid continuation cursor
- **THEN** the service returns the next page at the same `read_seq` without gaps or duplicates

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

### Requirement: Complete versioned domain contracts
The system SHALL define versioned contracts for TestHypothesis, ResourceRevision, typed Relation revisions, PatchSet, conflict records, ImpactEvent, AttackPath, non-secret authentication metadata and session revisions, ProtectiveControl and its revisions, ControlObservation, and AccessDecisionObservation. Each contract SHALL specify required fields, provenance, scope, version/time applicability, legal states, and typed references. Observations SHALL remain immutable; changed interpretation SHALL be expressed through new revisions or applicability events.

#### Scenario: Persist a documented domain type
- **WHEN** a client submits any documented domain type through a supported write path
- **THEN** the service applies its complete contract and validates engagement ownership, reference kinds, provenance, and state before persistence

#### Scenario: Change an observation's interpretation
- **WHEN** later evidence changes the interpretation of an existing observation
- **THEN** Taric preserves the historical observation and records a new revision or applicability event instead of rewriting it

### Requirement: Revise resources and merge bounded patches
The system SHALL keep stable logical Resource identities and immutable revisions, including resource variants for method, path, parameters/content type, principal/tenant, and content hash where applicable. Typed relations SHALL carry version, source observations, validity, and dependency criticality. PatchSets SHALL declare base generation, per-object base versions, and read/write sets. Non-overlapping narrative or field edits and relation additions SHALL merge deterministically; conflicting fields, deletions, mutually exclusive relations, scope, and status changes SHALL require explicit conflict resolution or CAS and SHALL NOT use silent last-write-wins.

#### Scenario: Observe changed bundle content
- **WHEN** a resource is observed with a different content hash
- **THEN** Taric creates a new revision while preserving the logical identity, prior revisions, and their source relationships

#### Scenario: Merge non-overlapping edits
- **WHEN** two valid patches change distinct narrative ranges or independent fields from the same base
- **THEN** Taric merges them without losing either change and records the base, diff, and merge result

#### Scenario: Retain conflicting evidence
- **WHEN** patches modify the same factual field or a mutually exclusive relation
- **THEN** Taric preserves both candidate values and source evidence in a conflict record and does not silently choose a winner

### Requirement: Propagate dependency impact
The system SHALL compute impact along explicit dependencies when source revisions, claims, controls, or access observations change. It SHALL record ImpactEvents and prioritized review/revalidation work for affected claims, hypotheses, WorkItems, coverage, checkpoint applicability, Context Packs, findings, AttackPaths, and report references. Critical premise withdrawal SHALL suspend dependent verified findings from ordinary high-trust recall and new reports pending review. Historical observations/checkpoints/host decisions SHALL remain unchanged. Ordinary unrelated descriptions SHALL NOT invalidate the entire engagement.

#### Scenario: Withdraw a critical finding premise
- **WHEN** a critical evidence or claim dependency is retracted or contradicted
- **THEN** Taric marks dependent finding applicability and unexecuted action recommendations stale, queues revalidation, and returns the change to the host at its next safe coordination boundary

#### Scenario: Change an unrelated description
- **WHEN** a noncritical narrative field changes
- **THEN** only actual dependent current views are invalidated and unrelated findings remain usable

#### Scenario: Process a large dependency graph
- **WHEN** impact exceeds one processing batch
- **THEN** Taric exposes pending impact work and continuation state without claiming all dependent views are current

### Requirement: Preserve protective-control and access semantics
Control observations SHALL bind the applicable control revision or explicit unknown value, policy snapshot, resource revision, authentication/session revision, operation, network conditions, evidence, and limitations. ControlObservation outcomes SHALL remain distinct from AccessDecisionObservation decisions. Unknown layers SHALL NOT be attributed to a specific control; confirmed origin access SHALL require evidence. Fingerprints alone SHALL produce suspected control claims, not verified control configuration or complete coverage.

#### Scenario: Unknown decision layer
- **WHEN** evidence cannot identify the response layer
- **THEN** Taric records unknown or inconclusive attribution and does not claim a specific WAF/RASP or origin outcome

#### Scenario: Claim origin was reached
- **WHEN** a proposal sets origin reached to true without supporting evidence references
- **THEN** the service rejects the inconsistent proposal

#### Scenario: Control policy changes
- **WHEN** a control revision or access-policy premise changes
- **THEN** Taric appends a revision/applicability event, preserves prior observations, and marks only affected current negative claims and coverage for revalidation

### Requirement: Apply memory lifecycle rules in recall
The system SHALL support review-after, expiry, supersede, retract, and archive transitions with attributable events. Expired or dependency-stale items SHALL be identified as stale. Retracted, superseded, or archived records SHALL be excluded from ordinary current recall while remaining accessible to authorized historical queries. A summary SHALL retain source IDs, times, hashes, and applicability and SHALL NOT replace evidence.

#### Scenario: Retract a remembered claim
- **WHEN** an authorized transition retracts a claim
- **THEN** current recall omits it and an authorized as-of query can still retrieve the earlier version and retraction event

#### Scenario: Dynamic observation expires
- **WHEN** an observation passes its configured review or expiry time
- **THEN** current context identifies its applicability as stale instead of presenting it as current fact
