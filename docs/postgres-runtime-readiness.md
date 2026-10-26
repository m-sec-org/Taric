# PostgreSQL runtime readiness

SQLite and PostgreSQL execute one asynchronous Core authority implementation. The two SQL drivers own connections, transactions, dialect expressions and clocks; proposal/review, L1/L2 admission, checkpoints, actions, Artifact catalog/publication, leases/fencing, audit/outbox, fixed reads and the internal snapshot restore path use the same Core governance paths. Public `snapshot.import` remains unsupported. PostgreSQL leases use server time and each write transaction keeps one checked-out client under a schema-scoped transaction lock. SQLite access is queued per database file. Nested calls reuse the transaction context.

> Last reviewed: 2026-10-26

The saved [PostgreSQL runtime report](benchmarks/postgres-runtime-v2.json) remains historical pre-1.0.0 evidence. A fresh run on 2026-10-26 used the current `1.0.0` source and OrbStack PostgreSQL 17.11: all twelve Core runtime scenarios passed, readiness returned `enabled`/`ready`, and independent `pg_dump`/`pg_restore` verified all 25 authority tables with source and recovered sequence 106. The current report is `/tmp/taric-postgres-runtime-20261026.json` on the verification machine; regenerate it for another checkout or deployment. Activation still checks that the report matches the compiled implementation/schema/policy and that the target schema and lease health are currently healthy.

The same verification run passed the full Core suite with PostgreSQL configured (351/351, no PostgreSQL skips). A separate [two-host-container check](../scripts/verify-multi-host-postgres-live.mjs) used a randomly named disposable database, two Node containers with distinct host IDs and content roots, concurrent lease claims, owner-container termination, reclaim, and stale-generation rejection. It passed on one workstation; it does not establish cross-machine or network-partition recovery. A [container spool check](../scripts/verify-container-spool.mjs) also passed across two sequential Node 22 containers using one bind-mounted spool. Reports are local `/tmp` artifacts, not preserved benchmark files.

`PostgresAuthorityStore.runtimeReadiness(report?)` is a read-only probe. It opens a repeatable-read transaction, checks the selected schema's tables, columns, storage format, authority identity, sequence watermarks and active lease/Attempt bindings. It neither runs migrations nor inserts authority state. Unknown database errors produce `postgresql_unavailable` without exception text. With no complete passing runtime report it remains `runtime_state=disabled`. It reports `enabled` and `evidence_state=verified` only when all twelve scenario outcomes and the current schema/health checks pass. A healthy table layout alone cannot enable runtime.

The readiness result has three separate dimensions:

| Field | Meaning |
|---|---|
| `implementation_state` | The compiled PostgreSQL implementation and required backend methods are present |
| `runtime_state` | The selected deployment may serve traffic; it is `enabled` only after evidence and live health pass |
| `evidence_state` | The supplied conformance evidence is complete and matches the current implementation; otherwise it is `pending` or `failed` |

`runtimeReadiness()` is safe to use for diagnostics and monitoring. It does not migrate a schema, run conformance fixtures, create a cursor key, or open SQLite. `PostgresAuthorityStore.health()` may apply the normal schema readiness path, but process-facing activation still requires the saved, digest-bound report consumed by `openRuntimeService`.

```ts
import { PostgresAuthorityStore } from "@taric/core";

// Supply an operator-owned PostgreSQL Client or Pool. Its lifecycle belongs
// to the caller; backend.close() does not close the supplied pool.
const backend = new PostgresAuthorityStore(client, {
  profile: "multi_host_authority",
  schema: "taric",
});
const report = await backend.runtimeReadiness();
console.log(JSON.stringify(report, null, 2));
```

The report's `domains` entries list absent methods, tables and columns separately from executable scenario evidence. The versioned `authority-sql/4` layout stores JSON as text in both adapters and includes the admission-bound review snapshot table. An old primitive-only PostgreSQL schema is rejected before writes; it is not silently reinterpreted. Each PostgreSQL authority has a persisted UUID identity, so cursor keys cannot be reused with a different database merely because its schema has the same name.

| Domain | Shared runtime verification |
|---|---|
| Proposal/review | Invalid candidates cause zero mutation; authenticated reviewer and immutable proposal/evidence hashes |
| L1/L2 | L1 remains a candidate; authorized L2 promotion fixes evidence/review/version inputs and rejects stale inputs |
| Checkpoint/action | Owner, Attempt, generation and version checks; executable resume and explicit unknown-result reconciliation |
| Artifact | Binary publication, idempotency, catalog freshness, real restart, fault recovery and corrupt/missing chunk rejection |
| Lease/fencing | Concurrent claim, server expiry/reclaim and stale-generation rejection across run writes |
| Audit/outbox | Ordered identities/events, audit-failure rollback, non-overlapping consumers and watermarks |
| Pinned read | As-of lookup and keyset continuation omit later inserts/updates without duplication |
| Backup/restore | Independent destination, integrity/schema checks, retained identity/display/version and restart/CAS |

All persistence methods and Core service operations return promises. Use `await createCoreService(...)`, `await service.dispatch(...)` and `await store.close()`. A direct `ArtifactContentStore` caller awaits `initialize()` before use. Catalog hydration/recovery and scoped refreshes complete before the caller consumes their result; they do not inspect another host's spool root.

The same executable scenarios run against isolated SQLite files and live PostgreSQL schemas. The harness requires explicit isolation, a persistence restart hook and real audit-failure injection. Production startup consumes saved evidence rather than creating test records. `openRuntimeService` is shared by CLI and MCP; it checks the compiled Core implementation, schema and policy digests, then checks deployed schema/lease health before service construction and subsequent operations. An absent, failed or mismatched report blocks activation and never opens SQLite.

The activation report is invalidated by changes to the compiled Core JavaScript, `@taric/schemas`, policy digest, PostgreSQL schema/storage format, or the tested deployment assumptions. Generate a new report after rebuilding or migrating. Keep one report per release candidate and authority deployment; do not overwrite an incident's evidence with a later run.

Validation commands:

```sh
npm run build
node --test packages/core/test/postgres-runtime-readiness.test.mjs packages/core/test/backend-runtime.test.mjs packages/core/test/postgres.test.mjs
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  node --test packages/core/test/runtime-conformance.test.mjs packages/core/test/postgres-live.test.mjs
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  TARIC_TEST_POSTGRES_CONTAINER=taric-authority-postgres-1 \
  node scripts/verify-postgres-runtime.mjs --output /tmp/taric-postgres-runtime-current.json
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  TARIC_RUNTIME_CONFORMANCE=/tmp/taric-postgres-runtime-current.json \
  node scripts/verify-multi-host-postgres-live.mjs --output /tmp/taric-multihost-current.json
node scripts/verify-container-spool.mjs --output /tmp/taric-container-spool-current.json
```

The live URL must point to a disposable development/test database. The two-container script creates and drops only its own randomly named database, so the configured role needs local test-database create/drop rights. It uses the OrbStack Compose bridge network to reach `taric-authority-postgres-1`. The container spool script uses the active OrbStack context and the `node:22-alpine` image; it mounts the repository read-only and an isolated temporary spool read/write. See [local deployment and activation](postgres-local-deployment.md) for OrbStack commands. With the PostgreSQL container flag, `database_backup` verifies a custom-format `pg_dump` of the authority schema, restores it into a newly created database, compares every table and checks audit/authority integrity. It drops only that temporary database. This is a logical database dump, not a physical base backup or WAL recovery test; payload bytes are excluded.

Public `snapshot.import` is unsupported; only the isolated backend restore/conformance path uses the import behavior below. Native JSON snapshots are logical, sanitized Engagement exports. They preserve canonical identity, display aliases and record versions, and import starts a new audited history. The result reports `source_sequence` and `target_sequence` separately; `recovered_sequence` is the target import event sequence. The import audit binds the source sequence and snapshot hash. This format does not preserve arbitrary historical events, leases, task-session payloads or all prior record versions. Full PostgreSQL disaster recovery uses a database backup such as `pg_dump`/`pg_restore`, coordinated with each host's spool backup, before traffic is switched and leases are reissued. Logical migration evidence does not claim a physical database restore.
