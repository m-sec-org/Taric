# Multi-host authority runbook

PostgreSQL and SQLite share the asynchronous Core governance implementation. PostgreSQL reports `implementation_state=available`, but runtime activation remains conditional on matching live conformance evidence and current schema/lease health; the default `single_host_sqlite` profile does not load the PostgreSQL driver or contact a PostgreSQL service. The saved PostgreSQL 17.11 report is a pre-1.0.0 candidate run that passed all twelve scenarios and independent logical backup/restore for one authority host. The 1.0.0 workspace validation on 2026-10-26 did not run PostgreSQL live tests, so that saved report is not valid activation evidence for the current source. A two-process/multi-host deployment and network interruption/reconnect profile remain unverified.

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

The process-facing configuration for each host is explicit:

```sh
export TARIC_AUTHORITY_PROFILE=multi_host_authority
export TARIC_DATABASE_URL='postgresql://<service-user>:<secret>@<authority-host>:5432/<database>'
export TARIC_HOST_ID='<stable-host-id>'
export TARIC_LEASE_MODE=server_side
export TARIC_RUNTIME_CONFORMANCE='/secure/path/postgres-runtime-current.json'
export TARIC_CONTENT_ROOT='/secure/path/taric-content/<stable-host-id>'
```

Use operator-managed secrets and TLS in a real deployment. Generate a new activation report for the exact current Core build and disposable test deployment before using this configuration; do not point 1.0.0 at the saved pre-1.0.0 `postgres-runtime-v2.json`. `TARIC_RUNTIME_CONFORMANCE` is an operator-owned activation evidence file, not a test output that a running host may regenerate. Changing Core, schema, policy, PostgreSQL schema, or deployment assumptions requires a new report or keeps the profile disabled. `capability.status` must report `backend=postgresql`, `lease_mode=server_side`, `runtime_state=enabled`, and verified evidence before traffic is admitted.

## Artifact spool in a shared deployment

Artifact APIs use the same Engagement/session authorization on every host, but PostgreSQL does not store or coordinate payload bytes. Before enabling a host, bind each task session to a root beneath that host's configured content root. A host may instead submit an external `host_ref`; Taric never fetches it. Do not point two hosts at the same writable spool unless the deployment has an independently tested filesystem and locking design; a shared PostgreSQL authority alone does not make file publication atomic.

The host/operator sequence is `artifact.session.bind` → `artifact.store.begin` → ordered append → `artifact.store.commit`. Base64 append is limited to 64 MiB decoded and 16 KiB JSON metadata. For large local files, `taric artifact.store.append-file '<metadata-json>' <path>` hashes and streams a file up to 64 MiB without putting bytes into process arguments.

An out-of-process host can also use `listenArtifactBinaryRpc`: a 4-byte big-endian header length, a JSON header capped at 16 KiB, and exactly the declared raw body length. Receive chunks are 64 KiB, the per-upload queue holds at most two chunks (128 KiB), at most two upload connections are active, and staging writes pause network reads when the filesystem applies backpressure. Missing, trailing, over-limit, or hash-mismatched bytes do not publish. Ordinary adapter JSON-RPC stays at 1 MiB per line, caps raw content reads at 512 KiB decoded and content-bearing pages at 16 items plus 128 KiB decoded body. MCP and ordinary model context never read payload bytes.

Coordinate PostgreSQL backups with the corresponding host spool backup. Artifact publication uses staged files and authority publication markers; restart and doctor/reconcile compare markers, manifests, hashes, and catalog rows in bounded batches. Reads fail closed when a manifest/chunk is missing or its hash differs, and reconciliation reports unavailable/integrity states without silently deleting or recreating files. Execution sidecars and WorkRun-fenced session output are bounded and remain scoped to the registered task session. A shared PostgreSQL authority does not make two writable host spool roots safe; use one bound root per host unless filesystem locking has been independently verified.

The `local_process_crash` Artifact profile uses staging files, streaming SHA-256 verification, atomic rename and verified publication markers. It performs no explicit fsync and does not advertise power-loss durability. A power-loss profile would require payload/manifest file sync, directory sync before/after rename and coordinated database durability; those costs must be measured on the selected filesystem before advertising such a profile. The durability suite injects process stops at `before_manifest`, `before_rename`, `after_rename`, `after_publication_marker`, `before_catalog_commit`, and `after_catalog_commit`; after restart, only integrity-verified publications with a still-valid run fence may become available. An expired or reclaimed run-bound Attempt leaves the publication pending for operator reconciliation. Repeated commit requests are request-bound and do not create a second catalog row. Run `node --no-warnings scripts/benchmark-artifact-transport.mjs --bytes 67108864 --concurrency 1,2 --output=/tmp/artifact-transport-current.json` for text/binary process transport samples, paced receive, 1/2 concurrency, RSS, event-loop delay, latency, throughput, hashes and over-limit no-publication evidence. The saved 2026-10-17 macOS benchmark is pre-1.0.0 candidate evidence: it recorded four 64 MiB subprocess cases plus two JSON boundary samples, text/binary throughput of 17.8/18.1 MB/s at one upload and 19.3/19.3 MB/s at two uploads, zero publication failures and exact hashes. Client peak RSS was 108 MB, server peak RSS 128 MB, and the largest observed server event-loop delay was 1,007 ms. A 64 MiB + 1 byte upload was rejected without a catalog row, and an ordinary JSON frame over 1 MiB was closed. This benchmark does not establish power-loss recovery, 1.0.0 performance, or limits imposed by an external transport.

Maintenance includes separate observation and repair paths. `audit.verify`, `audit.doctor`, `audit.reconcile { action: "preview" }`, and `snapshot.export` run under one fixed maintenance read transaction where applicable and report the read/committed/projected watermarks; they do not spawn a worker or silently rewrite history. All reconcile calls remain operator-only: `preview` is read-only, while `replay`, `rebuild`, `reconcile`, and an omitted action can mutate derived/Artifact state. An omitted action consumes outbox and reconciles Artifact; it is not preview. Run `node --no-warnings scripts/benchmark-maintenance.mjs --output=/tmp/maintenance-concurrency-current.json` to measure concurrent writes, maintenance latency, SQL queue/row counts, WAL and event-loop delay on a local fixture. The saved 2026-10-17 run is pre-1.0.0 candidate evidence: it recorded 25 writes, 10 heartbeats, four maintenance operations, p50/p95 maintenance latency of 22.7/175.2 ms, fixed read sequence 204, and no history change. It is an operational sample, not 1.0.0 evidence, production capacity, or an SLA claim.

## Migration from SQLite

Public `snapshot.import` and `migration` are unsupported. `snapshot.export` supports inspection/export; it does not provide a public SQLite-to-PostgreSQL round-trip. The backend restore primitive used by isolated conformance is not a host migration API.

For a new PostgreSQL deployment, initialize the authority and pass the current conformance/health gate, then submit historical material through normal proposals and evidence references with original timestamps and limitations. This creates governed new state rather than transplanting a SQLite authority's history, active leases or trust assertions. A migration that must preserve existing authority history requires a separately designed and verified operator procedure; do not switch traffic based on an assumed import command or merge independent histories.

Database recovery uses an isolated database restore as described below. Preserve each host's matching content root and authority-bound cursor key separately; copying a key to a different authority/root does not make old cursors valid. Reissue leases after restore and start fresh reads when the original cursor binding cannot be restored.

## Backup, restore, and recovery

Taric-native JSON/JSONL is a sanitized Engagement export format. The private isolated restore/conformance path can preserve canonical IDs, display aliases and exported record versions while recording a new target audit baseline; it does not transplant every prior event or active lease, or include Artifact payloads. Its source/target sequence checks do not enable public import. Database recovery can use [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) into a separate database. These tools perform a logical database dump/restore, not a physical base backup. Verify the restored authority and spool before switching traffic, then reissue leases.

- Take database backups using the selected backup procedure and record UTC timestamp, schema version, source authority sequence, integrity metadata, and Engagement coverage.
- Test restores into an isolated temporary destination. A restore must validate completely before the destination is switched; failed imports must leave the destination unchanged.
- After database restore, compare the recovered sequence and audit chain in the isolated backend conformance harness. Public `snapshot.import` is unsupported and cannot be used as a host migration path. Verify references/revisions and report unresolved errors. Keep writes blocked when integrity or schema checks fail.
- Treat all leases as expired after restore. Hosts must obtain new server-side lease generations before submitting run-scoped writes.
- Reconcile projections from committed authority state. Never replay external actions automatically; unresolved action results require host/operator reconciliation.

## Failure handling

- If PostgreSQL is unavailable, block multi-host authority writes and report an unavailable/blocked diagnostic. Do not open a local SQLite fallback.
- If hosts disagree on schema, policy digest, backend, or authority endpoint, keep the deployment disabled until corrected.
- If fencing, event ordering, reader pinning, or conformance fails, mark the release failed and retain the evidence with the incident.
- If a host loses its content root or cursor key, keep authority writes available only if the deployment policy permits it, but force that host to start fresh reads and report Artifact references as unavailable until its spool is restored and reconciled.
- Shared SQLite, NFS locks, independent SQLite copies, and Git-based locks are unsupported recovery paths. Move to a single PostgreSQL authority or return to a single-host deployment.

