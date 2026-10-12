# Spec Delta

## MODIFIED Requirements

### Requirement: Versioned Core service operations

The system SHALL expose JSON Schema request/response/error contracts for the existing Phase 1 operations plus authenticated `artifact.session.bind`, `artifact.store.begin`, `artifact.store.append`, `artifact.store.commit`, `artifact.metadata`, `artifact.content.read`, `artifact.content.list`, and `artifact.session.output` operations. These operations SHALL store or resolve exact original textual or binary payload bytes and task-session execution metadata by reference/summary under the active Engagement and task-session binding. `artifact.store.begin` SHALL declare payload kind/media metadata and expected bytes; `artifact.store.append` SHALL accept one ordered bounded byte chunk per request, with JSON/RPC/CLI base64 treated only as transport encoding, and return the next ordinal; uncommitted uploads SHALL be invisible to reads and lists. `artifact.content.list` and `artifact.session.output` SHALL accept a keyset cursor and page size bound to principal, session, filter, pinned read sequence, catalog watermark, and page size; they SHALL return bounded pages and `next_cursor`. `artifact.content.read` SHALL accept a bounded byte range or chunk cursor and return a bounded byte envelope with media metadata, `next_cursor`, full hash, `max_response_bytes`, and integrity status. `artifact.content.list` and `artifact.session.output` SHALL be metadata/execution-only unless an authorized host or operator explicitly sets `include_content=true`; content remains bounded and resumable. `artifact.content.read` is always an explicit raw-content operation. Every operation must use shared validation, authorization, integrity, idempotency, fencing, and audit checks and return structured success or error responses. Raw content operations are not model-facing tools. Existing deferred operations remain unsupported and no operation may produce partial writes.

#### Scenario: Call a supported operation

- **WHEN** a client sends a valid request with a supported contract version
- **THEN** the service executes the documented operation and returns its structured response

#### Scenario: Call a supported Artifact operation

- **WHEN** an authenticated host or operator sends a valid Artifact operation for an authorized Engagement and task session
- **THEN** the Core service returns the documented bounded page/chunk, continuation cursor, watermark, `max_response_bytes`, media metadata, explicitly requested content, or correlated session output response

#### Scenario: Call an unsupported operation version

- **WHEN** a client sends an unsupported contract version, malformed content request, or missing session binding
- **THEN** the service rejects it with a structured error and makes no state change or readable file

#### Scenario: Call a deferred operation

- **WHEN** a caller requests a resource patch/impact operation, unsupported adapter management, or multi-host backend outside this change
- **THEN** the service returns `unsupported_capability` and does not expose Artifact bodies, internal paths, or authority changes

### Requirement: Separate model, host, and operator privileges

The system SHALL expose separate model-facing, authenticated host-adapter, and operator API capabilities. Each request SHALL be authorized from a transport-verified principal and Taric engagement/task-session permissions; callers SHALL NOT grant themselves a role by setting request fields. Model-facing operations SHALL NOT expose canonical writes, direct store access, host-only checkpoints, raw Artifact content, arbitrary file/database paths, credentials, or target-tool execution. Authenticated host/operator operations MAY store, associate, read, and output opaque Artifact content only through explicit scoped content capability and bounded byte operations. Taric SHALL NOT create or manage the host's human identity or HITL approval system.

#### Scenario: Model client requests proposal submission

- **WHEN** a model client calls a proposal operation
- **THEN** Taric stores only an untrusted proposal and does not modify canonical memory

#### Scenario: Model client requests host-only operation

- **WHEN** a model client requests canonical commit, checkpoint commit, action authorization, direct store access, or raw Artifact content
- **THEN** Taric rejects the operation and preserves canonical and file state

#### Scenario: Host client commits a checkpoint

- **WHEN** an authenticated host adapter presents the active WorkRun lease and valid fencing generation
- **THEN** Taric accepts the checkpoint request subject to schema, task-session, and Artifact reference validation

#### Scenario: Host client reads content

- **WHEN** an authenticated host adapter presents a permitted Engagement, task-session reference, Artifact reference, and bounded range or chunk cursor
- **THEN** Taric returns the integrity-checked bounded content envelope subject to scope and audit checks

#### Scenario: Caller self-asserts a privileged role

- **WHEN** a request body claims operator, reviewer, host-adapter, or content permission without a matching transport-verified capability
- **THEN** Taric denies the request before reading or changing protected Artifact data

#### Scenario: Principal lacks engagement permission

- **WHEN** a valid principal requests an Artifact or task session outside its Taric permission set
- **THEN** Taric returns a stable authorization error without disclosing whether protected records, files, or paths exist

### Requirement: Provide an executable operator CLI

The system SHALL provide CLI commands that call the same Core contracts for `artifact session-bind`, `artifact store begin/append/commit`, `artifact metadata`, `artifact content-read`, `artifact content-list`, and `artifact session-output`, in addition to the existing inventory. CLI content commands SHALL require an authorized host/operator context, accept references or typed summary filters rather than arbitrary paths, accept binary input through a bounded stream or transport envelope, require page/cursor or bounded range arguments for potentially large results, keep list/session-output metadata-only unless `--include-content` is explicitly supplied by an authorized caller, emit structured envelopes with cursors and watermarks, and exit nonzero on validation, authorization, integrity, stale-generation, unavailable-content, or index-lag errors. The CLI SHALL not expose raw content through the model-facing MCP command inventory.

#### Scenario: Run an operator command

- **WHEN** an operator invokes a supported CLI command with valid arguments
- **THEN** the CLI calls the corresponding versioned Core operation and prints its structured result

#### Scenario: Run an Artifact CLI command

- **WHEN** an operator invokes a supported Artifact command with a valid session, reference, and bounded page/range arguments
- **THEN** the CLI calls the corresponding versioned Core operation and prints the structured metadata/content/output result

#### Scenario: Run a command with invalid arguments

- **WHEN** an operator invokes a content command with an arbitrary path, cross-session reference, or invalid body
- **THEN** the CLI prints a clear error and exits nonzero without a partial write or path disclosure

### Requirement: Provide an MCP server

The system SHALL provide the existing MCP stdio transport and route model-facing read, context, proposal, checkpoint-propose, and action-recommend tools through the model capability boundary. `tools/list` MUST NOT include raw Artifact content, task-session sidecar, arbitrary path, or host/operator Artifact operations. Any Artifact data returned by MCP SHALL be limited to opaque content references, safe typed payload metadata, hashes, provenance, and integrity metadata; host/session-relative locators and untrusted summaries remain excluded unless explicitly model-allowlisted. Protocol JSON SHALL remain on stdout and diagnostics SHALL use stderr.

#### Scenario: MCP read tool returns data

- **WHEN** an authorized MCP client queries an engagement containing stored Artifacts
- **THEN** the response contains only allowlisted Artifact references and metadata and no raw payload bytes

#### Scenario: MCP read tool returns metadata

- **WHEN** an authorized MCP client queries an engagement
- **THEN** the response contains only fields allowed for model-facing output

#### Scenario: MCP client attempts an operator or host operation

- **WHEN** an MCP client invokes an Artifact content read, session output, or operator operation
- **THEN** the server rejects it without exposing privileged operations or changing canonical/file state

#### Scenario: MCP client attempts an Artifact host operation

- **WHEN** an MCP client invokes an Artifact content read, session output with content, or operator operation
- **THEN** the server rejects it without exposing privileged operations or changing canonical/file state

#### Scenario: MCP process starts cleanly

- **WHEN** a client starts the MCP process and sends initialize followed by tools/list
- **THEN** the process returns valid protocol responses and lists only the metadata-safe model-facing tools

