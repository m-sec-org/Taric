# Tasks

## 1. Contracts and capability registry

- [ ] 1.1 Add Artifact content, resumable byte upload, payload-kind/media metadata, external/session storage mode, task-session binding, bounded chunk, manifest segment, execution-sidecar, integrity-status, cursor, watermark, composite child references, and correlated-output schemas while preserving server-owned IDs and engagement ownership; verify schema fixtures reject missing scope, arbitrary paths, cross-Engagement references, oversized chunks, mismatched hashes, and hidden reasoning fields.
- [ ] 1.2 Extend `ArtifactReference` and related Evidence/WorkRun/Attempt/Checkpoint contracts with content/session metadata without embedding raw bodies in authority records; verify existing metadata-only records still validate and snapshot fixtures contain no body bytes.
- [ ] 1.3 Register `artifact.session.bind`, `artifact.store.begin`, `artifact.store.append`, `artifact.store.commit`, `artifact.metadata`, `artifact.content.read`, `artifact.content.list`, and `artifact.session.output` with host/operator roles, a separately grantable raw-content read capability, idempotency, stable errors, and engagement scope; split supported content storage from unsupported redaction, secret scanning, credential lifecycle, and retention capabilities and verify diagnostics expose the same registry.

## 2. Task-session payload store and Markdown sidecars

- [ ] 2.1 Implement explicit authenticated task-session binding and configured-root containment checks; verify traversal, symlink escape, arbitrary per-request paths, cross-Engagement roots, and unregistered sessions are rejected.
- [ ] 2.2 Implement the deterministic UTC date/ID-sharded session layout, server-derived filenames, exact-byte immutable Artifact versions, 64 MiB native payload chunks, bounded manifest segments, Markdown metadata/manifest sidecars, execution sidecars/segments, and raw-byte hashes; verify textual, binary, and composite Artifacts can be located only through opaque references.
- [ ] 2.3 Implement begin/append/commit resumable uploads with ordered chunk hashes and private staging visibility; verify an incomplete or mismatched upload cannot appear in list/read/output and a retry of a matching ordinal is idempotent.
- [ ] 2.4 Implement staged writes, flush/atomic rename, manifest publication state, and operation markers coordinated with the existing SQLite transaction; verify injected failures expose neither an available body nor committed association and leave a recoverable marker.
- [ ] 2.5 Add content-store unit tests for exact binary/text byte round trips, transport base64 decode, wire-byte hashing, duplicate/idempotent writes, version changes, derived Artifact links, missing files, corrupt files, partial manifests, incremental segments, and deterministic ordering; verify all failures return structured unavailable/integrity errors.

## 3. Core service and authority integration

- [ ] 3.1 Add Core service dispatch and authorization for session bind/store/metadata/list/read/output, using transport-verified host/operator capabilities and Engagement/session permissions; verify model principals and self-asserted roles cannot read or write bodies.
- [ ] 3.2 Persist content manifest rows, Artifact associations, execution metadata, audit events, outbox entries, and idempotency results in the existing authority; verify retries return the original reference and a changed payload returns an idempotency conflict.
- [ ] 3.3 Add `artifact_catalog`, `artifact_chunks`, and `execution_catalog` rows plus covering indexes and catalog/index watermarks; verify `EXPLAIN QUERY PLAN` uses session/reference/category/WorkRun indexes and no list or summary query scans raw payload or sidecar files.
- [ ] 3.4 Associate content and execution writes with WorkItem, WorkRun, Attempt, checkpoint/result IDs, read sequence, owner, and fencing generation; verify stale leases, reclaimed runs, cross-session references, and late results are rejected or quarantined.
- [ ] 3.5 Add Core tests for authorized reference/summary lookup, direct chunk reads, keyset pagination, explicit raw content reads, metadata-only default session output, bounded `include_content=true` output, missing/corrupt content, cross-Engagement isolation, and audit read events; verify output marks unavailable content and never falls back to arbitrary paths.

## 4. Collaboration and recovery integration

- [ ] 4.1 Bind WorkRun/Attempt creation and resume packets to a registered task session and expose session manifest plus Artifact metadata references; verify resume never includes raw bodies by default and invalid session bindings block continuation.
- [ ] 4.2 Extend checkpoint, ActionIntent, host decision/result, reconciliation, and error persistence to create execution sidecars with explicit empty lists, Artifact refs, and no raw HTTP/body/packet/credential/token/cookie or hidden reasoning fields; verify checkpoint contract and sidecar hashes agree.
- [ ] 4.3 Quarantine or seal old-generation execution sidecars during reclaim and late-result handling; verify stale writes cannot become current observations or overwrite a new Attempt.
- [ ] 4.4 Extend doctor/reconcile to compare authority markers, manifests, hashes, and files and to report pending/unavailable/integrity states without silently recreating or deleting content; verify crash-recovery tests cover both file-before-DB and DB-before-file boundaries.
- [ ] 4.5 Add incremental catalog/manifest-segment backfill and index rebuild from watermarks; verify rebuild runs in bounded batches, does not hold a full-session transaction, and known-reference reads continue while indexes lag.

## 5. Model, projection, and snapshot boundaries

- [ ] 5.1 Update Context Pack, query, evidence, and model-field filters to allow only opaque Artifact references, safe typed payload metadata, hashes, provenance, and integrity metadata; verify canary credentials/cookies in payload, summary, URL, headers, and locations are absent from model responses and host-only locators are not exposed.
- [ ] 5.2 Keep Brief/Index generation separate from raw task-session files and include only approved Artifact metadata; verify projection generations, manifest hashes, local Git checkpoints, and reader-pinned generations never contain raw body text.
- [ ] 5.3 Keep authority snapshot export/import behavior metadata-only for Artifact content and include explicit manifest references/status; verify exports do not leak raw text, binary bytes, local paths, or sensitive host summaries and corrupt source files are reported rather than embedded.
- [ ] 5.4 Add projection, context, snapshot, and poisoning tests that distinguish authorized host content reads from forbidden model/projection exposure; verify permission and integrity failures do not disclose paths or bodies.

## 6. CLI and authenticated adapter surface

- [ ] 6.1 Add thin CLI commands for session bind, store begin/append/commit, metadata, content read/list, and session output with JSON input/output and stable nonzero errors; verify list/output stay metadata-only unless authorized `--include-content` is supplied, commands require bounded page/range arguments, reject arbitrary paths, and match Core responses.
- [ ] 6.2 Expose the same operations through authenticated adapter/Core RPC and update capability/status manifests; verify host identity, token, Engagement permission, and task-session binding are checked before file access.
- [ ] 6.3 Add CLI and adapter contract tests for successful round trips, unauthorized reads, stale generation, idempotent retries, unavailable files, and correlated output; verify no second policy implementation diverges from Core.

## 7. Documentation and compatibility updates

- [ ] 7.1 Update package/API documentation and capability diagnostics to state that the host may keep external references or explicitly authorize Taric's opaque textual/binary session spool; redaction, retention, credential lifecycle, HITL identity, and target execution remain outside scope; verify examples use explicit host/operator operations.
- [ ] 7.2 Update `README.MD`/`readme.md`, `docs/taric-api.md`, `docs/taric-design.md`, `docs/agent-integration.md`, `docs/multi-host-authority-runbook.md`, `packages/schemas/src/registry.ts`, compatibility diagnostics, and the affected main OpenSpec specs (`engagement-memory`, `taric-runtime-api`, `authority-storage`, and `markdown-projection`) so the old “Taric never stores bodies”/permanent Artifact non-goal is replaced by external reference plus opt-in session spool; verify no unsupported capability message or normative document contradicts the new registry.
- [ ] 7.3 Document the task-session root binding, native payload plus Markdown sidecar layout, manifest/integrity statuses, sensitive-content boundary, recovery behavior, and operator/host API/CLI examples; verify each documented command runs against a clean temporary session.

## 8. End-to-end release verification

- [ ] 8.1 Run schema, Core, collaboration, CLI, MCP, adapter, projection, and recovery suites from a clean build; verify all existing non-Artifact capabilities remain green and the MCP tool list contains no raw-content operation.
- [ ] 8.2 Run multi-Engagement/session isolation, fencing, idempotency, tamper, crash-injection, and permission-bypass tests; verify zero body leakage in model/projection/snapshot paths and no partial successful writes.
- [ ] 8.3 Run scale verification with a synthetic stream and a 100G aggregate fixture: assert bounded ingest/read memory, UTC partitioning across more than seven days, O(1)-target chunk reads, keyset pagination, catalog-index query plans, no raw/manifest full scans, and resumable output; verify the test can run without materializing 100G in a single process response.
- [ ] 8.4 Produce a change-local implementation report listing supported content operations, explicit redaction/retention non-goals, integrity/recovery evidence, scale/index watermarks, and any follow-up limits; verify the report matches the final capability registry and task-session contract.
