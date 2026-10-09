# Spec Delta

## MODIFIED Requirements

### Requirement: Generate allowlisted Markdown projections
The system SHALL generate Markdown projections from committed authority state by default. Projections SHALL use an explicit field allowlist and exclude raw Artifact contents, SecretRef, tokens, private paths, unreviewed proposals, and sensitive drafts. L0 and unrequested L1 candidates SHALL NOT appear as ordinary facts in default Brief/Index output; any explicit candidate view SHALL label trust and limitations. Complete generations SHALL include manifest hashes and authority sequence; publication SHALL atomically switch the current generation without deleting a generation still used by readers. Brief and index SHALL expose their distinct documented views, including scope, task/handoff state, typed attack-surface navigation, stale/conflict/coverage gaps, and watermarks.

#### Scenario: Generate a projection
- **WHEN** an authority generation is committed
- **THEN** Taric atomically publishes a complete Markdown generation using only allowlisted fields

#### Scenario: A field is not allowlisted
- **WHEN** a stored field has not been approved for projection
- **THEN** that field is omitted from Markdown and model-facing output

#### Scenario: Read during projection switch
- **WHEN** a client reads during generation publication
- **THEN** it sees one complete old or new generation with a matching manifest

### Requirement: Control projection sharing
The system SHALL enforce Taric engagement permissions when serving or sharing Markdown projections. Projection files SHALL remain derived views and SHALL NOT become the canonical state source. Requests SHALL identify a principal and engagement, not arbitrary filesystem paths or caller-asserted permission booleans.

#### Scenario: Read projection without engagement permission
- **WHEN** a principal lacks access to an engagement projection
- **THEN** Taric denies the read

#### Scenario: Read another projection path
- **WHEN** a client supplies a path outside the requested engagement generation
- **THEN** Taric denies the request without reading that file

### Requirement: Local Git checkpoint by default
The system SHALL create local Git checkpoints by default when Git checkpointing is enabled for the installation. Remote push SHALL require explicit per-engagement enablement and configured private repository access, retention policy, access control, and secret scanning. Git checkpoints SHALL bind the projection manifest and authority sequence. Failure SHALL mark a retryable checkpoint status without undoing authority state.

#### Scenario: Local checkpoint
- **WHEN** a committed authority generation is checkpointed under default settings
- **THEN** the checkpoint remains in the local repository and is not pushed remotely

#### Scenario: Remote push is requested without safeguards
- **WHEN** remote push is requested but any required engagement repository setting is missing
- **THEN** Taric does not push the checkpoint and reports the missing configuration

#### Scenario: Checkpoint or scan fails
- **WHEN** local commit fails or a required secrets scan does not pass
- **THEN** Taric retains the authority generation, records pending or blocked checkpoint status, and does not push remotely
