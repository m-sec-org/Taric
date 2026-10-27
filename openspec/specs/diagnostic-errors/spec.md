# diagnostic-errors Specification

## Purpose

Provide actionable, machine-readable diagnostics for rejected requests and authority startup failures while preserving Taric's fail-closed behavior and preventing submitted secrets or server-only details from crossing remote transport boundaries.

## Requirements

### Requirement: Validation failures expose bounded structured diagnostics
The system SHALL include bounded structured diagnostic details for contract validation failures at Core API, CLI, and RPC boundaries, including the contract name and one or more safe schema violations with a field path, keyword, and message or expected constraint.

#### Scenario: Required contract field is missing
- **WHEN** a caller submits a request or candidate that omits a required field
- **THEN** the failure envelope identifies the contract and the missing field path without requiring the caller to inspect the bundled schema

#### Scenario: Complex schema validation fails
- **WHEN** a value violates multiple schema branches or constraints
- **THEN** the failure includes a bounded list of normalized violations and does not include raw submitted values, credentials, or unbounded validator output

#### Scenario: Valid request behavior is unchanged
- **WHEN** a request satisfies its operation and domain contracts
- **THEN** the operation uses the existing authorization, version, idempotency, and state-transition behavior

### Requirement: Authority incompatibility failures identify the compatibility boundary
The system SHALL report a stable startup or storage compatibility error with the selected backend, expected schema/storage versions, observed versions when available, and the incompatible marker or field; absolute local paths SHALL be restricted to local operator diagnostics.

#### Scenario: SQLite authority has an incompatible persisted format
- **WHEN** the selected SQLite authority contains an unsupported schema, storage format, or proposal identity layout
- **THEN** startup fails before writes and the local diagnostic identifies the expected and observed compatibility information

#### Scenario: Shared authority is incompatible or not ready
- **WHEN** a PostgreSQL authority fails schema, fencing, activation-evidence, or availability checks
- **THEN** startup or dispatch returns the existing stable failure code with safe backend and readiness details and never opens a SQLite fallback

#### Scenario: Remote client receives a compatibility failure
- **WHEN** the same failure is returned through a network gateway
- **THEN** the response omits server filesystem paths, connection credentials, raw SQL, and submitted secret values
