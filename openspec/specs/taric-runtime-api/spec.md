# taric-runtime-api Specification

## Purpose
定义 Phase 1 单机首发的 versioned Core service、operator CLI、model-facing MCP 和 authenticated Pi adapter API。所有入口共享同一 authority、schema、权限和错误码。Artifact 内容可外置，也可经 host/operator 显式绑定 task session 后写入 opaque spool；未列入本期的高级操作必须返回 unsupported capability。

## Requirements

### Requirement: Versioned Core service operations

The system SHALL expose JSON Schema request/response/error contracts for the existing Phase 1 operations plus authenticated `artifact.session.bind`, `artifact.store.begin`, `artifact.store.append`, `artifact.store.commit`, `artifact.metadata`, `artifact.content.read`, `artifact.content.list`, and `artifact.session.output` operations. These operations SHALL store or resolve exact original textual or binary payload bytes and task-session execution metadata by reference/summary under the active Engagement and task-session binding. `artifact.store.begin` SHALL declare payload kind/media metadata and expected bytes; `artifact.store.append` SHALL accept one ordered bounded byte chunk per request, with JSON/RPC/CLI base64 treated only as transport encoding, and return the next ordinal; uncommitted uploads SHALL be invisible to reads and lists. `artifact.content.list` and `artifact.session.output` SHALL accept a keyset cursor and page size bound to principal, session, filter, pinned read sequence, catalog watermark, and page size; they SHALL return bounded pages and `next_cursor`. `artifact.content.read` SHALL accept a bounded byte range or chunk cursor and return a bounded byte envelope with media metadata, `next_cursor`, full hash, `max_response_bytes`, and integrity status. `artifact.content.list` and `artifact.session.output` SHALL be metadata/execution-only unless an authorized host or operator explicitly sets `include_content=true`; content remains bounded and resumable. `artifact.content.read` is always an explicit raw-content operation. Every operation must use shared validation, authorization, integrity, idempotency, fencing, and audit checks and return structured success or error responses. Raw content operations are not model-facing tools. Existing deferred operations remain unsupported and no operation may produce partial writes.

#### Scenario: Call a supported operation

- **WHEN** a client sends a valid request with a supported contract version
- **THEN** the service executes the documented operation and returns its structured response

#### Scenario: Call a supported Artifact operation

- **WHEN** an authenticated host or operator sends a valid Artifact operation for an authorized Engagement and task session
- **THEN** the Core service returns the documented bounded page/chunk, continuation cursor, watermark, `max_response_bytes`, media metadata, explicitly requested content, or correlated session output response

#### Scenario: Store and read bounded Artifact content

- **WHEN** an authorized host binds a task session, uploads ordered chunks, commits a matching full hash, and requests metadata or a bounded content range
- **THEN** Core returns metadata or at most one bounded native-byte chunk with media metadata, integrity status, and an optional continuation cursor; no request accepts an arbitrary path

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

#### Scenario: Model client requests Artifact bytes

- **WHEN** a model-facing client requests `artifact.content.read`, `include_content=true`, or a task-session path
- **THEN** Taric rejects it without reading or disclosing payload bytes, paths, or existence details

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

### Requirement: Idempotent requests and stable errors
State-changing API operations SHALL accept an idempotency key where retry is possible. The service SHALL map validation, authorization, stale-version, conflict, unavailable-host, and internal errors to stable error codes.

#### Scenario: Retry a committed request
- **WHEN** a client retries the same operation with the same idempotency key and payload
- **THEN** Taric returns the original result and does not create a second transition

#### Scenario: Reuse an idempotency key with another payload
- **WHEN** a client reuses a key with a different payload
- **THEN** Taric returns an idempotency conflict and does not apply the new payload

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

### Requirement: Provide a bounded host state view before optional notifications

Taric SHALL expose an authenticated host/operator state view for one authorized Engagement per bounded request, returning a scope-safe watermark, fixed read time/freshness, L1 pending counts, conflicts/impact, unknown actions, and lease anomalies. Capability/runtime diagnostics SHALL respect the same authorization boundary. The view MUST NOT expose other Engagement existence, raw Artifact bytes, global sequence values, or global event history. Expiry and freshness SHALL be computed at the pinned read time even without a new commit. Periodic polling with retry/backoff SHALL remain correct when notifications are unavailable; incomplete scans MUST be explicit rather than reported as complete counts.

#### Scenario: Host reads its state view
- **WHEN** an authenticated host requests a state view for an authorized Engagement
- **THEN** Taric returns bounded aggregate state and watermarks for that Engagement without raw content or cross-Engagement metadata

#### Scenario: Scope is revoked
- **WHEN** a host loses Engagement or resource permission before a state read
- **THEN** the request returns an authorization error and does not disclose whether the prior view changed

#### Scenario: Polling observes a change
- **WHEN** a host polls after another process commits a change
- **THEN** the next authorized read can observe a later watermark even if no notification was delivered

#### Scenario: Lease expires without a commit
- **WHEN** a lease or freshness threshold expires between polls without any intervening authority commit
- **THEN** the next state read computes the expired status using its fixed read time and does not rely solely on a changed commit sequence

#### Scenario: Model requests the host queue
- **WHEN** a model principal requests the host state view
- **THEN** Taric returns an authorization error and the model tool inventory remains limited to the existing six tools

### Requirement: Keep optional state notifications best-effort

If state notifications are enabled, Taric SHALL treat them as bounded, best-effort, mergeable change hints. Delivery and ordering MUST NOT be required for correctness. Taric SHALL reauthorize subscriptions and reads, scope them to permitted resources, limit subscriptions and queued bytes, and disconnect slow consumers so clients can recover by polling and rereading state. Notifications MUST NOT invoke models, schedule work, or authorize actions.

Notification activation SHALL require measured polling cost or discovery latency to exceed a host budget recorded before measurement. For an MCP host surface, Taric SHALL negotiate a compatible protocol, expose resource discovery/read/subscribe/unsubscribe with stable resource URIs, and emit standard URI-only resource-updated notifications; authorized reads return scoped watermarks. Subscription registration SHALL close the read/subscribe race, cross-process changes SHALL remain detectable without stealing an outbox consumer, and reconnect SHALL reread state before advancing a locally completed range. Unsupported old positions SHALL require a new read, not general event replay.

#### Scenario: Notification is lost or duplicated
- **WHEN** a subscribed host misses or receives duplicate state notifications
- **THEN** polling and an authorized state read recover the current state without requiring event replay

#### Scenario: Subscription loses authorization
- **WHEN** a principal loses Engagement or resource access while subscribed
- **THEN** Taric cancels the affected subscription and sends no further information about that scope

#### Scenario: Subscriber is too slow
- **WHEN** a subscriber exceeds its bounded queue or delivery limit
- **THEN** Taric merges pending change hints or disconnects the subscriber, and polling remains the recovery path

#### Scenario: Polling meets its budget
- **WHEN** measured polling cost and discovery delay satisfy the host's recorded budgets
- **THEN** subscriptions remain disabled and polling is delivered without claiming subscription support

#### Scenario: Commit occurs during subscription registration
- **WHEN** another process commits after the initial read but before subscription registration completes
- **THEN** a watermark recheck or equivalent bounded check exposes the change and the host can recover it through an authorized read

### Requirement: Keep deferred import and replay paths explicitly unsupported

Snapshot import, general event replay, arbitrary Artifact path access, and unverified native transport activation SHALL return `unsupported_capability` or the applicable stable contract error. These responses MUST NOT create fallback SQLite state, partially modify authority, publish content, or reinterpret historical material as a current observation.

#### Scenario: Caller requests snapshot import
- **WHEN** an operator submits a snapshot import request through a public API
- **THEN** Taric returns an unsupported-capability error before mutation and leaves authority, counters, outbox, and projections unchanged

#### Scenario: Caller requests event replay
- **WHEN** a client requests a general replay or arbitrary historical event stream
- **THEN** Taric rejects the operation without exposing internal events or creating a replay cursor

#### Scenario: Multi-host readiness is missing
- **WHEN** an explicitly selected shared backend lacks matching current evidence or health
- **THEN** startup is blocked with a stable diagnostic and does not fall back to SQLite
