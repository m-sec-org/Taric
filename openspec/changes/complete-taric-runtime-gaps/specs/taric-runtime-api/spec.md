# Spec Delta

## Purpose

Defines executable, versioned access to Taric Core through operator CLI, MCP, and host adapter APIs, with explicit privilege boundaries and stable error behavior.

## ADDED Requirements

### Requirement: Versioned Core service operations
The system SHALL expose JSON Schema request and response contracts for every documented CLI/API operation: engagement init/status, context build, query with `as_of`, capture proposal-only, proposal list, review, admission, control list/observe, access observe, revise/draft/patch/relation/claim/impact, work checkpoint/resume, action recommendation/result, audit verify/reconcile, snapshot export, and adapter list/install/remove/config/health/version. Every operation SHALL use the shared schema validator and return a structured success or error response.

#### Scenario: Call a supported operation
- **WHEN** a client sends a valid request with a supported contract version
- **THEN** the service executes the operation and returns the documented response schema

#### Scenario: Call an unsupported operation version
- **WHEN** a client sends an unsupported contract version or malformed request
- **THEN** the service rejects it with a structured error and makes no state change

### Requirement: Separate model, host, and operator privileges
The system SHALL expose separate model-facing, authenticated host-adapter, and operator API capabilities. Each request SHALL be authorized from a transport-verified principal and Taric engagement permissions; callers SHALL NOT grant themselves a role by setting request fields. Model-facing operations SHALL NOT expose canonical writes, direct store access, host-only checkpoints, credentials, or target-tool execution. Taric SHALL NOT create or manage the host's human identity or HITL approval system.

#### Scenario: Model client requests proposal submission
- **WHEN** a model client calls a proposal operation
- **THEN** Taric stores only an untrusted proposal and does not modify canonical memory

#### Scenario: Model client requests host-only operation
- **WHEN** a model client requests canonical commit, checkpoint commit, action authorization, or direct file/database access
- **THEN** Taric rejects the operation and preserves canonical state

#### Scenario: Host client commits a checkpoint
- **WHEN** an authenticated host adapter presents the active WorkRun lease and valid fencing generation
- **THEN** Taric accepts the checkpoint request subject to schema and reference validation

#### Scenario: Caller self-asserts a privileged role
- **WHEN** a request body claims operator, reviewer, or host-adapter privilege without a matching transport-verified capability
- **THEN** Taric denies the request before reading or changing protected engagement data

#### Scenario: Principal lacks engagement permission
- **WHEN** a valid principal requests an engagement outside its Taric permission set
- **THEN** Taric returns a stable authorization error without disclosing whether protected records exist

### Requirement: Provide an executable operator CLI
The system SHALL provide an executable CLI for every documented operator operation, including init/status, context/query, proposal/review/admission, capture, control/access observation, revise/draft/patch/relation/claim/impact, work/checkpoint/resume, action recommendation, audit verify/reconcile, snapshot export, and adapter management/diagnostics. The CLI SHALL invoke the shared Core service and SHALL NOT implement separate policy logic.

#### Scenario: Run an operator command
- **WHEN** an operator invokes a supported CLI command with valid arguments
- **THEN** the CLI calls the corresponding versioned Core operation and prints its structured result

#### Scenario: Run a command with invalid arguments
- **WHEN** an operator invokes a command with invalid arguments or missing configuration
- **THEN** the CLI prints a clear error and exits nonzero without a partial write

### Requirement: Provide an MCP server
The system SHALL provide an executable MCP stdio transport. It SHALL implement protocol initialization, tools/list, and tools/call for the documented model-facing read, context, proposal, checkpoint-propose, and action-recommend tools. The server SHALL route every tool through the model capability boundary and SHALL return allowlisted results only. Protocol JSON SHALL remain on stdout; diagnostics SHALL use stderr.

#### Scenario: MCP read tool returns data
- **WHEN** an authorized MCP client queries an engagement
- **THEN** the response contains only fields allowed for model-facing output

#### Scenario: MCP client attempts an operator or host operation
- **WHEN** an MCP client invokes an operation outside the model-facing allowlist
- **THEN** the server rejects it without exposing privileged operations or changing canonical state

#### Scenario: MCP process starts cleanly
- **WHEN** a client starts the MCP process and sends initialize followed by tools/list
- **THEN** the process returns valid protocol responses and lists only model-facing tools

### Requirement: Idempotent requests and stable errors
State-changing API operations SHALL accept an idempotency key where retry is possible. The service SHALL map validation, authorization, stale-version, conflict, unavailable-host, and internal errors to stable error codes.

#### Scenario: Retry a committed request
- **WHEN** a client retries the same operation with the same idempotency key and payload
- **THEN** Taric returns the original result and does not create a second transition

#### Scenario: Reuse an idempotency key with another payload
- **WHEN** a client reuses a key with a different payload
- **THEN** Taric returns an idempotency conflict and does not apply the new payload
