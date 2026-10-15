# Multi-host authority runbook

PostgreSQL and SQLite share the complete asynchronous Core governance implementation. The supported PostgreSQL capability has `implementation_state=available` and `evidence_state=verified`; it remains `runtime_state=disabled` in the default single-host configuration. Explicit multi-host activation requires matching live conformance evidence and current schema/lease health. The default `single_host_sqlite` profile does not load the PostgreSQL driver or contact a PostgreSQL service.

An operator can inspect the deployed schema with `PostgresAuthorityStore.runtimeReadiness(report?)`. This read-only probe reports schema/sequence/lease health and the required runtime method/table/column inventory. It neither migrates the schema nor opens SQLite. Without full scenario evidence, or after any structural/health mismatch, it reports disabled. [PostgreSQL runtime readiness](postgres-runtime-readiness.md) describes the shared unit of work, verification commands and activation report.

## Supported boundary

- Every Taric host in one shared deployment connects to the same PostgreSQL authority service and compatible schema version.
- PostgreSQL transactions, constraints, sequences, lease expiry, and fencing generation are the source of shared ordering.
- SQLite is local single-host authority only. A shared SQLite file, NFS lock, independent SQLite replicas, or shared Git clone is not a shared authority.
- Markdown and Git are derived projections. They do not coordinate writers, leases, event ordering, or recovery.
- PostgreSQL stores Taric authority state. Artifact bodies may remain external or be explicitly stored in a host-bound Taric task-session spool. The spool is local to the host/session root configured for the Core instance; it is not coordinated by PostgreSQL, and shared hosts must provide their own durable, isolated spool roots and backup procedure. Credentials remain opaque payload bytes and are never interpreted or exposed by default.

## Enablement checklist

1. Confirm the target needs multiple hosts writing the same authority. If it does not, use the default SQLite profile.
2. Provision one PostgreSQL service inside the deployment's trusted network, apply the supported schema migrations, and restrict credentials to the Taric service role.
3. Configure the explicit `multi_host_authority` profile on every host with the same PostgreSQL service. Do not fall back to SQLite if service configuration or health checks fail.
4. Run storage and full Core runtime conformance against the release candidate in a disposable database/schema. `AUTHORITY_BACKEND_METHODS` defines the asynchronous persistence facade. Required scenarios are proposal, review, L1 admission, L2 promotion, checkpoint, action, Artifact, lease, fencing, audit/outbox, pinned read and backup/restore. `scripts/verify-postgres-runtime.mjs` records actual outcomes and creates an activation report bound to the compiled Core, schema and policy digests. Missing methods, absent scenarios or semantic mismatches fail the gate.
5. Create a verified backup and restore it into a temporary target. Confirm schema version, source and target sequences, integrity hash, Engagement identity, provenance, revision metadata, and unresolved errors.
6. Generate `buildSharedAuthorityReleaseEvidence` with storage, `runtime_conformance` and verified restore metadata. For logical imports, retain both the source snapshot sequence and new target audit sequence, with the import audit binding the source sequence/hash. Set `TARIC_RUNTIME_CONFORMANCE` to the verified report path and select the multi-host profile. `openRuntimeService`, used by CLI and MCP, verifies the implementation/schema/policy binding and actual deployed health before construction; the shared factory checks health again before dispatch. No fallback SQLite factory exists.
7. Start hosts and inspect diagnostics for the selected backend, schema and policy digests, host count, server-fenced lease mode, and enabled state. Verify every host resolves to the same authority service.

## Artifact spool in a shared deployment

Artifact APIs use the same Engagement/session authorization on every host, but PostgreSQL does not store or coordinate payload bytes. Before enabling a host, bind each task session to a root beneath that host's configured content root. A host may instead submit an external `host_ref`; Taric never fetches it. Do not point two hosts at the same writable spool unless the deployment has an independently tested filesystem and locking design; a shared PostgreSQL authority alone does not make file publication atomic.

The host/operator sequence is `artifact.session.bind` → `artifact.store.begin` → ordered `artifact.store.append` (base64 transport, at most 64 MiB decoded per chunk) → `artifact.store.commit`. Committed files use UTC date and server-derived ID sharding, native payload chunks, a JSON hash manifest, and a Markdown metadata sidecar. `artifact.content.list` and `artifact.session.output` are bounded metadata pages. `artifact.content.read` requires the separate `content_read` capability and returns at most one bounded chunk with a continuation cursor. MCP and ordinary model context never read payload bytes.

Coordinate PostgreSQL backups with the corresponding host spool backup. Artifact publication uses staged files and authority publication markers; restart and doctor/reconcile compare markers, manifests, hashes, and catalog rows in bounded batches. Reads fail closed when a manifest/chunk is missing or its hash differs, and reconciliation reports unavailable/integrity states without silently deleting or recreating files. Execution sidecars and WorkRun-fenced session output are bounded and remain scoped to the registered task session. A shared PostgreSQL authority does not make two writable host spool roots safe; use one bound root per host unless filesystem locking has been independently verified.

The `local_process_crash` Artifact profile keeps the 64 MiB decoded chunk limit, bounds base64 plus JSON metadata separately, and uses staging copies, atomic rename and verified publication markers. It performs no explicit fsync and does not advertise power-loss durability. A power-loss profile would require payload/manifest file sync, directory sync before/after rename and coordinated database durability; those costs must be measured on the selected filesystem before advertising such a profile. Run `node scripts/benchmark-artifacts.mjs --bytes 67108864 --concurrency 2` to measure textual and binary decode/copy/publication peak RSS, transport bytes, throughput, latency and source sequence. Uploads remain concurrently in progress; synchronous publication phases run serially in one process. Run `node --test packages/core/test/artifact-durability.test.mjs` for crash-boundary integrity evidence. Neither benchmark establishes power-loss recovery.

## Migration from SQLite

1. Schedule a write freeze and stop every process using the old SQLite authority. Do not copy a live SQLite database between hosts.
2. Export the supported Taric-native snapshot at a pinned authority sequence and retain the source database read-only for rollback.
3. Provision a temporary PostgreSQL target and import the snapshot there. Validate record references, Engagement ownership, display ID uniqueness, revisions, audit integrity, and recovered sequence before switching traffic.
4. Run conformance and a read-only verification against the imported target. Reissue server-side leases; do not resume old host leases or attempt generations.
5. Point all hosts at the same PostgreSQL service and verify backend diagnostics before allowing writes.
6. Keep the old SQLite authority frozen until the new deployment passes its operational observation window. Rollback means restoring the matching frozen SQLite snapshot and fencing PostgreSQL writers; never merge independent histories.

## Backup, restore, and recovery

Taric-native JSON/JSONL is a logical, sanitized Engagement migration format. It preserves canonical IDs, display aliases and record versions, and records a new target audit baseline; it does not transplant every prior event or active lease, or include Artifact payloads. Import reports source and target sequences separately. Database recovery can use [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) into a separate database. These tools perform a logical database dump/restore, not a physical base backup. Verify the restored authority and spool before switching traffic, then reissue leases.

- Take database backups using the selected backup procedure and record UTC timestamp, schema version, source authority sequence, integrity metadata, and Engagement coverage.
- Test restores into an isolated temporary destination. A restore must validate completely before the destination is switched; failed imports must leave the destination unchanged.
- After database restore, compare the recovered sequence and audit chain. For native Engagement import, verify the `snapshot.import` event binds the source sequence/hash and distinguish its new target sequence. Verify references/revisions and report unresolved errors. Keep writes blocked when integrity or schema checks fail.
- Treat all leases as expired after restore. Hosts must obtain new server-side lease generations before submitting run-scoped writes.
- Reconcile projections from committed authority state. Never replay external actions automatically; unresolved action results require host/operator reconciliation.

## Failure handling

- If PostgreSQL is unavailable, block multi-host authority writes and report an unavailable/blocked diagnostic. Do not open a local SQLite fallback.
- If hosts disagree on schema, policy digest, backend, or authority endpoint, keep the deployment disabled until corrected.
- If fencing, event ordering, reader pinning, or conformance fails, mark the release failed and retain the evidence with the incident.
- Shared SQLite, NFS locks, independent SQLite copies, and Git-based locks are unsupported recovery paths. Move to a single PostgreSQL authority or return to a single-host deployment.

