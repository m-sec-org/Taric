# Design

## Context

See `proposal.md` and the specification deltas for the behavior being added. Today `ArtifactReference` and WorkRun/Attempt/Checkpoint records are stored in the SQLite authority, while Artifact bodies remain outside Taric and no current task-session path contract exists. The existing projection writer already demonstrates atomic Markdown generation and path containment; the existing authority already provides engagement permissions, idempotency, audit events, operation markers, read sequences, leases, and fencing generations.

## Goals / Non-Goals

**Goals:**

- Store the exact original bytes of textual and binary penetration-test Artifacts in a host-bound task-session sidecar store; use Markdown only for metadata, manifests, and human-readable execution records.
- Keep SQLite authority metadata, hashes, associations, state transitions, permissions, and audit events authoritative over the files.
- Provide one versioned Core contract reused by authenticated host adapters and CLI for storing, listing, reading, and composing task-session output.
- Preserve the model-facing reference/summary-only boundary and derived Brief/Index allowlists.
- Recover deterministically from a crash between file publication and authority commit, and report missing or tampered files explicitly.
- Preserve the host's choice to keep an Artifact external by retaining an external `host_ref`; Taric storage is opt-in per task session and is not a credential vault or target execution store.

**Non-Goals:**

- No automatic redaction, content classification, secret scanning, decryption, encryption-key management, or retention/expiry policy in this change.
- No credential or token lifecycle management, credential injection, hidden reasoning, human HITL identity, or target-system execution storage. An uploaded raw Artifact MAY contain credential, token, or cookie bytes; Taric stores them opaquely and does not interpret or expose them by default.
- No arbitrary filesystem browsing, cross-Engagement sharing, model-facing raw-content tool, or new worker scheduler.
- No change to the canonical authority model that makes a Markdown file authoritative by itself.
- No requirement that raw Artifact bodies be embedded in ordinary authority snapshots, Brief, Index, Context Pack, or MCP responses; those carry metadata and manifest references only.
- No conversion of binary or non-Markdown originals into Markdown, no line-ending normalization, and no base64-wrapped copy treated as the original.

## Decisions

### 1. Bind storage to an explicit task-session registration

The host calls `artifact.session.bind` with an Engagement, task-session identifier, and a session root chosen from the host's configured workspace. Core canonicalizes the root once, verifies it is a directory under the configured Taric content root, and stores an opaque session binding. The host may instead retain an external Artifact and submit only `host_ref` metadata; Taric does not force ingestion. Subsequent calls identify the session and Artifact reference; Core derives all descendants. A process working directory, a caller-provided per-request path, or a path embedded in an Artifact reference is never used as an ambient root. The scale target is a single-host session filesystem and SQLite authority; 100G means a 100 GiB aggregate session fixture, while a single Artifact may independently exceed 64 MiB through chunking. Cross-host/object-storage placement is outside this change.

This fits the existing authenticated adapter model and avoids guessing a session path where the repository currently has none. It also makes CLI use deterministic: the operator supplies or configures the session binding once, then commands use the opaque binding. A global implicit `cwd` root was rejected because it would make path isolation and recovery dependent on process launch context.

### 2. Store by Artifact/version, not by category aggregate

Each session uses a deterministic layout:

```text
<session-root>/
  manifest.json                         # small root header and segment watermarks
  manifest/segments/00000001.ndjson     # immutable bounded manifest segments
  artifacts/<yyyy>/<mm>/<dd>/<id-prefix>/<artifact-id>/v000001/
    content.manifest.json
    payload-000001.part
    payload-000002.part
    metadata.md
  execution/<yyyy>/<mm>/<dd>/<run-prefix>/<work-run-id>/<attempt-id>/
    checkpoint-<sequence>.md
    result-<result-id>.md
    late-<result-id>.md
    segment-<sequence>.md
```

The physical unit is one Artifact version, not one category. `category` and `media_type` are catalog fields used for filtering; they are never used as a shared append-only file because a hot category would create a write lock, a giant file, and a large corruption blast radius. Artifact directories are sharded by UTC creation date and server-derived ID prefix so a session that runs for more than one week does not accumulate one enormous directory. Execution sidecars use the same UTC date partition and WorkRun prefix.

An original payload is stored byte-for-byte and split into immutable chunks of at most 64 MiB; chunk boundaries are byte offsets and do not decode, normalize, or transcode the payload. Textual payloads such as HTTP, HTML, JSON, logs, and scanner output may carry `charset` metadata, while screenshots, packet captures, uploads, and downloads retain their binary `media_type` and optional content-encoding metadata. No binary or non-Markdown payload is converted to Markdown or base64 as the stored original. A single Artifact can therefore be much larger than memory while each file remains bounded. `content.manifest.json` records `payload_kind`, media type, charset/encoding, total bytes, chunk size, chunk count, full SHA-256, per-chunk byte offsets/lengths/hashes, relative paths, and publication state. A root `manifest.json` contains only session identity, schema versions, segment names, and high-water marks. Manifest entries roll into immutable NDJSON segments at 64 MiB or 10,000 entries, whichever comes first; the root manifest is never rewritten for every Artifact.

`artifact.store` uses a three-phase bounded upload under one upload ID: begin registers the Artifact/version, payload kind/media type, expected byte scope, and task-session scope; append accepts one ordered byte chunk no larger than 64 MiB and returns the next ordinal; commit verifies total bytes, full hash, chunk hashes, and manifest before publishing the catalog row. The Core, CLI, and adapter hold at most one chunk plus bounded hashing overhead in memory. Uncommitted upload chunks are private staging files and cannot be listed, read, or included in session output. Retries of an ordinal are idempotent only when the chunk hash and payload match. A text decoder may be used by a host after retrieval, but the canonical hash and stored bytes remain the uploaded bytes.

`metadata.md` and execution sidecars contain human-readable metadata and references; raw content is kept in opaque payload chunks. High-frequency execution entries can be sealed into bounded `segment-*.md` files with catalog offsets, while checkpoint/result files remain independently addressable. Execution sidecars MUST NOT copy credentials, tokens, cookies, raw HTTP bodies, packet bytes, hidden reasoning, or full tool transcripts; those remain Artifact payloads referenced by ID. This keeps source content separate from derived Brief/Index generations and gives host output a stable association graph without requiring category-wide files or a full-session scan.

### 3. Index metadata in SQLite and keep raw reads direct

The authority adds catalog rows for `artifact_catalog`, `artifact_chunks`, and `execution_catalog`. Catalog rows contain the opaque content reference, Engagement/session, Artifact/version, payload kind, category, media type, charset/encoding, host summary reference or bounded host summary, stored time, captured time, authority sequence, WorkRun/Attempt/generation, sensitivity/status flags, total bytes, chunk count, full hash, manifest segment, and relative directory. Chunk rows contain ordinal, relative path, byte offset, byte count, and hash. Execution rows contain session, WorkRun, Attempt, generation, sequence/time, sidecar path, and hash. An external host-owned Artifact can remain represented by `host_ref` with `content_status=external`; no local payload row is created until the host explicitly stores it.

The catalog records `stored_at` UTC for physical partitioning; caller-provided `captured_at` remains queryable metadata and never controls the path. Host summaries are untrusted metadata and are bounded/hashed; Taric does not parse raw payloads, extract headers, generate summaries, or copy URL/query/header/cookie/token values into catalog, event, or audit text. Any redacted, decoded, thumbnail, or normalized representation is a new derivative Artifact linked by `derived_from` and a new hash.

The catalog uses covering indexes for `(session_id, stored_at, authority_seq)`, `(session_id, category, stored_at)`, `(session_id, artifact_id, version)`, and `(session_id, work_run_id, attempt_id, sequence)`. Summary and metadata filters query these rows; Taric never scans raw payloads to answer a list or summary query. A known content reference resolves in O(log n) catalog lookup followed by sequential reads of only its chunks. Raw body content is never added to SQLite indexes or full-text search.

Catalog metadata and its ordinary SQLite indexes are committed with the authority association. Optional manifest-segment/derived search indexes carry `index_watermark` and `index_status`; outbox/doctor can rebuild them incrementally without blocking direct reads. When an index is behind, summary queries return the lag watermark rather than silently scanning 100 GiB of payloads. A known content reference remains directly readable while an index is rebuilding.

### 4. Bound reads, pagination, and resumable output

`artifact.content.list` and `artifact.session.output` use keyset cursors bound to principal, session, filter, pinned read sequence, catalog watermark, and page size. They return at most the requested number of catalog rows and a `next_cursor`; they never return an unbounded result. `artifact.content.read` accepts either a bounded byte range or a chunk cursor and returns at most one 64 MiB chunk per response with the next cursor, full/content hash, media type, encoding metadata, and `index_watermark`. Read-time verification checks the catalog/manifest, target chunk hash, ordinal, and byte length; it does not rescan every chunk to recompute the full hash. The response reports `chunk_verified` and the full hash verified at commit; explicit doctor/verify jobs can perform a bounded full rehash. `session.output` is metadata/execution-only by default; `include_content=true` yields the same bounded opaque byte-chunk envelopes and must be resumed by cursor. A response MUST declare `max_response_bytes`, and no operation may construct a 100 GiB JSON/Markdown response.

This makes a 100G session a sequence of indexed metadata pages and direct chunk reads rather than a single JSON or Markdown assembly. CLI and Core clients can stream or persist those envelopes incrementally. The API exposes the pinned catalog watermark and integrity status so a long-running reader can detect index or file changes without restarting from the beginning.

### 5. Treat files as durable sidecars, not a second authority

For a write, Core validates the request and active lease, streams each upload chunk to a private staging file, hashes it while writing, and commits the final native payload chunks, machine manifest, and Markdown metadata sidecar with atomic renames before committing the authority metadata, event, idempotency result, and operation marker in the existing SQLite transaction. The marker records upload phase, chunk ordinals, file hashes, and catalog watermark. On restart, doctor/reconcile compares markers, manifest, catalog, and authority rows: a complete staged upload can be finalized; an incomplete upload is quarantined; a committed row with a missing/tampered file becomes `unavailable` and blocks evidence/output rather than being silently recreated. The exact filesystem/SQLite crash boundary is surfaced in the operation status.

The alternative of storing full bodies in SQLite was rejected because the requested durable format is task-session files and because it would make host inspection/output unnecessarily coupled to the authority database. The alternative of treating files as canonical was rejected because it would bypass CAS, permission, audit, and fencing checks. The alternative of forcing every payload into Markdown/base64 was rejected because it changes the raw-file representation, adds approximately one-third transfer/storage overhead, and prevents direct byte-range access for screenshots, packet captures, uploads, and downloads.

### 6. Separate explicit host/operator content operations from model reads

Register `artifact.session.bind`, `artifact.store.begin`, `artifact.store.append`, `artifact.store.commit`, `artifact.metadata`, `artifact.content.read`, `artifact.content.list`, and `artifact.session.output` in the shared operation registry. Store/bind/upload/commit mutations require authenticated host capability or an explicitly granted operator capability plus Engagement/session permission. Raw content reads require a separate `artifact.content.read` capability (session-owner host by default, operator only when explicitly granted), are bounded by byte range/chunk cursor, and are audited without body bytes. `artifact.content.list` and `artifact.session.output` are metadata/execution-only by default; only an authorized caller's explicit `include_content=true` (or CLI `--include-content`) permits raw bodies. `artifact.metadata` and the existing query/context/evidence paths may return safe typed metadata and opaque content references; session-relative locators remain host/operator-only. MCP tools remain metadata-only, and no request body can elevate a model principal.

CLI commands are thin dispatchers over these Core operations. Adapter RPC already forwards authenticated host calls through the versioned dispatch path, so it gains the same contract without a second persistence implementation. No automatic Pi transcript hook is added; a host explicitly submits the Artifact or execution record it intends to persist.

### 7. Associate execution data with existing fencing and recovery contracts

Every execution sidecar carries WorkItem, WorkRun, Attempt, generation, checkpoint/result identity, source `read_seq`, and manifest hash. Checkpoint and result writes reuse the existing active lease and generation checks. Reclaim seals the old Attempt's pending sidecars; late data is quarantined with original attribution. Resume returns the session manifest and Artifact metadata references, never raw bodies by default. This extends current collaboration state without creating a second task lifecycle.

### 8. Keep snapshot and projection boundaries explicit

`snapshot.export` includes Artifact references and content manifest metadata only; a separate explicit session/content output operation serves raw bytes. Brief/Index and Context Pack include only their existing allowlisted metadata. This avoids accidental body leakage through existing export and model channels while still letting an authorized host produce a complete task-session output by reference and explicit content operation.

## Risks / Trade-offs

- **[Filesystem/SQLite crash window]** A process can stop between file rename and authority commit or the reverse. → Use operation markers, staged names, atomic rename, fsync where supported, startup doctor/reconcile, and explicit `pending`/`unavailable` states; never claim content availability from a lone file.
- **[No retention policy]** Stored originals can accumulate and may contain sensitive data. → The requested scope deliberately leaves retention and redaction to a later policy change; expose storage status and ownership clearly, but do not silently delete or transform content.
- **[Opaque sensitive payloads]** A Taric session spool is not a credential vault. → The host must choose whether to upload, protect the session root with its own ACL/encrypted volume, and remove content under its lifecycle policy; Taric supplies scoped capability, integrity, and audit metadata but no key management or secret lifecycle.
- **[Large payload bodies]** A session may exceed 100G or run for more than one week. → Use 64 MiB immutable byte chunks, UTC date/ID sharding, bounded manifest segments, catalog indexes, keyset cursors, and chunked output. Scale behavior is a release-gated contract, not an optional optimization.
- **[Index lag or rebuild]** A secondary index can lag after a crash or rebuild. → Keep catalog primary lookup and direct reference reads available, expose `index_watermark/index_status`, rebuild incrementally from catalog/manifest segments, and never fall back to a full raw-data scan.
- **[Path and symlink attacks]** A session root or derived filename could escape its directory. → Canonicalize the registered root, reject traversal and symlink escapes, derive all descendants from server IDs, and recheck containment before read/write.
- **[Corrupt or manually edited files]** Human inspection may alter a payload or sidecar. → Verify the target chunk and manifest on each read, report integrity failure, preserve the authority record, and use an explicit bounded full-rehash/repair operation rather than silently accepting edits.
- **[Behavioral break]** Existing consumers assume Artifact bodies never exist in Taric. → Update capability registry, compatibility diagnostics, docs, and tests to split supported content storage from unsupported redaction/retention while keeping model/projection exclusions.

## Migration Plan

1. Add the Artifact content/session schemas, operation contracts, supported capability entries, and split non-goals for redaction and retention.
2. Add the session binding, sharded/chunked sidecar layout, bounded manifest segments, catalog tables/indexes, hash validation, atomic publication markers, and doctor/reconcile behavior; keep existing authorities usable when no session is bound.
3. Add Core service dispatch and authorization, then expose the same operations through CLI and authenticated adapter RPC. Implement keyset pagination, chunk/range cursors, index watermarks, and bounded session output.
4. Extend WorkRun/Attempt/checkpoint/result associations and resume metadata; add incremental catalog/manifest backfill and index rebuild without raw scans.
5. Update model/context/projection/snapshot filters and documentation; add migration fixtures that prove existing metadata-only reads remain body-free.
6. Run schema, Core, CLI, MCP, adapter, projection, collaboration, crash-recovery, resumable-upload, one-week partition, 100G fixture, query-plan, memory-bound, and clean-build tests. A failure leaves the change unapplied; no legacy Artifact body format is imported because backward compatibility is explicitly out of scope.

## Open Questions

None. The host-bound session registration, native payload plus Markdown sidecar layout, authority/sidecar split, privilege boundary, and out-of-scope policy decisions are fixed by the proposal and specifications.
