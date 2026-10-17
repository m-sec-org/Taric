# Authority runtime hardening verification

Status: **implementation complete; quality release evidence pending**. All 28 implementation/verification tasks are checked, including task 6.2. The [verification.json](verification.json) records `technical_passed=true`, `runtime_verified=true`, `implementation_complete=true` and `release_state=blocked`. Per the operator decision on 2026-10-15, representative independently annotated data and human-baseline provenance affect the quality release gate only; they do not block implementation completion. No production-quality claim is made.

The source baseline is commit `23c6783ebd34703cc258a6981e8a83953f6f30e6` plus the current working changes. Verification exports the current packages/scripts/configuration into an empty temporary directory, installs pinned dependencies with `npm ci`, then runs build, typecheck, schema/Core/CLI/MCP suites, Hermes tests, and documentation-link checks. It does not reuse the existing dist or dependency tree.

The exact source digest is recorded in [verification.json](verification.json). Node `v22.21.1`, macOS, 14 current specifications, 50 registered operations and 64 schema definitions. `npm ci --ignore-scripts`, build, typecheck, all package suites and 50 local documentation links passed. OpenSpec strict validation and `git diff --check` also passed. Live PostgreSQL tests ran rather than skipping.

| Suite | Total | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Schemas | 9 | 9 | 0 | 0 |
| Core | 266 | 266 | 0 | 0 |
| CLI | 19 | 19 | 0 | 0 |
| MCP | 12 | 12 | 0 | 0 |
| Hermes | 5 | 5 | 0 | 0 |
| Total | 311 | 311 | 0 | 0 |

Reproduce the independent verification after `npm run build`:

```sh
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  TARIC_TEST_POSTGRES_CONTAINER=taric-authority-postgres-1 NODE_NO_WARNINGS=1 \
  node scripts/verify-release.mjs \
  --output openspec/changes/harden-taric-authority-runtime/verification.json \
  --postgres-output docs/benchmarks/postgres-runtime-v1.json
```

PostgreSQL 17.11 is running healthy on OrbStack at `127.0.0.1:55432`, with the named volume retained. The deployed `taric` schema is initialized with an empty valid audit. The [live report](../../../docs/benchmarks/postgres-runtime-v1.json) passes all twelve Core scenarios, current schema/lease checks and the shared-authority release gates. The default single-host profile still leaves PostgreSQL disabled; explicit activation requires evidence bound to the current compiled Core/schema/policy digests. Health or schema/fencing loss blocks operations without a SQLite fallback, and audit corruption blocks writes. See [deployment commands](../../../docs/postgres-local-deployment.md) and [readiness requirements](../../../docs/postgres-runtime-readiness.md).

The statistical algorithms and provenance validation are implemented. No representative independently annotated dataset or blinded human baseline is present. Synthetic fixtures do not establish quality or recall, and insufficient strata/provenance fail closed. Quality evidence remains pending.

Scale evidence separates mutation/admission p95 from snapshot/export materialization and context first-page/continuation cost. Artifact evidence keeps the 64 MiB decoded contract, measures two simultaneous uploads for text and binary fixtures, and reports process-crash recovery without power-loss guarantees. Final evidence paths:

- [Authority scale](../../../docs/benchmarks/authority-scale-v1.json)
- [Artifact profile](../../../docs/benchmarks/artifact-profile-v1.json)
- [Reproduction commands](../../../docs/authority-storage-runbook.md#reproduce-scale-measurements)

| Authority fixture | Commit p95 | Proposal→L1 p95 | Snapshot | Export | Context first page | Source sequence |
|---|---:|---:|---:|---:|---:|---:|
| 10k | 9.3 ms | 139.4 ms | 426 ms | 1,232 ms | 1,227 ms | 10,403 |
| 50k | 20.2 ms | 66.2 ms | 2,019 ms | 4,978 ms | 8,380 ms | 50,403 |

Commit/admission measurements each use 100 samples after fixture population. Export peak process RSS is approximately 112/234 MiB at 10k/50k; startup validation is included in each process high-water mark. Context continuation re-fetches and sorts its pinned snapshot: the measured pages take about 0.9–1.0 seconds at 10k and 3.8–4.4 seconds at 50k. No constant-time or two-second context guarantee is claimed. Fixture imports are separately recorded at about 56/267 seconds. These measurements were collected alongside regression checks and are not isolated-machine capacity guarantees.

For 64 MiB × 2 Artifact uploads, the saved text/binary run records 178,957,456 transport bytes, approximately 801/922 MiB peak RSS, 28.6/27.9 seconds end-to-end p95, zero publication failures and source sequence 6. These are measurements on this machine under load, separate from authority mutation p95. Profile/fault tests cover before-manifest, before/after-rename, publication-marker/catalog boundaries, restart, reconcile, concurrent idempotency and async initialization. Unverified content never becomes available. The default profile performs no explicit fsync and claims process-crash recovery only.

The harness runs the same Core scenarios against isolated SQLite and live PostgreSQL. Native Engagement snapshot restore preserves canonical identity, display aliases and record versions, then creates a new target audit baseline. Its marker binds source sequence and snapshot hash; it does not transplant historical audit rows, active leases or spool bytes. The separate `database_backup` check also creates a custom-format `pg_dump` of the complete authority schema, restores it into an independent disposable database with `pg_restore --single-transaction`, compares every table, and verifies authority/audit integrity. This is a logical database dump, not a physical base-backup/WAL recovery test. Host spool backup and lease reissuance remain required before disaster-recovery traffic is switched.
