# Taric API Boundary v1

> Source review: 2026-10-18. API/Schema `1.0.0`, Adapter `1.0`; package version `0.1.0` is separate. This document describes the current source contract, including differences between Core helpers, public dispatch, CLI, MCP and host RPC.

Core owns authority writes and governance. Hosts own model calls, workers, target tools, action authorization, reviewer identity, credentials, Artifact policy and retention. An accepted proposal/capture is not a verified Finding.

## Runtime startup and authority profiles

`openRuntimeService` is the shared process startup entrypoint. CLI, MCP and the Node proxy use persistent `single_host_sqlite` by default, at `~/.taric/authority.sqlite`; `:memory:` must be selected explicitly. The lower-level `createCoreServiceForPath()` library default remains memory and does not perform process startup checks.

`multi_host_authority` selects PostgreSQL 14–18 and requires a connection string, host ID, `lease_mode=server_side`, current digest-bound activation evidence and healthy deployed schema/lease state. Startup does not migrate PostgreSQL or create conformance fixtures. Failure never opens a fallback SQLite authority. See [configuration precedence](agent-integration.md#runtime-configuration) and [runtime readiness](postgres-runtime-readiness.md).

## Transport and response contract

Use `await service.dispatch(operation, principal, request)` for public calls. `request` must be an object; an optional `contract_version` must equal `1.0.0`. Principals are created by a trusted transport with `createPrincipal` or `registerTransportPrincipal`; object fields alone cannot register a caller. `init()` and `status()` are lower-level service methods without principal parameters, so do not expose the whole service object to untrusted callers.

```json
{"ok":true,"data":{}}
```

```json
{"ok":false,"error":{"code":"authorization_error","message":"principal lacks the required engagement capability"}}
```

An optional `error.follow_up` identifies follow-up work. Core codes are `validation_error`, `authorization_error`, `unsupported_capability`, `unsupported_schema_version`, `idempotency_conflict`, `stale_version`, `conflict`, `unavailable_host`, `invalid_cursor`, `minimum_budget_required`, `internal_error`. Startup diagnostics additionally use `configuration_invalid`, `unsupported_deployment`, `postgresql_unavailable`, `backend_conformance_failed`. JSON-RPC protocol errors are a separate layer.

Check business results as well as the outer envelope: L1 admission can return `ok:true` with `data.ok:false`, retain a rejection audit event and leave canonical state unchanged. MCP `isError` and the CLI exit code reflect the outer `ok`; neither alone proves admission succeeded.

Artifact dispatch requests compile their request schema. Many other registry entries use a generic envelope definition and validate fields inside the method. The registry's request name is not a universal complete input schema; extra-field rejection and idempotency must be checked for each operation.

## Identity and default capabilities

| Role | Default capabilities from `createPrincipal` |
|---|---|
| model | read, propose |
| host | read, propose, work, checkpoint, action, content |
| reviewer | read, review |
| writer | read, propose, admit, writer |
| operator | read, propose, admit, writer, audit, operator, content |

An allowed role must also have the operation's capability. In particular, host admission needs an explicit trusted `admit` grant, and neither host nor operator receives `content_read` by default. Adding a capability cannot override the operation's allowed role list. Non-operator scoped operations require a bound Engagement; a bound operator also cannot cross that binding. Unbound operators may select an Engagement.

The trusted host session association is a snapshot registered on the principal, not a request field. Reviewer model/prompt/ruleset attestation is also transport-owned. CLI process configuration is trusted host input, not a mechanism to let a model choose its own identity.

## Operation inventory

The current registry contains 50 supported operations. Roles below are the exact registry roles; capability requirements come from `service.ts`. The model-role registry is broader than the six-tool MCP inventory. `engagement.status` currently returns installation-wide counts and sequence after the scoped authorization check; it is not an Engagement-safe aggregate. Use `host.state` for scoped host status.

| Operation | Allowed roles | Capability | Writes authority/state |
|---|---|---|---|
| `engagement.init` | operator | operator | yes |
| `engagement.status` | model, host, operator | read | no |
| `capability.status` | model, host, reviewer, operator | operator | no |
| `adapter.status` | host, operator | role only | no |
| `adapter.install` | operator | role only | no |
| `adapter.remove` | operator | role only | no |
| `adapter.config` | operator | role only | no |
| `context.build` | model, host, operator | read | no |
| `context.query` | model, host, operator | read | no |
| `query` | model, host, operator | read | no |
| `resource.query` | model, host, operator | read | no |
| `evidence.query` | model, host, operator | read | no |
| `proposal.submit` | model, host, operator | propose | yes |
| `proposal.list` | model, host, operator | read | no |
| `capture.observation` | host, operator | propose | yes |
| `review.submit` | reviewer | review | yes |
| `admission.evaluate` | host, writer, operator | admit | yes |
| `admission.commit` | host, writer, operator | admit | yes |
| `admission.promote_l2` | writer, operator | writer | yes |
| `control.observe` | host, operator | role only | yes |
| `access.observe` | host, operator | role only | yes |
| `control.list` | model, host, operator | read | no |
| `host.state` | host, operator | read | no |
| `work.claim` | host | work | yes |
| `work.renew` | host | work | yes |
| `work.reclaim` | host | work | yes |
| `work.resume` | host | work | no |
| `checkpoint.propose` | model, host, operator | propose | yes |
| `checkpoint.commit` | host | checkpoint | yes |
| `action.recommend` | model, host, operator | propose | yes |
| `action.host-decision` | host | action | yes |
| `action.host-result` | host | action | yes |
| `action.reconcile` | host | action | yes |
| `artifact.session.bind` | host, operator | content | yes |
| `artifact.store.begin` | host, operator | content | yes |
| `artifact.store.append` | host, operator | content | yes |
| `artifact.store.commit` | host, operator | content | yes |
| `artifact.metadata` | host, operator | content | no |
| `artifact.content.read` | host, operator | content_read | no |
| `artifact.content.list` | host, operator | content | no |
| `artifact.session.output` | host, operator | content | no |
| `audit.verify` | operator | audit | no |
| `audit.doctor` | operator | audit | no |
| `audit.reconcile` | operator | audit | yes |
| `error.report` | host | work | yes |
| `snapshot.export` | operator | audit | no |
| `resource.revise` | host, writer, operator | propose | yes |
| `resource.patch` | host, writer, operator | propose | yes |
| `resource.relation` | host, writer, operator | propose | yes |
| `resource.impact` | host, writer, operator | propose | yes |

`admission.commit` is an implemented alias of `admission.evaluate`. `context.build/query` share the Context builder. `resource.query` and `evidence.query` both route to the generic record query: their names do not enforce `kind`; set `kind` explicitly when required.

The unsupported declarations are `snapshot.import`, `migration`, `backup.restore`, `remote.push`, `full_quality_evaluation`. Dispatch additionally recognizes deferred `storage.backup/storage.restore`. Internal snapshot restore, projection callbacks and statistical helpers do not enable these public operations.

## Model-facing operations

MCP exposes only `initialize`, `tools/list`, `tools/call`, negotiates `2024-11-05`, and advertises `{ "tools": {} }`. Tool results contain a JSON-serialized Core envelope in `content[0].text` and `isError:!response.ok`. No resources, subscription, Tasks, arbitrary dispatch or raw Artifact operation is exposed.

| Tool | Required arguments | Other accepted tool arguments |
|---|---|---|
| `context.query` | engagement_id | work_run_id, budget, cursor, read_seq, filters, ordering, work_item_id, worker_role, policy_version, include_candidates |
| `resource.query` | engagement_id | as_of, cursor, page_size, kind |
| `evidence.query` | engagement_id | as_of, cursor, page_size, kind |
| `proposal.submit` | engagement_id, subject_type, expected_version, content | proposal_id, client_request_id, target_id, subject_ref |
| `checkpoint.propose` | engagement_id, work_run_id, generation, checkpoint | none |
| `action.recommend` | engagement_id, target, method, rationale | work_run_id |

Tools reject missing/unexpected argument names. Further validation happens in Core. MCP `context.query.work_run_id` is accepted by the tool schema but not consumed by the builder; it does not bind a run. MCP `action.recommend` has no `generation` field, so the public tool cannot complete a run-scoped recommendation requiring one; use the trusted host path for that flow. `scanBudget`, reviewer attestation, idempotency_key and host session identity are not MCP inputs.

Model `resource/evidence.query` force ordinary L2 visibility, ignoring Core-only candidate/trust selection. Context has a separate candidate option and projection rules; do not interpret `include_candidates` as trust promotion. Models never call admission, raw content, `host.state`, host checkpoint commits or target execution.

## Identity and governance phases

`engagement.init` takes `name?` and `scope` with `allowed_targets`, `excluded_targets`, `rules_of_engagement_ref`. Core allocates Engagement/Scope IDs; a request `id` is rejected.

A `proposal.submit` create uses `expected_version:0`; an update also supplies `target_id` or `subject_ref` and the positive target version. `proposal_id` is an optional UUIDv7 proposal request identity, and `client_request_id` is bounded to 128 characters; neither selects a canonical ID. Core rejects writer-managed fields inside candidate content, validates its domain shape and references, and assigns host/model provenance from the principal.

```json
{
  "engagement_id":"<Engagement UUIDv7>",
  "subject_type":"resource",
  "expected_version":0,
  "content":{
    "schema_version":"1.0.0",
    "engagement_id":"<same Engagement UUIDv7>",
    "kind":"resource",
    "asset_type":"endpoint",
    "identity":{"origin":"https://example.test","method":"GET","path":"/admin"},
    "revision":1
  }
}
```

`capture.observation` accepts `observation` (or `content`), optional subject_type/expected_version/target_id and host run attribution. It delegates to proposal submission; it does not prove the host tool ran or admit the result.

`admission.evaluate` takes engagement_id, proposal_id, expected_version, policy_digest and optional idempotency_key. It performs structural L0→L1 admission, returns the resulting record and remaining L2 conditions, and does not enforce full evidence/freshness/independence gates. Inspect `data.ok` before reading `data.record`.

`review.submit` takes engagement_id, proposal_id, reviewer_id (equal to principal.id), reviewer_kind (`reviewer`), input_hash, verdict and policy_digest; evidence_snapshot_hash, rubric_hash, limitations and idempotency_key are optional method inputs. Verdicts are pass/reject/needs_evidence/defer. Requests cannot supply reviewer_capability/reviewer_model/prompt_digest/ruleset_digest. Configure those via trusted registration:

```js
const reviewer = createPrincipal("reviewer", reviewerId, engagementId, [], {
  capability: "model",
  model: pinnedModel,
  prompt_digest: promptHash,
  ruleset_digest: rulesetHash,
});
```

Missing attestation uses conservative model classification. Attestation asserts the host's configured identity; Taric does not independently establish human identity or a real external review.

`admission.promote_l2` requires engagement_id, proposal_id, target_id, current canonical expected_version, input_hash, evidence_snapshot_hash, policy_digest and nonempty review_refs; idempotency_key is optional. Only writer/operator with writer capability may promote a Finding. Core recomputes schema/scope/evidence/freshness/independence against pinned inputs; stale/rejected inputs retain L1. Historical materials use ordinary proposals/evidence with original observed_at, references and limitations, without impersonating an import transport or current observation.

## Context and query pagination

| Entry | Public inputs and result |
|---|---|
| `context.build/query` | engagement_id; optional budget (default 4000 characters), include_candidates, work_item_id, worker_role, policy_version, read_seq, cursor, filters, ordering; Core service also takes checkpoint, resume_from_seq, pending_actions. Result: ContextPack with items, cursor, read_seq, used/budget_unit, mandatory_constraints, manifest/sources, omitted metadata and read_stats. |
| `query/resource.query/evidence.query` | engagement_id; optional as_of, trust_level, include_candidates, kind, page_size (default 100, 1–1000), cursor. Result: records, next_cursor, read_seq, committed_seq, projected_seq. Model queries force L2 visibility. |
| `proposal.list` | engagement_id, page_size (default 100, 1–1000), cursor. Result: proposals, next_cursor, fixed read_seq. This is a proposal listing rather than an ordinary fact query. |

For continuation, preserve the principal, Engagement, page/character budget and selection bindings. Context uses fixed read_seq/read_time and bounded priority keyset pages; its v2 AES-GCM cursor stores ordering/filter/policy/WorkItem/worker binding and expiry, not source bodies. `omitted_count_complete:false` and `omitted_as_unexamined:true` mean the unseen range has not been completely counted. Mandatory constraints that cannot fit return `minimum_budget_required`.

`scanBudget` (2–1000, default 256 including lookahead), `cursorTtlMs` (default one hour), `reviewerMode` and diagnostics are **Core helper options** for `buildContextPack`, not public dispatch/CLI/MCP request fields. The service does not forward a request `scanBudget`. Resume delta is a separate bounded changed-subject/event query; it can fail with `minimum_budget_required` rather than emit an incomplete result as complete.

Authority record/proposal list cursors are v1 HMAC. They share the persisted `.taric-context-cursor-key.v1` with Context, bound to authority ID and real content root. Key loss/rotation/tampering or changed request bindings cause `invalid_cursor`; restart with the same authority/root/key supports valid continuation. Artifact catalog/chunk cursors use different formats and are not fixed-read Context cursors. See [context recovery](context-recovery.md).

## Host adapter operations

### Node adapter proxy

`taric proxy` opens Core via `openRuntimeService` and listens on `TARIC_CORE_SOCKET`. It requires a token of at least 32 characters and an Engagement, fixes the principal role to host, takes its ID from TARIC_PRINCIPAL_ID/config/default adapter-host, and optionally registers `TARIC_SESSION_ID`. No request can replace that principal. The proxy's default grants exclude admit and content_read; admission/review/promotion use separately trusted clients.

A request is one newline-terminated UTF-8 JSON-RPC message:

```json
{"jsonrpc":"2.0","id":1,"method":"taric.dispatch","params":{"token":"<host token>","operation":"host.state","request":{"engagement_id":"<UUIDv7>","limit":100}}}
```

A valid call returns a JSON-RPC `result` containing the Core envelope. Parse errors use -32700, invalid request -32600 and invalid method/authentication -32001. Requests and responses are capped at 1 MiB per line. Oversized requests close the socket; oversized responses return a smaller validation error. Requests are drained sequentially per connection with response backpressure; this is not a global bounded request scheduler.

The socket is mode 0600, its created directory mode 0700. Protect the token, socket, authority and spool inside the trusted host boundary. A Bun client can use [adapter-rpc-bun-client.mjs](../scripts/adapter-rpc-bun-client.mjs). The proxy does not start HTTP/TCP or the binary Artifact listener automatically.

### Session and run attribution

A proxy/session host can `work.claim` before establishing a run-bound spool: the task_session_ref is derived from transport registration. Once the current run/Attempt is known, bind that session with mode run-bound and the complete owner/run tuple. A request task_session_ref that differs from the trusted session is rejected.

For proposal/capture/checkpoint/action, hosts with a registered session must have a persisted binding. run-bound attachments supply the same work_run_id and generation; any supplied content work_run_ref/attempt_ref/generation must match. Body/content session_id/transport_session_id/task_session_ref cannot choose an association. A host without a trusted session cannot attach to a run already associated with one. Original-attempt late proposals retain their old attribution and follow quarantine rules rather than becoming current canonical state.

These host-session checks apply to host principals; other roles keep their own operation/schema/governance checks. Artifact upload uses the persisted binding/upload state for its fence and does not require callers to repeat run fields on every append/commit.

### Work, checkpoint and actions

`work.claim`: engagement_id, work_item_id, host_id, agent_id, ttl_ms?; host identity is overwritten from principal. `work.renew`: engagement_id, work_run_id, generation, ttl_ms?. `work.reclaim`: engagement_id, work_run_id, agent_id, ttl_ms?. Lease TTL defaults to 60000ms and must be a positive safe integer.

`checkpoint.propose` takes engagement_id, work_run_id, generation, checkpoint and creates a candidate. `checkpoint.commit` additionally accepts host_id but uses principal identity; it requires the current owner/lease/Attempt and complete checkpoint contract. Checkpoint lists must be explicit even when empty. Hidden reasoning fields are recursively rejected, not silently removed.

`work.resume` takes engagement_id, work_run_id, host_id; principal identity determines ownership. It returns run/checkpoint/pending_actions/task_session_ref/artifact_refs plus premise_checks, blocked, replan_required and resume_advice. It does not execute recovery or reissue a lease. Current resumePacket materializes the session's Artifact metadata, so it is not the bounded Context delta API.

`action.recommend` takes target, method, rationale and optional uncertainty/scope/constraints/limitations/memory_refs/evidence_refs. Without a run it creates a proposal; a run also requires generation and produces an advisory ActionIntent. Host decision/result operations take engagement_id, work_run_id, action_id, generation and mode. Decisions are authorized/denied; results executed/failed/unknown; modes llm_recommend/authorized_autonomous/host_hitl. `action.reconcile` takes a result_ref and executed/failed for an unknown result. Authorization and execution stay in the host.

### Host state polling

`host.state {engagement_id,limit?}` requires host/operator and read capability. limit defaults to 100, range 1–1000. Its response contains:

- engagement_id, read_time, bounded:true, limit;
- `watermark:{scope}`: an opaque hash of the scoped record watermark, aggregates and completeness;
- aggregates l1_pending, conflicts, impacts, unknown_actions, expired_leases, freshness_due;
- matching aggregate_completeness flags and a freshness summary evaluated at read_time.

L1 excludes conflict/impact records. Freshness inspects at most limit record headers; incomplete counts are lower bounds. Conflict/Impact counts are bounded records, not necessarily unresolved/new events. There is no event body, continuation or global authority sequence. Time expiry is observed without a new commit. Poll on a timer even when the watermark is unchanged; it is not an event-delivery token.

```js
import { setTimeout as delay } from "node:timers/promises";

let waitMs = 250;
while (!signal.aborted) {
  try {
    const response = await service.dispatch("host.state", hostPrincipal, {
      engagement_id: engagementId, limit: 100,
    });
    if (!response.ok) throw new Error(response.error.message);
    await onState(response.data);
    waitMs = 250;
  } catch (error) {
    if (signal.aborted) break;
    waitMs = Math.min(5000, waitMs * 2);
    await onPollError(error);
  }
  try { await delay(waitMs, undefined, { signal }); }
  catch (error) { if (!signal.aborted) throw error; }
}
```

`service`, hostPrincipal, engagementId, signal and handlers are supplied by the host. Reconnect/reopen a failed service before retrying. The [saved polling measurement](benchmarks/host-state-poll-v1.json) met its fixture's 1000ms discovery budget; it does not certify a 5s retry cap against that budget. Resources subscription remains disabled.

## Task-session Artifact content

`artifact.session.bind` requires engagement_id, session_id, root, mode. Only host/operator may bind. host-session rejects work_run_id/attempt_id/generation/owner_host. run-bound requires all four, owner equal to principal.id, and a current authority fence. Root must be inside configured contentRoot, with no symlink escape/overlap/rebinding. Existing mode/run association cannot be changed. Artifact calls from a transport-bound host must name its registered session.

| Operation | Required request fields after Engagement/session | Important options/result |
|---|---|---|
| `artifact.store.begin` | payload_kind (text/binary/manifest), media_type | storage_mode, expected_bytes/hash, category, captured_at, host_ref, derivation/version refs, run attribution, idempotency_key; stored-upload result includes upload_id, artifact_id, version, next_ordinal, max_chunk_bytes and deployment_profile; external mode returns metadata directly |
| `artifact.store.append` | upload_id, ordinal, chunk_hash, data | canonical base64; optional encoding/offset/idempotency_key; decoded block ≤64 MiB |
| `artifact.store.commit` | upload_id, total_bytes, content_hash | optional chunk_count/manifest_hash/idempotency_key; returns committed metadata/ref |
| `artifact.metadata` | content_ref | metadata, no payload |
| `artifact.content.read` | content_ref | offset/length or chunk_cursor, max_response_bytes; always a raw read requiring content_read |
| `artifact.content.list` | none | cursor/page_size/category/media_type/work_run_id; metadata by default; include_content separately checks content_read |
| `artifact.session.output` | none | catalog cursor plus execution_cursor, page_size, work_run_id/attempt_id, include_content/max_response_bytes |

The profile is `artifact-deployment/1`, ID `local_process_crash`. Limits are 64 MiB decoded chunk, 89,478,488 base64 chars, 16 KiB metadata, Core page size ≤1000 and metadata-page budget 1 MiB. Ordinary adapter JSON-RPC caps all Artifact list/output pages at 16 items; raw reads ≤512 KiB decoded, content-bearing pages ≤128 KiB decoded. Its 1 MiB line bound cannot carry a 64 MiB base64 append.

For local files, `taric artifact.store.append-file '<metadata-json>' <path>` accepts metadata engagement_id/session_id/upload_id/ordinal/idempotency_key? and 1 byte–64 MiB of file data. It derives byte_length/chunk_hash and streams the file in 64 KiB pieces. This is a CLI helper calling `artifactStoreAppendBinaryStream`, not a registered dispatch operation.

For a separate trusted binary listener, call `listenArtifactBinaryRpc(service,{socket_path,token,principal})` with an Engagement-bound host principal. Frame: 4-byte big-endian header byte length, JSON `{token,operation:"artifact.store.append.binary",request:{engagement_id,session_id,upload_id,ordinal,byte_length,chunk_hash,idempotency_key?}}`, then exactly byte_length raw bytes followed by a client write-side close. The server returns one plain Core-envelope JSON line, not a JSON-RPC wrapper. Header ≤16 KiB, body 1 byte–64 MiB, two active connections, per-upload receive queue 2×64 KiB, 30s socket inactivity timeout. Partial/trailing/over-limit/hash-mismatched data cannot publish. This listener appends only; commit remains separate.

Files use server-derived IDs and UTC storage dates, per-version content.manifest.json, native payload parts, metadata.md and per-Artifact-version NDJSON metadata entries. Catalog state lives in authority tables, raw bytes in the bound spool. Publication/recovery revalidates manifest/chunks and the persisted fence; omission cannot downgrade a run-bound upload. Reclaimed/expired publications remain unavailable/pending for operator handling. No explicit fsync or power-loss durability is claimed.

Catalog cursors are base64url scope/filter/keyset metadata, without Context's authenticated fixed-sequence guarantee. Chunk cursors identify ordinal:offset. Responses include catalog/index watermarks and output's separate execution_next_cursor. External host_ref is metadata only; Taric never fetches it. See [spool operations](multi-host-authority-runbook.md#artifact-spool-in-a-shared-deployment).

## Evolution and recovery operations

`resource.revise` creates an immutable ResourceRevision, allocating a new resource when resource_id is absent, or requiring current expected_version for an existing resource. `resource.relation` allocates a same-Engagement typed edge. `resource.patch` takes base generation and read/write sets; creates use ID-free upsert records and expected_version 0, updates target existing IDs. `resource.impact` takes engagement_id/source_id plus limit/continuation and returns affected IDs, revalidation WorkItems and pending watermark.

`control.observe/access.observe` record typed control/access observations; unknown control/layer and origin-not-reached semantics do not establish origin coverage. `control.list` returns the Engagement control view.

| Maintenance call | Current behavior |
|---|---|
| audit.verify | Operator audit-chain verification |
| audit.doctor | Fixed maintenance read plus read-only Artifact reconciliation report |
| audit.reconcile `{action:"preview"}` | Read-only recovery preview and Artifact report |
| audit.reconcile `{}` | Mutates derived state: consumes outbox, reconciles Artifact; not a preview |
| audit.reconcile replay/rebuild/reconcile | Explicit derived-state repair; reconcile also checks/repairs Artifact state |
| snapshot.export | Operator sanitized JSON for one Engagement at optional as_of; full selected-record materialization |
| snapshot.import | Unsupported before authority access/mutation; private backend restore is separate |

Export includes the latest record version at the selected sequence, including L0/recalled canonical records omitted by ordinary recall, with sensitive fields removed. It does not include the proposal/review tables, arbitrary event history, all past versions, active lease state or payload files. `exportSnapshotJsonl` is a backend library method; public snapshot.export has no JSONL format switch. Neither export is a complete database backup or a public migration path.

## Projection allowlist

Context, query, Markdown and export use different visibility/filter paths. None is a route to raw payload bytes, credential facilities, private filesystem paths or hidden reasoning. Context can show safety/coverage constraints and explicit candidate metadata; query defaults to callable L2 recall; projection generates L2 white-listed files; operator export preserves selected lower-trust/recalled canonical records for inspection. Hosts must not feed an export into the model as a substitute for a Context Pack.

`git.remote_push` and `secrets.external_scanner` are host callback capabilities of `projection.ts`, with real scanner tool version/result hash and push evidence, private repository/access/retention and per-Engagement authorization. Public `remote.push` is still unsupported.

## Executable synthetic example

After `npm run build`, run from the repository root with Node. This example uses a new temporary persistent authority, dispatch-only public operations and synthetic bytes. It demonstrates L0→L1 and explicit content_read; it does not claim L2 review.

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCoreServiceForPath, createPrincipal, policyDigest } from "@taric/core";

const must = (r) => {
  if (!r.ok || r.data?.ok === false) throw new Error(JSON.stringify(r));
  return r.data;
};
const root = await mkdtemp(join(tmpdir(), "taric-doc-demo-"));
const contentRoot = join(root, "content");
const service = await createCoreServiceForPath(join(root, "authority.sqlite"), contentRoot);
try {
  const operator = createPrincipal("operator", "demo-operator");
  const engagement = must(await service.dispatch("engagement.init", operator, {
    name: "synthetic example",
    scope: { allowed_targets: ["https://example.test"], excluded_targets: [], rules_of_engagement_ref: "roe:demo" },
  }));
  const engagement_id = engagement.id;
  const host = createPrincipal("host", "demo-host", engagement_id, ["content_read"]);
  const proposal = must(await service.dispatch("proposal.submit", host, {
    engagement_id, subject_type: "resource", expected_version: 0,
    content: { schema_version: "1.0.0", engagement_id, kind: "resource", asset_type: "endpoint",
      identity: { origin: "https://example.test", method: "GET", path: "/" }, revision: 1 },
  }));
  const admitted = must(await service.dispatch("admission.evaluate", operator, {
    engagement_id, proposal_id: proposal.id, expected_version: 0, policy_digest: policyDigest(),
  }));
  if (admitted.record.trust_level !== "L1") throw new Error("expected L1");
  const session_id = "demo-session";
  must(await service.dispatch("artifact.session.bind", host, {
    engagement_id, session_id, root: join(contentRoot, session_id), mode: "host-session",
  }));
  const bytes = Buffer.from("synthetic content\n");
  const content_hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const upload = must(await service.dispatch("artifact.store.begin", host, {
    engagement_id, session_id, payload_kind: "text", media_type: "text/plain",
    expected_bytes: bytes.length, expected_hash: content_hash,
  }));
  must(await service.dispatch("artifact.store.append", host, {
    engagement_id, session_id, upload_id: upload.upload_id, ordinal: 0,
    data: bytes.toString("base64"), encoding: "base64", chunk_hash: content_hash,
  }));
  const artifact = must(await service.dispatch("artifact.store.commit", host, {
    engagement_id, session_id, upload_id: upload.upload_id,
    total_bytes: bytes.length, chunk_count: 1, content_hash,
  }));
  const read = must(await service.dispatch("artifact.content.read", host, {
    engagement_id, session_id, content_ref: artifact.content_ref, offset: 0, length: bytes.length,
  }));
  if (!Buffer.from(read.data, "base64").equals(bytes)) throw new Error("content mismatch");
  console.log({ trust: admitted.record.trust_level, content_ref: artifact.content_ref });
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
```

For the full Resource/Observation/Evidence/Claim/Finding, independent reviewer and writer sequence, use the public-boundary [trusted Node governance fixture](../packages/core/test/trusted-node-governance.test.mjs). Saved performance/runtime evidence and quality limitations are indexed in [the release record](../openspec/changes/archive/2026-10-18-taric-capability-improvement/release-report.md).
