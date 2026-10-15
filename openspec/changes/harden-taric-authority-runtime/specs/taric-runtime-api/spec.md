# Spec Delta

## ADDED Requirements

### Requirement: Unified authority startup resolution
CLI、MCP 和其他 Phase 1 runtime entrypoints SHALL use one authority resolver for backend profile, SQLite path, content root, principal context, and deployment diagnostics. The single-host default SHALL select a persistent SQLite authority; `:memory:` is permitted only for tests or explicit configuration. An explicitly selected multi-host profile SHALL fail closed with a stable blocked/unavailable diagnostic before opening SQLite when its shared service is unavailable, and SHALL never fall back to an independent SQLite copy. Startup diagnostics MAY use stderr but initialize responses SHALL not disclose local filesystem paths.

#### Scenario: Start CLI and MCP with the same configuration
- **WHEN** CLI and MCP receive the same environment/configuration
- **THEN** both resolve the same backend profile, authority path, and content root and apply the same startup guard

#### Scenario: Restart the default runtime
- **WHEN** a client writes through the default single-host runtime, exits, and starts it again
- **THEN** the committed authority state remains available from the persistent SQLite path

#### Scenario: Start an unavailable multi-host profile
- **WHEN** an operator selects a multi-host profile whose PostgreSQL service or health contract is unavailable
- **THEN** the entrypoint returns a structured blocked/unavailable error before opening SQLite and does not write authority state

### Requirement: Expose explicit governance phase operations
The versioned runtime API SHALL distinguish proposal submission, deterministic L1 admission, and authorized L2 finding promotion. `admission.evaluate` or equivalent responses MUST declare the resulting trust phase and MUST NOT imply evidence/freshness/independence gates were run when only L1 checks were performed. The registry SHALL expose an explicit `admission.promote_l2` operation for finding promotion; it SHALL require writer/operator authority plus the independent-review inputs, while reviewer identity alone SHALL not grant canonical writer authority. L2 promotion SHALL return stable authorization/validation errors when the caller lacks the required capability.

#### Scenario: Call L1 admission
- **WHEN** an authorized operator submits a structurally valid pending proposal for admission
- **THEN** the response identifies the L1 machine-approved phase, policy/version inputs used, and any remaining L2 requirements

#### Scenario: Call L2 promotion
- **WHEN** an authorized writer submits a finding with a fixed evidence snapshot and independent review
- **THEN** the service performs the L2 hard gates and returns an auditable independently-verified result or a structured rejection

#### Scenario: Model attempts promotion
- **WHEN** a model-facing principal calls an L2 promotion or canonical writer operation
- **THEN** the service denies it before mutation and leaves proposal/canonical state unchanged

### Requirement: Preserve framed adapter requests and stable public errors
The authenticated adapter transport SHALL process every complete newline-delimited request in its input buffer, preserve an incomplete trailing frame, and return one structured response per request. Core errors SHALL carry stable machine-readable codes and sanitized public messages; unknown internal exceptions SHALL map to a generic internal error. Clients and adapters MUST NOT infer error codes from free-form message text.

#### Scenario: Process pipelined adapter requests
- **WHEN** one socket write contains multiple complete JSON requests or a complete request followed by a partial frame
- **THEN** the adapter returns one response for each complete request and processes the partial frame after its remainder arrives

#### Scenario: Hide an unknown internal error
- **WHEN** an operation throws an exception without a declared public error code
- **THEN** the transport returns the stable internal error code and generic message without exposing the exception text
