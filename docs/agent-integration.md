# Taric Runtime Integration

Taric adds durable Engagement memory, governed candidates/Findings, execution recovery metadata and optional opaque Artifact storage. The host provides model calls, worker scheduling, target tools, identity, approval, credentials and content policy. Taric does not execute a target action or grant authorization.

## Supported Profile

| Surface | Implemented behavior | Deployment boundary |
|---|---|---|
| SQLite authority | Persistent single-host default, WAL and shared Core governance | CLI/MCP/proxy can open the same local file; SQLite coordinates separate processes. Do not put the file on shared multi-host storage. |
| Operator CLI (`cli.operator`) | JSON operations, stderr failures, explicit process principal | Run only inside the trusted host/operator boundary. Default role is operator, not a model credential. |
| Model MCP (`mcp.stdio_model_tools`) | stdio `2024-11-05`, exactly six tools | No admission, host-state, raw content, resources subscription, Tasks or HTTP listener. |
| Node proxy | `taric proxy`, one fixed host principal and Engagement, authenticated Unix socket | Bun can call the local socket or embed Core with the Bun SQLite driver below; this proxy itself exposes no remote HTTP/TCP server. |
| Optional network gateway | `taric gateway --config <path>`, TLS TCP JSON-RPC and HTTPS `/rpc` | Separate from `taric proxy`; fixed token-to-principal mapping, bounded 1 MiB requests, and no filesystem path ingestion from remote hosts. See [configuration and behavior](#optional-remote-gateway). |
| Pi (`pi_native_adapter`) | Pinned `@earendil-works/pi-coding-agent` 1.4.0 / `4a08025` | Native capability depends on per-instance registration, tool support and run callbacks/binding. |
| Pi lifecycle (`pi.session_lifecycle`) | `session_start`, shutdown observer | Static support does not establish live instance health. |
| Pi Context (`pi.context_injection`) | `context` and `before_agent_start` map to Context Pack injection | Returns different host message shapes for the two hooks. |
| Pi workflow (`pi.proposal_checkpoint_action_result_hooks`) | Bound proposal tool, checkpoint/action/result/error paths | Pi has no native events named proposal/checkpoint/action/result/error; see concrete hook mapping below. |
| DeepSeek (`deepseek_native_adapter`) | DSH `0.2.0-rc.2` / `639ed01`, Cordis `4.0.4`; session lifecycle only | No native Context/checkpoint/action/result bridge; use the appropriate model or trusted host entrypoint. |
| Hermes (`hermes_native_adapter`) | `0.19.0` / `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`; general plugin | Context/session/tool observation, no MemoryProvider replacement or automatic proposal/checkpoint/result capture. |
| PostgreSQL (`storage.postgresql`) | Same async Core governance, runtime conformance and live readiness | Disabled by default; explicit profile + matching evidence + deployed health/fencing enable it. |
| Artifact (`artifact.task_session_content`) | Opt-in bound session spool and explicit original-content reads | host/operator content_read is a separate grant; PG does not replicate payload files. |
| Relation/impact (`graph.relation_impact`) | Versioned revision, typed edges, three-way patch, bounded impact | Revalidation WorkItems do not start workers. |
| Git/scanner (`git.remote_push`, `secrets.external_scanner`) | Engagement-authorized projection callbacks with real scan/push evidence | Not public remote.push operations; remote push requires a private repository, access control and retention policy. |
| Quality (`quality.full_statistical_evaluation`) | Statistical algorithms implemented | Human annotation/baseline provenance is pending; capability remains unsupported and disabled until current pinned release evidence is complete. |
| Public snapshot import/migration | `snapshot.import` is deferred; no public migration operation | Backend restore is an operator recovery path, not a host migration API. |

Host rows pin package/distribution versions and contracts tested by Taric. On 2026-10-26, Pi/DeepSeek adapter and gateway contract suites passed, Hermes plugin tests passed (5), and the Bun SQLite driver suite passed (11). A separate smoke installed Pi 1.4.0 outside the workspace, started its actual RPC process, and loaded the Taric extension through Pi's `ExtensionAPI`; it registered `session_start`/`context` callbacks and the proposal tool. The smoke did not call a model or execute a tool. DeepSeek Harness and Hermes host runtimes were not installed, and a complete Pi workflow or host health is not certified. `adapter.status` reports instance registration and runtime health as `not_observed` because it cannot inspect another process.

## Adoption paths and host contract

Adopt a dependency-complete path. Adding fewer features does not relax the identity, isolation or governance of the features you use.

| Path | Initialize | Callers and operations | Host work and resulting trust |
|---|---|---|---|
| A: read existing memory | Operator initializes Engagement/scope; bind each reader principal to it | model MCP context.query/resource.query/evidence.query; trusted host uses Core query | Host selects scope, consumes pagination/omissions; existing authorized memory only. |
| B: candidates | A + real observation/evidence capture, coverage tracking and admission client | model proposal.submit; host capture.observation/coverage.record; writer/operator admission.evaluate, or host with explicit admit grant | Submit→pending L0; admission→L1 if accepted. Host must inspect both outer ok and data.ok, and keep candidates distinct from verified facts. |
| C: verified Finding | B + pinned evidence/input/policy and separate reviewers | reviewer review.submit; writer/operator admission.promote_l2 | Host separates reviewers, attests identities and obtains approvals; Core gates L2. A default host cannot promote. |
| D: run recovery | A + WorkItem, current owner/Attempt/generation and lease | host work.claim/renew/reclaim/transition/resume, checkpoint.commit, action host operations | Host schedules/stops tools, maintains leases, validates checkpoint and reconciles unknown actions. Taric returns blocked/replan_required when premises fail. |
| E: original content | Explicit durable content root/ACL and session binding; run-bound mode adds D | host/operator artifact.session.bind and store.begin/append/commit; explicit content_read for bytes | Host captures, scans/redacts, retains, backs up and safely serves payloads. Model views remain references and bounded metadata. |

For real governed Finding wiring, the executable [trusted Node fixture](../packages/core/test/trusted-node-governance.test.mjs) uses separate operator/host/model/reviewer/writer principals through public dispatch. It covers Resource→Observation→Evidence→Claim→Finding, L1, independent review and L2; its tool output/reviews are synthetic. It is not external host or human-review certification.

### Principal setup and capability grants

Create principals only in trusted code after authenticating the actual client:

```js
import { createPrincipal } from "@taric/core";

const host = createPrincipal("host", "bridge-host", engagementId);
const writer = createPrincipal("writer", "memory-writer", engagementId);
const contentReader = createPrincipal("host", "evidence-reader", engagementId, ["content_read"]);
// Grant admit only if this specific host is trusted to perform structural admission.
const admittingHost = createPrincipal("host", "admission-host", engagementId, ["admit"]);
```

Default host grants are read/propose/work/checkpoint/action/content; default writer grants add admit/writer, and operator grants add audit/operator/content. Neither host nor operator receives content_read by default. Operation roles still apply: an operator cannot invoke host-only work.claim/checkpoint.commit, and a writer is not an independent reviewer. The proxy exposes only its fixed default host principal; it is not a route to operator/reviewer/writer or arbitrary additional grants.

Ordinary record query forces L2 for model principals; host/operator may explicitly select candidates. Context uses its own candidate/safety/mandatory projection rules. resource.query/evidence.query share generic query implementation and do not automatically select a kind; pass kind when needed. Do not pass an operator export to a model as if it were a Context Pack.

### Persisted session fencing and host responsibility

Two configurations are supported:

| Session choice | Binding procedure | Guarantees |
|---|---|---|
| host-session | Bind mode host-session with no run tuple | Engagement/session isolation and integrity; no promise of lease fencing from this mode. |
| run-bound | Claim a current run, then bind session with work_run_id, attempt_id, generation, owner_host equal to the authenticated host ID | Persisted run association; subsequent Artifact upload/publication recovery rechecks current fence. |

For a run-bound proxy, set TARIC_SESSION_ID before starting it. work.claim takes task_session_ref from that trusted registration; after claim returns run/Attempt, bind the same session using the full tuple before host proposal/capture/checkpoint/action attachments. These calls require matching work_run_id/generation and any supplied content Attempt references. Body session fields cannot select a different task session. An unbound host cannot attach to a run that already has a task-session association.

Existing root/mode/run bindings cannot be silently rewritten. After reclaim, do not downgrade or reuse the old run-bound binding as a new generation: establish an authorized current session/proxy route and retain old-attempt output attribution. Original-attempt late proposals are quarantined. Hosts own the mapping from real workers to authenticated transports; Taric cannot verify hidden routing inside a shared host process.

TARIC_SESSION_ID is consumed by taric proxy only. Ordinary CLI/MCP startup does not register it. For session-bound in-process host calls, pass transportSessionId as createPrincipal's sixth argument; never trust a model-supplied session ID.

## Local Setup

Use a Node version providing node:sqlite (the saved process run used 22.21.1), then from the repository root:

```sh
npm ci
npm run build
node packages/cli/dist/bin.js --help
```

A minimal persistent authority can be initialized with:

```sh
export TARIC_DB="$PWD/.taric/authority.sqlite"
export TARIC_CONTENT_ROOT="$PWD/.taric/content"
node packages/cli/dist/bin.js engagement.init '{"name":"local-demo","scope":{"allowed_targets":["https://example.test"],"excluded_targets":[],"rules_of_engagement_ref":"roe:local-demo"}}'
```

Use the returned data.id as TARIC_ENGAGEMENT_ID. The [API synthetic example](taric-api.md#executable-synthetic-example) runs L0→L1 plus an Artifact round-trip in a fresh temporary persistent authority and checks each business result.

### Node proxy and Bun client

In the trusted host process, configure an existing Engagement and a private socket directory:

```sh
export TARIC_CORE_SOCKET="$PWD/.taric/host.sock"
export TARIC_ENGAGEMENT_ID='<returned Engagement UUIDv7>'
export TARIC_PRINCIPAL_ID='bridge-host'
# Set TARIC_ADAPTER_TOKEN to a host-managed secret of at least 32 characters.
node packages/cli/dist/bin.js proxy
```

The proxy runs until SIGINT/SIGTERM, fixes role host regardless of TARIC_PRINCIPAL_ROLE, opens the configured authority and creates a 0600 Unix socket. It prints a startup line; that stdout is not a CLI-operation JSON response or MCP stream. JSON requests use taric.dispatch with params token/operation/request; [the API](taric-api.md#node-adapter-proxy) specifies framing/errors.

Mount the socket only into the trusted bridge. Keep authority/content-root mounts and token out of model workers. A model process must not control TARIC_CONFIG or privileged CLI environment. Use [the Bun smoke client](../scripts/adapter-rpc-bun-client.mjs) or [the real restart harness](../scripts/benchmark-proxy-restart.mjs) for the supported local topology. The saved [proxy v5 report](benchmarks/proxy-restart-v5.json) records Node 22.21.1/Bun 1.3.13, 26 calls, two restarts, actual socket modes, idempotency/CAS and late-result checks; it does not certify a complete third-party host. `taric proxy` remains local Unix-socket only. The optional `taric gateway` also supports TLS TCP and HTTPS as described below.

### Optional remote gateway

Use the multi-principal gateway when a host must call Taric without receiving PostgreSQL credentials or network access. It does not replace PostgreSQL coordination: remote hosts still reach the same Core authority through the gateway, and PostgreSQL remains responsible for multi-host transactions, lease ordering, and fencing. Direct host-to-PostgreSQL Core remains the simpler topology when every host is trusted to access that service.

The gateway config may enable the Unix socket, TLS TCP, HTTPS, or more than one listener. TLS certificate and private key paths are resolved relative to the gateway config file. Network endpoints require an explicit bind host and port; plaintext listeners are not available. Keep the config/key files operator-readable only and bind/firewall the service to trusted networks.

```json
{
  "tls_tcp": { "host": "10.20.0.10", "port": 7443, "max_connections": 128 },
  "https": { "host": "10.20.0.10", "port": 7444, "path": "/rpc", "max_connections": 128, "max_concurrent_requests": 64, "request_timeout_ms": 30000 },
  "tls": { "key_file": "gateway-key.pem", "cert_file": "gateway-cert.pem" },
  "tokens": [
    { "token": "replace-with-a-random-secret-of-at-least-32-characters", "role": "host", "principal_id": "host-a", "engagement_id": "<engagement-id>" }
  ]
}
```

Configure `TARIC_CONFIG` and, for PostgreSQL-backed deployments, `TARIC_RUNTIME_CONFORMANCE` in the trusted gateway service environment, then start `taric gateway --config /secure/path/gateway.json`. The listener accepts TLS 1.2/1.3 only. Token entries are loaded at startup and bind to fixed role/principal/Engagement/session identities; do not send identity fields to select another principal. Rotate or revoke a token by updating the protected config and restarting the gateway, which closes existing connections. No forwarded identity headers are trusted.

TLS TCP clients use the existing newline-delimited JSON-RPC protocol: send `taric.identify` first with `{token, declare:{role, principal_id, engagement_id}}`, then use `taric.dispatch` with that token. Identity is frozen per connection. TCP supports connection-bound `taric.subscribe`; reconnecting clients must resume from the last authoritative read sequence because notifications are best-effort hints.

HTTPS accepts one JSON-RPC object per `POST /rpc`, `Content-Type: application/json`, with `Authorization: Bearer <token>`. The body shape is the existing `taric.dispatch` request; the bearer token determines the fixed principal, and the body contains only `operation` and `request` under `params`. JSON-RPC batches, other paths/methods/content types, CORS, and subscription methods are rejected. HTTPS does not stream notifications; after reconnect, query authoritative state using the last `read_seq`. Request and response JSON are each capped at 1 MiB; the gateway bounds concurrent requests, connections, and request time.

Artifact paths always refer to the gateway host. Network `artifact.session.bind` ignores any client-supplied root and derives a gateway-local session root under the configured `content_root`; `artifact.ingest_file` is unsupported remotely because its path would name a gateway-host file. Remote clients may use bounded `artifact.store.begin`/`append`/`commit` frames or an opaque external reference. A client that needs large files should use an external Artifact store or a host-local Core/spool topology; this gateway does not expose the separate binary Artifact socket over the network.

When more than one gateway process fronts the same PostgreSQL authority, all replicas must use the same shared content root (or a shared filesystem) and a routing policy that keeps a session reachable by every replica. A local root per replica can persist a path that another replica cannot read; use one gateway, shared storage, or sticky routing instead.

The loopback TLS TCP and HTTPS end-to-end tests are part of `packages/cli/test/gateway.test.mjs`. They verify token identity, Engagement isolation, TLS-only TCP, HTTPS request bounds, local-path rejection, gateway-managed spool binding, and bounded Artifact transfer. This is transport conformance on one machine, not a production-network availability or credential-rotation certification.

### Model MCP setup

Give each model process the selected authority configuration plus explicit TARIC_PRINCIPAL_ID and TARIC_ENGAGEMENT_ID, then start:

```sh
node packages/mcp/dist/bin.js
```

Do not run that command in the proxy's socket stream. MCP is a separate stdio transport, not a client of TARIC_CORE_SOCKET. Its process opens the configured authority through openRuntimeService; stdio startup forces model role and createMcpServer reconstructs read/propose grants. TARIC_PRINCIPAL_ROLE/content_read settings cannot expose host tools through MCP.

The resolver defaults ID to operator-local unless a model role/ID was explicitly selected, even though stdio later forces role model; set the model ID explicitly to avoid misleading attribution. The server only supports six tools and no resource subscriptions. See [tool-specific field differences](taric-api.md#model-facing-operations); Core-only scan budgets, reviewer metadata or generation fields cannot be assumed available in a tool schema.

## Bun in-process embedding

Profile selection, artifact packaging, API `1.2.0` pairing, and host/operator ownership boundaries are summarized in [host integration profiles](host-integration-profiles.md).

A Bun host embeds the authority in-process over the driver contract instead of proxying to a Node process. Bun has no `node:sqlite` builtin, so import the reference driver package and construct the store directly:

```ts
import { AuthorityStore, createCoreService } from "@taric/core";
import { BunSqliteAuthorityDriver } from "@taric/driver-bun-sqlite";
const store = new AuthorityStore(new BunSqliteAuthorityDriver(dbPath));
const service = await createCoreService(store, contentRoot);
```

`openRuntimeService`'s sqlite path constructs the node:sqlite driver itself; Bun hosts use the direct construction above. Core loads `node:sqlite` lazily, so the full `@taric/core` import works under Bun. On Bun 1.3.13, `npm test --workspace @taric/driver-bun-sqlite` passes 11 tests across the conformance, embedding-smoke and driver-specific suites. The saved [bun-driver-conformance-v1 report](benchmarks/bun-driver-conformance-v1.json) records the 12 authority runtime scenarios; that report does not contain the other 10 test results. This is repository-level driver evidence, not certification of a third-party Bun host or a power-loss durability guarantee. See the [driver guide](authority-driver-guide.md). The Node bridge proxy is an alternative topology.

## Runtime Configuration

Config discovery selects the first existing JSON file from TARIC_CONFIG, `<cwd>/.taric/config.json`, `~/.taric/config.json`, without merging. A missing explicit path does not stop the search. An invalid selected file fails startup.

| Setting | Resolution and behavior |
|---|---|
| authority | `config.authority` wins as a whole; otherwise TARIC_AUTHORITY_PROFILE plus TARIC_DATABASE_URL/TARIC_HOST_ID/TARIC_LEASE_MODE construct it. A connection URL alone does not select PG. |
| db_path | TARIC_DB → config.db_path → authority.sqlite.path → ~/.taric/authority.sqlite. The fallback :memory: in the library resolver is not an implicit process memory request. |
| content_root | TARIC_CONTENT_ROOT → config.content_root → content beside dbPath. Explicit memory uses a new temporary root. For PG, explicitly configure a durable per-host root. |
| principal role/ID/Engagement | Environment → matching config fields → entrypoint defaults. CLI defaults operator/operator-local; proxy fixes host; MCP stdio forces model but uses resolver ID. |
| content_read_enabled | Enabled if TARIC_CONTENT_READ_ENABLED is exactly true **or** config.content_read_enabled is true; setting environment false does not revoke config true. Applies to CLI; default proxy does not add it and MCP reconstructs its grants. |
| runtime_conformance_path | TARIC_RUNTIME_CONFORMANCE → config.runtime_conformance_path; missing/mismatched PG evidence blocks activation. |
| adapter config | TARIC_ADAPTER_CONFIG → ~/.taric/adapters.json; separate from runtime config. |
| transport session | TARIC_SESSION_ID only configures the proxy's host session; use explicit principal registration in embedded code. |
| proxy socket/token | TARIC_CORE_SOCKET and TARIC_ADAPTER_TOKEN, token ≥32 characters. |

Example `.taric/config.json`:

```json
{
  "db_path":"/absolute/path/authority.sqlite",
  "content_root":"/absolute/path/content",
  "principal_role":"operator",
  "principal_id":"local-operator",
  "content_read_enabled":false
}
```

Set multi-host configuration either as a complete config.authority object or through environment with no competing config.authority:

```sh
export TARIC_AUTHORITY_PROFILE=multi_host_authority
export TARIC_DATABASE_URL='postgresql://<service-user>:<secret>@<authority-host>:5432/<database>'
export TARIC_HOST_ID='<stable-host-id>'
export TARIC_LEASE_MODE=server_side
export TARIC_RUNTIME_CONFORMANCE='/secure/path/current-activation-report.json'
export TARIC_CONTENT_ROOT='/secure/path/content/<stable-host-id>'
```

Apply schema before startup, generate current live conformance evidence in isolation, verify deployed schema/leases and inspect startup/readiness. Rebuild/schema/policy changes require matching fresh evidence. CLI/MCP/proxy do not regenerate reports, migrate schema at startup or create SQLite fallback. A runtime failure remains blocked until health/evidence recover. See [local PG deployment](postgres-local-deployment.md), [readiness](postgres-runtime-readiness.md) and [multi-host runbook](multi-host-authority-runbook.md).

## Native adapter setup

### Pi

Static descriptor support is pinned to Pi 1.4.0/4a08025. `createPiExtension` is the simple factory and calls registration without a PiRuntimeBinding; for checkpoint/action/result capabilities, create an adapter and pass actual host callbacks/run facts to register:

```js
import { createPiAdapter } from "@taric/core";

const adapter = createPiAdapter(service, sessionBoundHostPrincipal);
const registered = await adapter.register(piExtensionApi, {
  work_run_id: currentRunId,
  generation: currentGeneration,
  agent_id: currentAgentId,
  checkpoint: buildSanitizedCheckpoint,
  recommendationForTool: mapToolRecommendation,
  resultForTool: mapActualHostResult,
});
const status = adapter.status();
```

These variables are supplied by trusted host code; run binding must match authority lease and any persisted transport session. Callbacks must return complete sanitized contracts; registering a callback is not evidence of a real tool result.

| Pi host surface | Taric behavior/instance requirement |
|---|---|
| session_start | engagement.status; session_lifecycle available after registration |
| context / before_agent_start | context.build, with conversation messages or injected message respectively |
| registerTool:taric_proposal | proposal submission, only when ExtensionAPI.registerTool exists |
| agent_before_settle | checkpoint.commit only with checkpoint callback and valid UUIDv7 run/generation/agent binding; error outcome calls error.report |
| tool_call + taric_action_recommend | Registered only with registerTool + recommendationForTool + valid run binding; advisory recommendation, not authorization |
| tool_result | resultForTool + valid binding → action.host-result; errors → error.report |
| session_shutdown | Lifecycle no-op; does not cancel external work |

The callbacks report uses stable Taric lifecycle vocabulary; hooks reports concrete Pi hook/tool registration. Same-instance repeated register is idempotent and does not rebind callbacks. Native cancel/reload capability is not enabled by this registration; host cancellation remains host-owned.

### DeepSeek and Hermes

DeepSeek registers exactly session/created, session/event, session/flush, session/disposed. session/created reads status, session/event keeps process-local deduplication/observation, flush/disposed are lifecycle no-ops. It does not automatically turn a tool event into canonical Observation or implement work/checkpoint/action workflows.

Hermes general plugin has pre_llm_call, pre_tool_call, post_tool_call, on_session_start/end/finalize/reset. It injects Context, reads session status and reports tool errors; pre_tool_call is observer-only, and successful results are returned without automatic evidence capture. It never replaces MemoryProvider or directly opens the database. The current Python TaricRpcClient requires TARIC_CORE_SOCKET/token/Engagement and a 3s socket timeout. TARIC_CORE_URL is mentioned in its module comment but is not implemented; there is no HTTP fallback.

Use MCP only for model operations. Missing host work, capture, checkpoint or action result integration requires a trusted Core/CLI/RPC client; the six model tools cannot substitute for those capabilities.

### Custom adapters and status

`createCustomAdapterDescriptor` accepts adapter_id and produces a format-validated host_id string (1–128 characters, no `..` or `//`), separate framework package/distribution/version/commit and declared capabilities. This opens the generic integration identity; it does not certify a new native host or authorize an operation. Unknown native versions/forks remain unsupported. `TaricAdapterClient.call` uses the authenticated service/principal independently of the descriptor's static native support.

`adapter.status` reads configuration for the three built-in hosts, compares version/commit to the manifest, and reports instance_registration_state/runtime_health_state as not_observed. It does not inspect another process's hooks. Live adapter `status()` separates implementation_state, runtime_state, authorization_state, evidence_state, quality_release_state and per-capability status. `service_connected` means a call was attempted, not a continuous health probe. Missing bindings or mock/skipped/failed/mismatched evidence cannot establish the corresponding enabled native support. Quality pending remains separate from technical registration.

`quality.full_statistical_evaluation` remains disabled unless the trusted runtime supplies `TARIC_QUALITY_RELEASE_REPORT` and an independently provisioned `TARIC_QUALITY_RELEASE_REPORT_SHA256` for the exact report bytes. Core checks that pin plus the report's implementation, schema and policy digests before changing only the quality entry in `capability.status`; absent, stale, failed or incomplete evidence stays disabled. The release verifier uses the current Core implementation digest for this binding. Keep the report pin in deployment-controlled configuration and update it only with the reviewed release artifact.

`taric adapter install/remove/config` only edits built-in adapter entries in the local config file; it does not install framework packages or hooks. health reports local configuration/Core contact, and version reports contracts. Arbitrary adapter IDs are not accepted by these management commands.

## P1a operation boundary

| Entry | Actual permission/transport | Result and size boundary |
|---|---|---|
| Context/record reads | Six-tool MCP subset or scoped trusted client | Bounded selected metadata; ordinary host RPC 1 MiB line bound. Context helper scanBudget is not a tool/CLI option. |
| Capture/proposal/admission | Host capture/proposal; admission needs admit capability | pending or accepted L1; default host/proxy cannot admit. |
| WorkRun/coverage writes | Host `work.transition` binds identity to its principal and fences on generation/lease; host/operator `coverage.record` uses principal authorization and record-version CAS | Atomic audited WorkRun/Attempt transition or idempotent L1 coverage-cell create/CAS update; coverage cells are not run-bound, and MCP does not expose these host writes. |
| Review/L2 | Independently authenticated reviewer and writer/operator | Pinned review/provenance and L2 gate; separate from model credentials. |
| Artifact metadata/upload | host/operator content capability | 64 MiB decoded chunk contract applies to Core, CLI file stream or separately started binary listener; ordinary JSON-RPC cannot carry that base64 envelope. |
| Original content read | Separate content_read grant | Direct read is always explicit raw access; list/output require include_content. RPC raw response ≤512 KiB, list/output ≤16 items, content-page total ≤128 KiB. |

The separate listener `listenArtifactBinaryRpc` requires a trusted Engagement host and is not launched by taric proxy. It accepts a bounded JSON header plus exact raw bytes with two active uploads and a 2×64 KiB queue per upload. CLI append-file uses a local path only in the trusted process, hashes once and streams again; no arbitrary path field is added to public Artifact requests.

## Boundaries

Artifact bodies, retention, and redaction remain host-controlled boundaries. Roots are explicit mode-bound sessions inside configured contentRoot, immutable after binding. Opaque bytes may contain credentials; Taric does not parse, scan, redact or manage them. Content storage is not credential lifecycle management. Model MCP never gains raw access from the host transport.

Native chunks are files under artifacts/YYYY/MM/DD/<id-prefix>/<artifact-id>/vNNNNNN, with content.manifest.json and metadata.md; per-version NDJSON entries are date/ID sharded. Authority persists bindings/upload/catalog/publication state. Restart revalidates publication integrity and run fence before availability; local_process_crash performs no explicit fsync and is not a power-loss guarantee. PG shares metadata only; route original-byte requests to the owning spool and coordinate database/content/key backups.

Context and authority list cursors bind an authority/root key, but use different v2 AES-GCM/v1 HMAC formats; Artifact catalog cursors are scoped keyset metadata, not Context snapshots. work.resume still materializes session Artifact metadata. Full export and audit remain scale-dependent; do not assume Context optimization bounds every operation.

Projection output uses explicit field allowlists and L2 filtering, with local Git checkpoints enabled by default. Remote push requires a private repository, access and retention configuration, Engagement authorization, a real secrets-scan result, and a push callback. Its scanner only handles projected files, not task-session payloads. snapshot.export is an operator inspection path and can contain selected L0/recalled canonical metadata; it is not ordinary model context. Public `snapshot.import` remains deferred.

## Host state polling and maintenance

host.state is host/operator-only, limit 1–1000 (default 100), with per-category completeness, scoped opaque watermark and read_time. It reports bounded L1/Conflict/Impact/unknown-action/expired-lease/freshness aggregates. Freshness scans only a limited sample, so incomplete totals are lower bounds; no continuation or reliable events are provided. Time expiry can change a poll without a commit. Use [the abortable polling example](taric-api.md#host-state-polling); reconnect failed service handles and keep retry delay within the deployment's chosen budget.

Core in-process and authenticated adapter RPC expose optional bounded host subscriptions with `read_seq`-based polling/query recovery; signals are best-effort hints, not a persistent event stream. MCP resource subscriptions remain disabled. The [recorded local polling fixture](benchmarks/host-state-poll-v1.json) met its 1000ms budget, so a host should opt into notifications only when its measured polling cost or discovery budget requires them. That result does not establish a network/production SLA or mean arbitrary backoff settings meet the same budget.

Operator audit.verify/audit.doctor and reconcile preview are observation paths. `audit.reconcile {}` consumes outbox and reconciles Artifact state; omission of action is not read-only. Explicit replay/rebuild/reconcile select repairs. See [single-host maintenance](authority-storage-runbook.md). Public migration/import is unsupported: historical materials enter through normal proposal/evidence governance, while database recovery uses an isolated operator-managed restore and matching spool.

## Support Consistency Rules

| Public statement | Source and evidence rule |
|---|---|
| Supported operation | Registry presence **and** Core role/capability checks; helper methods and CLI-local commands are different surfaces. |
| Supported native host | Fixed package/distribution/version/commit evidence ceiling, not a capability declaration or install entry. |
| Enabled adapter instance | Concrete registration, callback/tool/run bindings and authenticated principal; Core adapter.status cannot observe other processes. |
| Enabled PG deployment | Current compiled/schema/policy report plus deployed schema/lease health; static supported/evidence flags do not activate it. |
| Release quality | Human representative annotation/baseline evidence separate from technical unit/contract/process tests. |
| Raw-byte support | State the entrypoint's framing/size/grants; generic 1 MiB host RPC is not a 64 MiB upload service. |

`release-support.test.mjs` checks manifest/documentation/status consistency; it does not certify a real external host, its live health, or production quality. Actual behavior takes precedence over historical proposal/task wording; known surface differences above must be retained when integrating.

## Fit and measured evidence

Use Taric when durable scoped memory, governed Findings, lease-aware recovery or original evidence references are needed. It is a poor fit for a one-off scan with no governed memory requirement, or a team unable to operate the independent review/host boundary it selects. Agent count alone does not establish fit.

Record actual integration effort, failed attempts, Core calls, reviewer waits, retries, proxy restarts, CPU/RSS/latency, fixture/version and commands. The proxy report supplies synthetic local calls/timing, not engineering labor-hours, production reviewer time or ROI. Host observations can still be false, discovery incomplete and external action outcomes unknown; Taric checks its state/identity/governance contracts rather than proving target-system truth.

The saved [clean-build report](benchmarks/capability-verification-v2.json) records an older baseline and is not current build evidence; run `scripts/verify-release.mjs` for the selected tree. [PostgreSQL v2](benchmarks/postgres-runtime-v2.json) records historical runtime scenarios. The current [quality release change](../openspec/changes/harden-taric-authority-runtime/) records the digest-bound evidence contract. Human annotation/baseline evidence remains pending. Historical 50k Context first-page reduction is 42.5%, below the 50% target, and is not a general 2s SLA.

Archived changes record implementation decisions. They do not automatically enable a runtime, certify a third-party deployment, or remove pending quality gates.
