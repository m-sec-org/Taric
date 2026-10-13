# Spec Delta

## MODIFIED Requirements

### Requirement: Generate allowlisted Markdown projections

The system SHALL continue to generate Brief and Index projections from committed authority using explicit field allowlists. These derived projections MUST exclude raw Artifact payloads and task-session execution sidecars, even when Taric stores them, while allowing opaque Artifact references, safe typed metadata, hashes, provenance, integrity status, and catalog/index watermarks. Host/session locators are not projection fields. Projection generation SHALL read Artifact metadata from the catalog and MUST NOT scan raw payload chunks or wait for a full 100 GiB content traversal. L0 and unrequested L1 candidates SHALL remain excluded from ordinary facts; explicit candidate views must mark trust, provenance, and limitations. Complete generations must contain manifest hash, authority sequence, projected watermark, and file hashes; publication must atomically switch current and retain reader-pinned old generations. Raw Artifact payload files and Markdown sidecars are a separate task-session source store and SHALL only be served through explicit authorized content operations, never treated as the canonical projection.

#### Scenario: Generate a projection

- **WHEN** an authority generation is committed and its task session contains original Artifact Markdown
- **THEN** Taric publishes a complete Brief/Index using allowlisted references and metadata without copying raw Artifact or execution-sidecar bodies

#### Scenario: A field is not allowlisted

- **WHEN** a stored Artifact or execution record field has not been approved for projection
- **THEN** that field is omitted from Markdown, Context Pack, and model-facing output while the source content remains available only through authorized content APIs

#### Scenario: Project metadata for an Artifact held in session storage

- **WHEN** the authority catalog contains an Artifact whose original payload is in a task-session spool
- **THEN** Taric MAY project only allowlisted opaque reference and safe metadata; it does not traverse, read, or copy the raw payload or Markdown sidecar

#### Scenario: Read during projection switch

- **WHEN** a client reads during generation publication
- **THEN** it sees one complete old or new derived generation with a matching manifest and never a partially generated raw or projected file

### Requirement: Control projection sharing

The system SHALL enforce Taric Engagement and task-session permissions when serving derived Markdown projections or explicit raw Artifact content. Derived projection files SHALL remain non-canonical views, while task-session Artifact payloads and Markdown metadata sidecars SHALL remain content storage associated with authority metadata. Requests SHALL identify a principal, Engagement, session, and reference or summary filter, never an arbitrary filesystem path or caller-asserted permission boolean.

#### Scenario: Read projection without engagement permission

- **WHEN** a principal lacks access to an Engagement or task-session Artifact
- **THEN** Taric denies the read without returning projection, content, generation, or path metadata

#### Scenario: Read another projection path

- **WHEN** a client supplies a path outside the registered task session or derived generation for the requested reference
- **THEN** Taric denies the request without reading that file

