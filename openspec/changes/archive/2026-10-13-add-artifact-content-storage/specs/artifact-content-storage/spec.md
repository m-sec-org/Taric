# Spec Delta

## Purpose

Provides an optional, host-authorized task-session spool for exact textual and binary penetration-test Artifact bytes, with Markdown metadata and execution sidecars, indexed reference retrieval, and no default exposure to models or authority projections.

## ADDED Requirements

### Requirement: Preserve Artifact originals as opaque immutable payloads

An authenticated host or operator SHALL be able to persist an Artifact's exact original bytes in the task session bound to the current Engagement and, when supplied, WorkRun/Attempt. Taric SHALL derive the storage location from the registered session binding and server-owned Artifact/version identity; callers MUST NOT select an arbitrary filesystem path. A host MAY keep an Artifact external and submit only an opaque `host_ref` with `content_status=external`; session storage is opt-in and does not automatically fetch host content.

The Artifact contract SHALL support textual and binary payloads, including HTTP request/response bytes, page/source/API bodies, screenshots, logs, packet captures, scanner output, uploaded/downloaded files, archives, and raw records that may contain credentials, tokens, cookies, session material, or keys. Metadata SHALL include payload kind, media type, optional `charset`, `content_encoding`, and `transfer_encoding`, byte length, exact-byte SHA-256, provenance, captured/stored times, a host summary reference or bounded untrusted host summary, storage mode (`external|taric_stored`), content status (`external|staged|available|unavailable|integrity_failed|quarantined|deleted`), and optional `derived_from`. Taric SHALL treat the payload as opaque untrusted data: it MUST NOT parse, execute, inject, decrypt, redact, classify, or copy its sensitive values into authority, audit, summary, or model fields. A redacted, decoded, thumbnail, or normalized representation is a new derivative Artifact with a new hash.

Composite captures MAY be represented by a manifest Artifact with child Artifact references, such as separate HTTP request and response payloads, a scanner run with multiple output files, or a packet capture with indexed segments. Child references MUST belong to the same authorized Engagement/session and MUST NOT form cycles. Child references remain independently addressable; the composite manifest is metadata and does not require concatenating all bytes into one payload.

#### Scenario: Store an original textual or binary Artifact

- **WHEN** an authorized host submits an Artifact reference, media metadata, exact payload bytes, and an active task-session binding
- **THEN** Taric stores the byte-preserving payload, records the server-verified byte length and hash, and returns an opaque content reference without exposing an arbitrary path

#### Scenario: Keep an Artifact external

- **WHEN** a host submits only a valid external `host_ref` and summary metadata
- **THEN** Taric records `content_status=external` and does not create, fetch, or infer a local payload

#### Scenario: Reject an invalid content write

- **WHEN** a caller submits a cross-Engagement reference, caller-selected path, stale WorkRun/Attempt generation, mismatched byte length/hash, or unsupported payload metadata
- **THEN** Taric rejects the operation with a structured validation, isolation, or stale-generation error and publishes no readable Artifact content

#### Scenario: Relate a composite capture

- **WHEN** an authorized host submits a composite manifest linking request/response, scanner, or file child Artifacts
- **THEN** Taric stores the manifest and child references without duplicating or concatenating child payload bytes, and each child remains independently retrievable

### Requirement: Use bounded immutable files and session sharding

Taric SHALL store each Artifact version in its own immutable directory sharded by server `stored_at` UTC date and a server-derived Artifact ID prefix. Artifact category, source tool, and media type SHALL remain metadata fields and MUST NOT select a shared append-only file. A payload SHALL be split at byte boundaries into chunks no larger than 64 MiB; its machine JSON manifest SHALL record payload kind, media type, charset, content encoding, transfer encoding, total bytes, chunk count, full hash, and every chunk's ordinal, byte offset, byte count, hash, and relative path. Markdown is used for human-readable metadata and execution sidecars; JSON/NDJSON is used for machine manifests and catalog segments; raw payload chunks retain their native bytes and are not converted to Markdown or base64 as the stored original.

Task execution sidecars SHALL use the same date/ID sharding. High-frequency entries MAY be sealed into bounded Markdown/NDJSON segments with catalog offsets, while checkpoints and results remain independently addressable. Session root manifests SHALL remain bounded by referencing immutable manifest segments rather than rewriting one entry for every Artifact.

#### Scenario: Store Artifacts from one category

- **WHEN** two large Artifacts share a category or media type
- **THEN** Taric stores them under separate server-derived Artifact/version paths, and category filtering remains metadata-only without a shared category file or lock

#### Scenario: Store a payload larger than one chunk

- **WHEN** an authorized host stores a textual or binary payload larger than the configured chunk size
- **THEN** Taric writes multiple bounded native-byte chunks, records per-chunk and full-content hashes, and makes the Artifact available only after its complete manifest is committed

#### Scenario: Append execution data for a long-running task

- **WHEN** a task session runs across multiple UTC dates or produces many execution entries
- **THEN** Taric rolls entries into bounded date/ID-sharded sidecars or immutable segments and keeps old entries addressable without rewriting a single growing file

### Requirement: Ingest large originals through resumable byte uploads

Large payloads SHALL be ingested through `begin`/`append`/`commit` under an upload ID. Each append SHALL accept one ordered bounded byte chunk and return the next ordinal; JSON/RPC/CLI base64 is transport encoding only and MUST be decoded before byte length and hash verification. `max_response_bytes` and chunk limits SHALL be measured on decoded payload bytes, with a separate bounded transport-envelope limit. The canonical hash and stored bytes SHALL be the uploaded payload bytes, not a decoded text, decompressed body, normalized line ending, or transport envelope. Uncommitted staging chunks SHALL be private and invisible to metadata lists, reads, Evidence, and session output. Retries of an ordinal are idempotent only when ordinal, byte length, and chunk hash match.

#### Scenario: Upload a large original incrementally

- **WHEN** an authorized host begins an upload and appends ordered chunks within the configured per-chunk and response bounds
- **THEN** Taric stores only private staging chunks until commit, returns the next chunk ordinal, and keeps the incomplete Artifact invisible to list, read, Evidence, and session output

#### Scenario: Commit a complete upload

- **WHEN** an authorized host commits an ordered upload with matching total bytes, per-chunk hashes, and full-content hash
- **THEN** Taric atomically publishes the immutable payload chunks, content manifest, catalog row, and authority association

### Requirement: Maintain an indexed catalog independent of raw content

Taric SHALL maintain an Engagement- and session-scoped catalog for Artifact metadata, chunk locations, and execution entries. The catalog SHALL index at least session plus stored time/authority sequence, session plus category/time, session plus Artifact/version, and session plus WorkRun/Attempt/sequence. Summary filters SHALL use bounded typed metadata or host-provided summary references; Taric MUST NOT scan raw payloads, parse arbitrary summaries, or full-text index original bytes. Catalog rows required for direct reference lookup SHALL become available atomically with the authority association; derived indexes MAY lag and SHALL expose `index_watermark`, `index_status`, and lag information for incremental rebuild and doctor/reconcile.

#### Scenario: Lookup a known reference in a large session

- **WHEN** an authorized host reads a known Artifact reference in a session containing at least 100 GiB of stored originals
- **THEN** Taric resolves the catalog row and opens only the referenced manifest/chunks without scanning unrelated payloads, category files, or the root manifest

#### Scenario: Query while a derived index is rebuilding

- **WHEN** a summary or category index is behind the current catalog watermark
- **THEN** Taric reports the index status/watermark and either returns indexed results or an explicit lag response, while direct reads by known reference remain available and no raw-data fallback scan occurs

#### Scenario: Incrementally repair a long session

- **WHEN** doctor/reconcile repairs a missing catalog index or manifest segment for a session running longer than one week
- **THEN** it processes bounded segments and watermarks incrementally, preserves direct reads, and reports the repaired range without holding one transaction over the complete raw-data set

### Requirement: Resolve and output content by reference with bounded cursors

An authorized host or operator SHALL be able to list Artifact metadata, resolve an Artifact by reference or typed summary metadata, read its original bytes, and request task-session output correlating execution records with referenced Artifacts. `artifact.content.list` and `artifact.session.output` SHALL use a keyset cursor bound to principal, session, filters, pinned read sequence, catalog watermark, and page size; they SHALL return bounded pages and `next_cursor`. `artifact.content.read` SHALL use a byte range or chunk cursor and SHALL return at most one configured chunk per response with `next_cursor`, media metadata, full hash, `max_response_bytes`, and integrity status. List/output SHALL be metadata/execution-only by default; raw bytes require explicit `include_content=true` and remain bounded/resumable. No operation SHALL accept an arbitrary path or assemble an unbounded 100 GiB response.

Read-time integrity checks SHALL validate catalog/manifest agreement, target chunk hash, ordinal, and byte length without rescanning every chunk to recompute a full hash. The response SHALL distinguish target `chunk_verified` from the full hash verified at commit; explicit doctor/verify jobs MAY perform a bounded full rehash.

#### Scenario: Read an Artifact by reference

- **WHEN** an authorized host requests a stored Artifact using its opaque reference and a bounded range or chunk cursor
- **THEN** Taric returns the requested original bytes with media metadata, byte range, hash/integrity status, and a continuation cursor when more content remains

#### Scenario: Produce a correlated task-session output

- **WHEN** an authorized host requests output for a task session with selected Artifact references or typed summary filters
- **THEN** Taric returns a bounded page of execution records and matching Artifact metadata in deterministic association order; it returns bounded payload chunks only when `include_content=true`, and marks missing or corrupt content unavailable

#### Scenario: Read a 100 GiB session incrementally

- **WHEN** an authorized caller requests output for a session whose originals exceed 100 GiB
- **THEN** Taric returns bounded catalog pages and chunk cursors with a pinned watermark, never concatenates the session into one response, and permits the caller to resume without restarting the scan

#### Scenario: Deny an unscoped content read

- **WHEN** a model client, unauthorized principal, cross-Engagement caller, or arbitrary-path request asks for raw Artifact bytes
- **THEN** Taric denies the read without disclosing protected body, path, or existence details

### Requirement: Keep raw payloads and sensitive metadata out of default views

Context, query, MCP, Brief, Index, snapshot, and other default model-facing outputs SHALL expose only opaque Artifact references, payload kind/media type, byte length, exact hash, captured/stored time, source/association metadata, integrity/status, and host-approved safe summary fields. Host summaries, locations, URLs, query strings, headers, cookies, tokens, and source-tool free text SHALL be treated as untrusted and remain host-only unless explicitly allowlisted as model-safe. Default views MUST NOT include raw payload bytes, local paths, host refs that reveal storage, execution sidecar bodies, or sensitive summary text. Raw retrieval SHALL require an explicit host/operator content capability and SHALL be audited without writing payload bytes to the audit event.

#### Scenario: Build model context with sensitive stored content

- **WHEN** an Artifact contains a screenshot, packet capture, HTTP exchange, scanner output, or credential-bearing bytes and a model client requests context or evidence metadata
- **THEN** the response contains only the approved opaque reference and safe metadata, with no payload bytes, local path, credential, token, cookie, or unapproved summary

#### Scenario: Host explicitly requests content

- **WHEN** an authenticated host with content-read capability invokes the explicit bounded content-read operation for an authorized Artifact
- **THEN** Taric returns the requested bytes and writes only reference, range, hash, and integrity metadata to the audit event

### Requirement: Maintain integrity, idempotency, and session isolation

Payload publication and its authority manifest/association SHALL use the existing operation-id/idempotency and audit mechanisms. A successful write MUST expose both the verified payload and committed metadata; a failed or interrupted write MUST expose neither as available content and MUST leave a recoverable operation marker. Every payload and execution record SHALL belong to exactly one Engagement and registered task session. Missing, deleted, tampered, or unreadable files SHALL return structured `unavailable`/`integrity_failed` status and SHALL not be treated as available Evidence. Taric SHALL not silently recreate or delete payloads when a host changes the session filesystem; retention and deletion remain explicit host/operator actions.

#### Scenario: Retry a content write

- **WHEN** a host retries the same content write with the same idempotency key and normalized upload metadata
- **THEN** Taric returns the original content reference and does not create a second payload or execution association

#### Scenario: Detect file tampering

- **WHEN** a stored payload chunk differs from its manifest hash or the session manifest is incomplete
- **THEN** Taric reports an integrity failure, excludes the payload from Evidence/output, and preserves the authority audit state for repair

#### Scenario: Isolate two task sessions

- **WHEN** a caller uses a valid Artifact reference or path-derived locator from another Engagement or task session
- **THEN** Taric rejects the read or association without revealing the other session's content or metadata
