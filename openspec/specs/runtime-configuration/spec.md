# runtime-configuration Specification

## Purpose

Make gateway authority selection explicit and reproducible for daemon and container deployments, while retaining a documented compatibility path for existing environment and workspace configuration without merging unrelated configuration sources.

## Requirements

### Requirement: Gateway runtime configuration is independently selectable
The gateway SHALL accept an explicit authority/runtime configuration source distinct from the listener and token configuration, and an explicit source SHALL be authoritative for that gateway startup.

#### Scenario: Gateway starts with an explicit runtime configuration
- **WHEN** the operator supplies a valid runtime configuration path alongside the gateway listener configuration
- **THEN** the gateway opens the authority and content root selected by that path and does not consult workspace or home-directory runtime configuration files

#### Scenario: Explicit runtime configuration is missing or invalid
- **WHEN** the supplied runtime configuration path does not exist, is invalid JSON, or fails authority validation
- **THEN** startup fails with a structured configuration error before any listener accepts requests

#### Scenario: Existing deployment omits the explicit source
- **WHEN** no explicit runtime configuration source is supplied
- **THEN** the gateway follows the published environment/workspace/home precedence without merging files and reports which source was selected

### Requirement: Runtime configuration provenance is observable and safe
The gateway SHALL expose the selected configuration source, authority profile, content-root mode, and non-secret precedence decisions in local startup diagnostics or authenticated status output; it SHALL NOT expose database credentials, bearer tokens, or unredacted connection strings.

#### Scenario: Operator diagnoses an unexpected authority
- **WHEN** the gateway starts or an operator queries its authenticated status
- **THEN** the diagnostic identifies whether the runtime source came from an explicit path, environment, workspace, or home configuration and identifies the selected backend without exposing secrets

#### Scenario: Configuration precedence conflicts
- **WHEN** environment and file configuration provide different values
- **THEN** the gateway applies the documented precedence deterministically and reports the winning source or override category
