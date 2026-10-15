# Taric API Boundary v1

Taric exposes versioned JSON contracts through CLI, MCP, and native host adapters. The Core owns memory state transitions and canonical writes. Hosts may keep Artifact bodies external or explicitly store opaque originals in a bound Taric task-session spool. Hosts still own target-system tools, credentials and their lifecycle, HITL identity, and action authorization.

## Model-facing operations

| Operation | Purpose | Boundary |
|---|---|---|
| `context.query` | Read an engagement-scoped, pinned Context Pack | Allowlisted fields and host-approved Artifact references only |
| `resource.query` | Read resources, revisions, relations, and trust metadata | No unallowlisted fields or other engagements |
| `evidence.query` | Read evidence metadata and host Artifact references | Does not return Artifact bodies or credentials |
| `proposal.submit` | Submit a proposal, observation, claim, or patch | Creates L0/private state only |
| `checkpoint.propose` | Suggest progress for a host checkpoint | Does not commit a checkpoint or change a WorkRun lease |
| `action.recommend` | Ask Taric for an advisory action recommendation | Never authorizes or executes a target action |

Model-facing operations never expose `writer.commit`, admission internals, `checkpoint.commit`, host credential facilities, target tools, or arbitrary file/database paths.

## Identity and governance phases

Core allocates every new canonical UUIDv7, including Engagement identity. `engagement.init` accepts a name and an explicit `scope` containing `allowed_targets`, `excluded_targets`, and `rules_of_engagement_ref`; it atomically creates the scope and Engagement and returns its assigned `data.id`. A caller-supplied `id` is rejected. A proposal uses a separate request envelope:

```json
{
  "engagement_id": "0199f000-0000-7000-8000-000000000001",
  "subject_type": "claim",
  "expected_version": 0,
  "client_request_id": "scan-20261014-1",
  "content": {
    "schema_version": "1.0.0",
    "engagement_id": "0199f000-0000-7000-8000-000000000001",
    "kind": "claim",
    "proposition": "Candidate lead",
    "status": "proposed",
    "evidence_refs": [],
    "limitations": ["awaiting evidence"]
  }
}
```

`proposal_id` may be a UUIDv7 request identity; `client_request_id` is bounded request metadata. Neither becomes a canonical key. Creates use `expected_version=0`; updates additionally name `target_id` (or equivalent `subject_ref`) and the target's positive expected version. `content.id`, writer versions, display IDs, trust assertions, review references, policy results, and `accept` are rejected. Candidate `kind`, schema, provenance, ownership, required fields, and existing references are validated before any proposal or audit row is inserted. Proposal provenance permits `model`, `worker`, `host`, `tool`, and `import`; the service binds producer identity to the authenticated principal. `source_ref` remains an authority reference.

`admission.evaluate` performs L0→L1 structural admission. Its request names `proposal_id`, `expected_version`, and `policy_digest`; its result returns `trust_phase=machine_approved`, the structural policy version, the canonical ID, and remaining L2 requirements. It does not evaluate evidence sufficiency, freshness, or independent review. Evidence-incomplete draft findings may remain pending or become L1 candidates and are excluded from ordinary fact recall.

`admission.promote_l2` performs L1→L2 finding promotion. Only a writer or operator with the `writer` capability can call it. The request pins `engagement_id`, `proposal_id`, `target_id`, the admitted canonical `expected_version`, `input_hash`, `evidence_snapshot_hash`, `policy_digest`, and a nonempty `review_refs` array. Accepted reviews are bound to an authenticated independent reviewer, the exact proposal/evidence hashes, and policy. Core recomputes the evidence, freshness, independence, and risk gates in the promotion transaction, then returns `trust_phase=independently_verified`. Model, host, and reviewer roles cannot promote. Stale targets or evidence return stable errors and preserve the L1 finding. CLI exposes `admission promote_l2` and the dotted operation; MCP's model inventory excludes it.

Reviewer capability and model/prompt/ruleset identity are transport attestations. `review.submit` rejects caller fields `reviewer_capability`, `reviewer_model`, `prompt_digest`, and `ruleset_digest`. An authenticated transport supplies verified metadata when creating the principal, for example `createPrincipal("reviewer", reviewerId, engagementId, [], { capability: "model", model: pinnedModel, prompt_digest: promptHash, ruleset_digest: rulesetHash })`; Core snapshots it at registration. Reviewers without configured attestation use the conservative `model` classification and cannot self-assert human review or heterogeneous model identities.

## Host adapter operations

Native adapters map lifecycle events to the same versioned contract. Authenticated adapters may commit checkpoints for the current WorkRun lease and record host action decisions/results. The supported action modes are `llm_recommend`, `authorized_autonomous`, and `host_hitl`; the host chooses the mode and remains responsible for authorization and execution.

## Evolution and recovery operations

`resource.revise` appends an immutable ResourceRevision with a variant, content hash, source observations, validity window, and supersession link. A new logical resource omits `resource_id`; an existing resource names `resource_id` and its current `expected_version`, and cannot change logical identity. `resource.relation` creates typed same-Engagement edges with criticality and applicability; Core assigns the relation ID. `resource.patch` requires a base generation plus read/write sets; independent fields merge, while CAS-sensitive overlap creates an auditable conflict. A patch create uses an `upsert` operation with an ID-free `record`, `expected_version=0`, and no `entity_id`; Core fills the committed write set with the allocated IDs. Updates require explicit entity targets. Caller IDs cannot create a resource, relation, PatchSet, or upsert record. `resource.impact` processes explicit dependencies in bounded batches and returns a continuation and revalidation WorkItems.

`snapshot.export` produces Taric-native JSON or JSONL with schema, source sequence, revisions, provenance, aliases, and integrity hash metadata. `snapshot.import` validates the complete temporary dataset and atomically rejects malformed, conflicting, cross-Engagement, or tampered input. Context cursors bind principal, Engagement, filters, ordering, read sequence, and budget; resume returns post-checkpoint deltas. Sealed drafts require explicit rebase before a later Attempt can reference them.

## Projection allowlist

Markdown, Context Pack, query, trace, and export projections exclude raw Artifact contents, `SecretRef`, token/session material, private paths, unreviewed proposals, and sensitive drafts. Stored Artifact metadata may include an opaque content reference, payload kind, media type, byte length, hash, provenance and integrity status; it does not include a local path or unapproved host summary. Taric treats summaries and host references as untrusted metadata. Redaction, secret scanning, credential lifecycle, and retention remain host policies.

## Task-session Artifact content

The deployment profile returned by `artifact.store.begin` keeps a 64 MiB decoded chunk limit. Base64 transport may use 89,478,488 characters plus at most 16 KiB JSON metadata. The default `local_process_crash` profile uses verified publication markers and atomic rename, performs no explicit fsync, and advertises no power-loss guarantee. [The runbook](multi-host-authority-runbook.md#artifact-spool-in-a-shared-deployment) describes measurements and crash-boundary checks.

Artifact storage is opt-in. `artifact.session.bind` registers a session root beneath the configured `TARIC_CONTENT_ROOT`; traversal, symlink escapes, and paths outside that root are rejected. After binding, the host uses `artifact.store.begin`, ordered `artifact.store.append`, and `artifact.store.commit` to write original textual or binary bytes. JSON/RPC/CLI upload data is base64 transport; Taric decodes it before computing byte counts and SHA-256 hashes. Each append is bounded to 64 MiB of decoded payload, and retries of an existing ordinal succeed only when its byte count and hash match. Taric returns an opaque `artifact_id@vN` content reference. A `host_ref` can be kept as metadata, but Taric does not fetch external content.

For each committed version, files are placed under the bound session root using UTC stored date and server-assigned Artifact ID sharding:

```text
<session-root>/
  manifest.json
  artifacts/YYYY/MM/DD/ab/<artifact-id>/v000001/
    payload-000001.part       # native bytes, at most 64 MiB per file
    content.manifest.json     # byte offsets and chunk/full SHA-256 hashes
    metadata.md               # human-readable reference, media type, size, hash
```

The root `manifest.json` is initialized at bind time. Payload files are not Markdown or base64; the manifest is machine JSON and `metadata.md` contains only bounded identifying metadata. Payload filenames are server-derived and no read operation accepts a filesystem path.

An unfinished upload is reported as `pending` and remains private to the upload ID. A successful commit records `content_status=available` and `integrity_status=verified`. If a manifest or payload file is missing, reads fail with `unavailable_host`; if a chunk does not match its recorded length/hash, the row is marked `integrity_failed`/`mismatch` and reads fail with a conflict. Doctor/reconcile persists the resulting catalog status and reports the repair range without silently modifying source files.

Host/operator calls are `artifact.metadata`, `artifact.content.list`, `artifact.content.read`, and `artifact.session.output`. List and session output are bounded metadata pages by default. A raw read requires the separately granted `content_read` capability and returns a bounded base64 chunk with media metadata, exact content hash, chunk integrity result, and an optional continuation cursor. MCP has no raw-content operation. External references remain host-managed; binding a session does not make Taric fetch them.

The spool uses staged files plus SQLite publication markers. Core startup and `audit.reconcile` verify pending publication markers, manifests, chunk hashes, and catalog associations; incomplete or tampered content is reported as unavailable/integrity failure and is never silently recreated or deleted. Catalog pages use bounded keyset cursors and expose catalog/index watermarks. Session output includes bounded, WorkRun-fenced execution sidecar pages and supports a separate execution cursor. Physical manifest segment rollover remains a future storage-layout optimization; the current bounded segment records and opaque reference contract remain stable.

From the repository root after `npm run build`, this operator CLI flow uses only synthetic content and a new temporary store:

```sh
taric() { node packages/cli/dist/bin.js "$@"; }
export TARIC_DEMO_DIR="$(mktemp -d)"
export TARIC_DB="$TARIC_DEMO_DIR/authority.sqlite"
export TARIC_CONTENT_ROOT="$TARIC_DEMO_DIR/content"
export TARIC_PRINCIPAL_ROLE=operator
INIT="$(taric engagement.init '{"name":"artifact-demo","scope":{"allowed_targets":["synthetic.local"],"excluded_targets":[],"rules_of_engagement_ref":"roe:artifact-demo"}}')"
export TARIC_ENGAGEMENT_ID="$(printf '%s' "$INIT" | jq -r '.data.id')"
taric artifact.session.bind "{\"engagement_id\":\"$TARIC_ENGAGEMENT_ID\",\"session_id\":\"task-001\",\"root\":\"$TARIC_CONTENT_ROOT/task-001\"}"

BODY='synthetic request body'
BODY_B64="$(printf '%s' "$BODY" | base64 | tr -d '\n')"
BODY_HASH="sha256:$(printf '%s' "$BODY" | shasum -a 256 | awk '{print $1}')"
BODY_BYTES="$(printf '%s' "$BODY" | wc -c | tr -d ' ')"
BEGIN="$(taric artifact.store.begin "{\"engagement_id\":\"$TARIC_ENGAGEMENT_ID\",\"session_id\":\"task-001\",\"payload_kind\":\"text\",\"media_type\":\"text/plain\",\"expected_bytes\":$BODY_BYTES,\"expected_hash\":\"$BODY_HASH\"}")"
UPLOAD_ID="$(printf '%s' "$BEGIN" | jq -r '.data.upload_id')"
taric artifact.store.append "{\"engagement_id\":\"$TARIC_ENGAGEMENT_ID\",\"session_id\":\"task-001\",\"upload_id\":\"$UPLOAD_ID\",\"ordinal\":0,\"data\":\"$BODY_B64\",\"encoding\":\"base64\",\"chunk_hash\":\"$BODY_HASH\"}"
COMMIT="$(taric artifact.store.commit "{\"engagement_id\":\"$TARIC_ENGAGEMENT_ID\",\"session_id\":\"task-001\",\"upload_id\":\"$UPLOAD_ID\",\"total_bytes\":$BODY_BYTES,\"chunk_count\":1,\"content_hash\":\"$BODY_HASH\"}")"
CONTENT_REF="$(printf '%s' "$COMMIT" | jq -r '.data.content_ref')"
taric artifact.metadata "{\"engagement_id\":\"$TARIC_ENGAGEMENT_ID\",\"session_id\":\"task-001\",\"content_ref\":\"$CONTENT_REF\"}"
taric artifact.content.list "{\"engagement_id\":\"$TARIC_ENGAGEMENT_ID\",\"session_id\":\"task-001\",\"page_size\":100}"
```

Raw `artifact.content.read` is intentionally omitted from this local CLI flow: the CLI-created principal has no separately configured `content_read` grant. An authenticated host transport can call the same operation when Core has granted that capability for the Engagement. Never put payload bytes or local paths into Evidence, authority records, logs, Markdown, Context Packs, or model-facing summaries.

For a host adapter already holding a transport-verified Core client, the raw read request is explicit and scoped by Engagement, session, and opaque reference:

```ts
import { createPrincipal } from "@taric/core";

const host = createPrincipal("host", "scanner-worker", engagementId, ["content_read"]);
const response = service.dispatch("artifact.content.read", host, {
  engagement_id: engagementId,
  session_id: "task-001",
  content_ref: "01a13327-ccfd-740f-89d2-d01ff8d3f7da@v1",
  offset: 0,
  length: 65536,
});
```

In a deployed adapter, the host transport creates the principal from its authenticated identity/capability mapping; request fields cannot grant `content_read` to themselves. The returned `data` is base64 transport for at most the requested bounded bytes and includes the next cursor when more content remains.
