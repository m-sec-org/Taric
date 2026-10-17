# Spec Delta

## MODIFIED Requirements

### Requirement: Portable multi-host backup and recovery

PostgreSQL backup/restore SHALL remain an internal operator disaster-recovery and isolated backend-conformance capability, with schema version, source authority sequence, integrity metadata, Engagement identity, provenance, and revision information. Internal restore MUST validate the temporary target before switching; failure MUST NOT partially modify the destination and SHALL report recovered sequence, backup timestamp, verification, and unresolved errors. These internal guarantees MUST NOT expose a supported public snapshot import, host-state migration, or general event replay operation. Public service/CLI snapshot import SHALL return `unsupported_capability` before mutation; read-only export MUST NOT be described as a complete backup of Artifact payloads or audit history.

#### Scenario: Valid restore
- **WHEN** an operator restores a compatible backup through isolated internal recovery tooling into an empty or explicitly selected target authority
- **THEN** records, events, sequences, lease policy, and revisions match the backup and the tool reports the recovered sequence without exposing a public host import path

#### Scenario: Invalid restore
- **WHEN** backup integrity, schema, reference, or conflict validation fails
- **THEN** restore fails without destination mutation and reports repair action

#### Scenario: Public import is requested
- **WHEN** an operator or host requests snapshot import through a public service or CLI
- **THEN** Taric returns `unsupported_capability` and does not invoke internal restore or alter destination state
