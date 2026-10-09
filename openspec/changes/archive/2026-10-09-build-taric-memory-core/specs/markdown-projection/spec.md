# Spec Delta

## Purpose

Defines human-readable engagement projections and Git checkpoints that are safe to share through Taric permissions and are not the authority store.

## ADDED Requirements

### Requirement: Generate allowlisted Markdown projections
The system SHALL generate Markdown projections from committed authority state by default. Projections SHALL use an explicit field allowlist and exclude raw Artifact contents, SecretRef, tokens, private paths, unreviewed proposals, and sensitive drafts.

#### Scenario: Generate a projection
- **WHEN** an authority generation is committed
- **THEN** Taric atomically publishes a complete Markdown generation using only allowlisted fields

#### Scenario: A field is not allowlisted
- **WHEN** a stored field has not been approved for projection
- **THEN** that field is omitted from Markdown and model-facing output

### Requirement: Control projection sharing
The system SHALL enforce Taric engagement permissions when serving or sharing Markdown projections. Projection files SHALL remain derived views and SHALL NOT become the canonical state source.

#### Scenario: Read projection without engagement permission
- **WHEN** a principal lacks access to an engagement projection
- **THEN** Taric denies the read

### Requirement: Local Git checkpoint by default
The system SHALL create local Git checkpoints by default when Git checkpointing is enabled for the installation. Remote push SHALL require explicit per-engagement enablement and configured private repository access, retention policy, access control, and secret scanning.

#### Scenario: Local checkpoint
- **WHEN** a committed authority generation is checkpointed under default settings
- **THEN** the checkpoint remains in the local repository and is not pushed remotely

#### Scenario: Remote push is requested without safeguards
- **WHEN** remote push is requested but any required engagement repository setting is missing
- **THEN** Taric does not push the checkpoint and reports the missing configuration
