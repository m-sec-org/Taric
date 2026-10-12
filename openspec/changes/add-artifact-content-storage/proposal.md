# Proposal

## Why

Taric currently persists Artifact references and execution metadata but deliberately leaves Artifact bodies in the host application. In a penetration test, an Artifact is the original evidence produced by a tool or worker: a complete HTTP exchange, source or JSON response, screenshot, log, packet capture, scanner output, uploaded/downloaded file, or a record that may contain credentials, tokens, or cookies. Without a durable original, Taric cannot reliably reconstruct a task session, verify a Finding against its source bytes, recover a long-running task, or let the host produce a complete output from one reference. Taric should persist those originals as an opaque task-session content store while keeping model-facing views limited to references and metadata by default.

## What Changes

- Add a Taric-owned task-session content store that writes immutable Artifact originals as byte-preserving payload files under the current task session path; use Markdown sidecars for metadata, manifests, and human-readable execution records.
- Support both textual and binary Artifact payloads, including complete HTTP requests/responses, page/source/JSON bodies, screenshots, logs, packet captures, scanner output, uploaded/downloaded files, and raw records that contain credential, token, or cookie material.
- Represent compound captures as a manifest Artifact with independently addressable child Artifacts, so an HTTP request/response pair, scanner run, or packet capture does not need to be concatenated into one opaque response.
- Treat every raw payload as untrusted and sensitive by default. Store it opaquely, verify it by exact-byte hash, and require explicit authenticated host/operator content capability for retrieval; never interpret it as a credential, executable instruction, or model context.
- Store each Artifact version in its own immutable, date- and ID-sharded directory; categories and media types remain queryable metadata and are not appended into one category-sized file.
- Chunk an individual large text or binary Artifact into bounded payload files and maintain compact manifest segments so a session can exceed one week of execution or 100G of originals without one giant file or manifest rewrite.
- Ingest large originals through bounded, ordered byte-chunk uploads with resumable upload state; never require the Core, CLI, or adapter to materialize the complete body in memory.
- Maintain a SQLite-backed Artifact catalog and execution index over references, typed metadata, dates, categories, WorkRun/Attempt, chunk manifests, and integrity watermarks; raw content reads resolve directly from catalog rows and do not scan payloads.
- Provide keyset pagination, bounded chunk/range reads, and resumable session output so list, lookup, and output operations never assemble a 100G response in memory.
- Persist the task execution record needed to associate WorkItem, WorkRun, Attempt, checkpoint, tool/result metadata, and Artifact references with the same task session.
- Extend the Core API with authorized session bind, resumable Artifact upload (`begin`/`append`/`commit`), lookup, association, and output operations; expose the same operations through the CLI and authenticated Core/host adapter calls.
- Allow authorized hosts to resolve an Artifact by reference or summary metadata and retrieve the original bytes or a composed task-session output, with bounded streaming for large content.
- Keep Artifact reference, opaque content reference, byte hash, provenance, storage status, and permission metadata in the authority record so content reads can be verified and audited; host/session locators remain host/operator-only.
- Keep default model-facing context, query, MCP, and projection responses limited to Artifact references and metadata; raw Artifact content requires an explicit authorized host operation.
- Make content writes and task-session associations scoped to one Engagement and current WorkRun/Attempt where applicable, with fencing, idempotency, integrity checks, and audit events.
- **BREAKING** Replace the current contract that Taric never stores Artifact bodies. This change does not add automatic redaction, secret scanning, credential lifecycle management, decryption, or retention-expiry behavior; raw content remains opaque and requires explicit host/operator authorization.

The task-session format deliberately has two layers: Markdown metadata/execution sidecars and machine JSON/NDJSON manifests/catalog segments, plus native byte-preserving payload chunks. Forcing screenshots, packet captures, uploads, and downloads into Markdown/base64 would change the raw-file representation, add storage/transfer overhead, and weaken bounded byte-range retrieval; therefore “Markdown storage” applies to metadata and execution records, while Artifact originals remain exact payload bytes.

## Capabilities

### New Capabilities

- `artifact-content-storage`: Persist byte-preserving textual/binary Artifact originals plus Markdown metadata/execution sidecars, maintain integrity and association metadata, and provide authorized reference/summary-based retrieval and output.

### Modified Capabilities

- `engagement-memory`: Artifact records change from host-only references to references with optional Taric-persisted opaque original payloads and verified content metadata; default ordinary recall remains metadata-only and no raw payload is promoted to a memory fact.
- `collaboration-state`: WorkRun/Attempt/checkpoint execution data must associate with the task-session Artifact store and preserve fenced, auditable content references and result attachments.
- `taric-runtime-api`: Add authenticated Core, CLI, and host-callable operations for Artifact content storage, association, retrieval, and task-session output while preserving model/host/operator privilege separation.
- `markdown-projection`: Define the boundary between task-session Markdown source files and model-safe/human projection output; default model-facing projection continues to expose only references and metadata.

## Impact

- `packages/schemas`: Artifact payload kind/media type/encoding metadata, task-session manifests, resumable byte-upload contracts, API contracts, capability registry, and validation rules.
- `packages/core`: session-path resolution, byte-preserving payload persistence, Markdown metadata/execution sidecars, content hashing, atomic writes, association indexes, authorized reads/outputs, audit/outbox integration, and WorkRun/Attempt fencing.
- `packages/cli` and `packages/mcp`: host/operator commands and model-safe response filtering; MCP must not expose raw content retrieval as a model tool.
- `packages/core/test`, `packages/cli/test`, and `packages/mcp/test`: isolation, integrity, failure recovery, authorization, idempotency, fencing, and output-contract coverage.
- Documentation and capability manifests: update the Artifact ownership boundary and distinguish opaque raw-content storage from credential management, redaction, secret scanning, and retention policies, all of which remain out of scope.
- Scale and operations: add catalog/index watermarks, incremental rebuild/doctor behavior, long-session date partitioning, and benchmark evidence for 100G-class fixtures.
- Input boundary: this change stores the original payload bytes for text and binary Artifacts. Transport encoding (such as bounded base64 or a streamed file input) is decoded before hashing and storage; encoded transport data is never stored as the original.
- No new package dependency is required; use the existing TypeScript/Node.js filesystem, SQLite, schema, and API layers.
