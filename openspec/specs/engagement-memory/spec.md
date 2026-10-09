# engagement-memory Specification

## Purpose
Defines Taric's host-independent engagement memory, evidence-reference, retrieval, and context-pack behavior for long-running penetration tests.

## Requirements

### Requirement: Engagement-scoped domain records
The system SHALL represent an engagement's scope, resources and revisions, observations, typed relations, claims, test hypotheses, work items, evidence references, findings, and coverage state with versioned schemas and globally unique identifiers. PTES phases SHALL be classification and indexing dimensions, not a mandatory linear workflow.

#### Scenario: Create a domain record
- **WHEN** an authorized writer commits a valid proposal for an engagement
- **THEN** the record receives a globally unique identifier, an engagement reference, a committed version, and provenance

#### Scenario: Reject a cross-engagement reference
- **WHEN** a proposal links a record to an object outside its authorized engagement boundary
- **THEN** the system rejects the commit and records the validation result

### Requirement: Evidence references
The system SHALL store evidence metadata and references to host-managed Artifacts without requiring Taric to ingest, store, redact, or retain Artifact contents. Claims and findings SHALL retain evidence references and applicable limitations.

#### Scenario: Attach host Artifact reference
- **WHEN** a host submits an allowed Artifact reference with source metadata and optional hash/location
- **THEN** Taric stores the reference and associates it with the Observation, Claim, or Finding

#### Scenario: Artifact content is unavailable
- **WHEN** a host Artifact reference cannot be resolved by the host
- **THEN** Taric preserves the reference state and does not represent the Artifact content as available evidence

### Requirement: Trust-aware retrieval
The system SHALL distinguish proposals, machine-reviewed candidates, and independently verified records in queries and Context Packs. Proposals SHALL be excluded from ordinary recall; machine-reviewed candidates SHALL only appear when explicitly requested as candidate leads.

#### Scenario: Retrieve candidate leads
- **WHEN** a worker explicitly requests candidate leads for a task
- **THEN** results identify their trust level, provenance, evidence state, and limitations

#### Scenario: Ordinary context retrieval
- **WHEN** a worker requests ordinary engagement context
- **THEN** L0 proposals and unrequested L1 candidates are omitted

### Requirement: Budgeted context packs
The system SHALL build a consistent Context Pack against a fixed authority sequence and declared token/character budget. Packs SHALL identify included sources, omitted or truncated ranges, and a continuation cursor where applicable.

#### Scenario: Context exceeds budget
- **WHEN** relevant context exceeds the requested budget
- **THEN** the pack preserves mandatory scope and task constraints, marks omitted material as unexamined, and returns a continuation cursor

#### Scenario: Read a consistent snapshot
- **WHEN** records change while a Context Pack is being assembled
- **THEN** every item in that pack reflects the same pinned read sequence

### Requirement: Coverage and negative observations
The system SHALL record bounded positive and negative observations with method, conditions, identity, time, evidence references, and limitations. Coverage cells SHALL distinguish untested, tested without observation, positive, inconclusive, blocked, blocked by control, and not applicable states.

#### Scenario: Record a negative observation
- **WHEN** a test does not reproduce a claim under stated conditions
- **THEN** the result is stored as a bounded negative observation and does not assert that the issue is universally absent

#### Scenario: Test blocked before reaching origin
- **WHEN** a protective control blocks a test before the origin is reached
- **THEN** coverage remains blocked-by-control and does not close origin-level coverage
