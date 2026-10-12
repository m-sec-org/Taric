# Spec Delta

## MODIFIED Requirements

### Requirement: Evidence references

The system SHALL store evidence metadata and Artifact references. When an authenticated host explicitly selects task-session storage and supplies original textual or binary payload bytes through the Artifact content contract, Taric SHALL persist those bytes in the bound task session and associate their verified byte hash, media metadata, provenance, and content status with the Evidence reference. A host may retain the original externally with `content_status=external`. Claims and findings SHALL retain evidence references and applicable limitations. Taric SHALL not imply that a payload is available when the stored content is missing, corrupt, unauthorized, external, or unresolved.

#### Scenario: Attach host Artifact reference

- **WHEN** a host submits an allowed Artifact reference with source metadata and exact textual or binary payload bytes for an authorized task session
- **THEN** Taric stores the reference, byte-preserving content manifest, and session association and makes the Evidence available with an integrity-checked content status

#### Scenario: Artifact content is unavailable

- **WHEN** a host Artifact reference is external, cannot be resolved, the payload is missing or corrupt, or the caller lacks content permission
- **THEN** Taric preserves the reference and limitation metadata but does not represent the Artifact payload as available evidence

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

