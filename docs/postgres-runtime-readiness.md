# PostgreSQL runtime readiness

SQLite and PostgreSQL now execute one asynchronous Core authority implementation. The two SQL drivers own connections, transactions, dialect expressions and clocks; proposal/review, L1/L2 admission, checkpoints, actions, Artifact catalog/publication, leases/fencing, audit/outbox, fixed reads and logical snapshot restore use the same Core governance paths. PostgreSQL leases use server time and each write transaction keeps one checked-out client under a schema-scoped transaction lock. SQLite access is queued per database file. Nested calls reuse the transaction context.

`PostgresAuthorityStore.runtimeReadiness(report?)` is a read-only probe. It opens a repeatable-read transaction, checks the selected schema's tables, columns, storage format, authority identity, sequence watermarks and active lease/Attempt bindings. It neither runs migrations nor inserts authority state. Unknown database errors produce `postgresql_unavailable` without exception text. With no complete passing runtime report it remains `runtime_state=disabled`. It reports `enabled` and `evidence_state=verified` only when all twelve scenario outcomes and the current schema/health checks pass. A healthy table layout alone cannot enable runtime.

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

The report's `domains` entries list absent methods, tables and columns separately from executable scenario evidence. The versioned `authority-sql/2` layout stores JSON as text in both adapters. An old primitive-only PostgreSQL schema is rejected before writes; it is not silently reinterpreted. Each PostgreSQL authority has a persisted UUID identity, so cursor keys cannot be reused with a different database merely because its schema has the same name.

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

Validation commands:

```sh
npm run build
node --test packages/core/test/postgres-runtime-readiness.test.mjs packages/core/test/backend-runtime.test.mjs packages/core/test/postgres.test.mjs
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  node --test packages/core/test/runtime-conformance.test.mjs packages/core/test/postgres-live.test.mjs
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  TARIC_TEST_POSTGRES_CONTAINER=taric-authority-postgres-1 \
  node scripts/verify-postgres-runtime.mjs --output docs/benchmarks/postgres-runtime-v1.json
```

The live URL must point to a disposable development/test database. The driver is installed with the workspace; a skipped live test remains missing evidence. See [local deployment and activation](postgres-local-deployment.md) for OrbStack commands. The saved [live report](benchmarks/postgres-runtime-v1.json) contains the exact twelve outcomes, server version, read-only health and independent restore release evidence. With the container flag, `database_backup` also verifies a custom-format `pg_dump` of the authority schema, restores it into a newly created database, compares every table and checks audit/authority integrity. It drops only that temporary database. This is a logical database dump, not a physical base backup or WAL recovery test; payload bytes are excluded.

Native JSON snapshots are logical, sanitized Engagement exports. They preserve canonical identity, display aliases and record versions, and import starts a new audited history. The result reports `source_sequence` and `target_sequence` separately; `recovered_sequence` is the target import event sequence. The import audit binds the source sequence and snapshot hash. This format does not preserve arbitrary historical events, leases, task-session payloads or all prior record versions. Full PostgreSQL disaster recovery uses a database backup such as `pg_dump`/`pg_restore`, coordinated with each host's spool backup, before traffic is switched and leases are reissued. Logical migration evidence does not claim a physical database restore.
