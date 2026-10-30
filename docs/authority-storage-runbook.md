# Single-host authority reads and maintenance

The package and schema contracts are listed in the [compatibility matrix](../compatibility-matrix.json). The saved runtime and benchmark reports cited below predate the 1.0.0 source and are historical measurements, not 1.0.1 release or deployment evidence. On 2026-10-27, the 1.0.1 workspace build, typecheck, matrix check and PostgreSQL-configured workspace tests passed; current PostgreSQL runtime, backup/restore, disposable two-container coordination and container spool evidence are recorded in [runtime readiness](postgres-runtime-readiness.md). Public `snapshot.import` is unsupported; database backup/restore must preserve the matching content root and cursor key. Keep saved benchmark reports unchanged when collecting new samples.

> Last reviewed: 2026-10-27

CLI and MCP resolve the same persistent SQLite authority and content root. Set `TARIC_DB` and `TARIC_CONTENT_ROOT` explicitly when operating a separate deployment. The default runtime profile is `single_host_sqlite`; an explicit `multi_host_authority` profile must use the PostgreSQL runbooks instead. SQLite uses WAL and serializes write transactions. CLI, MCP, proxy and maintenance processes may open separate connections to the same local file; same-process driver queues do not coordinate separate processes. Shared files, NFS locks, Git repositories, or independent SQLite copies do not provide a multi-host backend.

Before maintenance, confirm that the process is pointing at the intended pair of paths:

```sh
printf 'authority=%s\ncontent_root=%s\n' "${TARIC_DB:-$HOME/.taric/authority.sqlite}" "${TARIC_CONTENT_ROOT:-<db-directory>/content}"
node packages/cli/dist/bin.js capability.status
```

The content root contains both Artifact payloads and the authority-bound cursor key. Back up the SQLite file, the configured content root, and `.taric-context-cursor-key.v1` as one unit. A database-only backup can restore records but cannot preserve existing cursor continuations or local Artifact bytes.

## Host-owned content and projections

Taric's stored Artifact bytes are opaque. `storage_mode: "external"` with `host_ref` records an external locator and optional declared hash/size as metadata; Taric does not fetch it, prove that it is available, or verify that the hash describes retrievable content. A declared hash is not a verification claim. The host owns external availability and any report/projection built from those bytes.

For Taric-stored content, staged chunks remain unavailable through the Artifact catalog until the upload commits and publication checks pass. Run-bound catalog entries retain Engagement, session, WorkRun, Attempt and generation attribution; stale or reclaimed generations cannot publish current content. See [Artifact durability and spool behavior](multi-host-authority-runbook.md#artifact-spool-in-a-shared-deployment) and [Artifact API operations](taric-api.md#task-session-artifact-content).

## Bounded queries

`query`, `resource.query`, and `evidence.query` return `records`, `next_cursor`, `read_seq`, `committed_seq`, and `projected_seq`. `proposal.list` returns `proposals`, `next_cursor`, and `read_seq`. The default page size is 100; valid sizes are 1–1000. Continue with the exact Engagement, principal, page size, and filters from the first request. The cursor also binds the record kind, candidate visibility, trust filter, and fixed read sequence. Concurrent submissions or admissions cannot insert, omit, or replace entries in the original proposal page sequence. Proposal versions preserve the status observed at that sequence.

```sh
taric query '{"engagement_id":"<UUIDv7>","include_candidates":true,"kind":"claim","page_size":100}'
taric query '{"engagement_id":"<UUIDv7>","include_candidates":true,"kind":"claim","page_size":100,"cursor":"<next_cursor>"}'
taric proposal.list '{"engagement_id":"<UUIDv7>","page_size":100}'
```

Candidate visibility is explicit; ordinary model queries still return L2 only. Reference validation deduplicates the supplied IDs and joins the object-reference and record indexes once per batch of at most 500 IDs. Engagement/kind/version and Engagement/ID/sequence queries have dedicated indexes. The page boundary uses keysets rather than offsets over a mutable list. Expiry predicates use the first page's read time throughout continuation.

## Operator maintenance

The operation registry limits the following operations to an authenticated operator with the audit capability. Role and capabilities come from the transport, never the request body. The default CLI operator is an operator transport context; callers must still provide their intended Engagement.

```sh
taric audit.doctor '{}'
taric audit.verify '{}'
taric audit.reconcile '{"action":"preview"}'
taric snapshot.export '{"engagement_id":"<UUIDv7>"}'
taric audit.reconcile '{"action":"replay"}'
taric audit.reconcile '{"action":"rebuild"}'
taric audit.reconcile '{"action":"reconcile"}'
```

Doctor, verify, preview, and export hold a pinned read transaction. Reports carry `read_seq` and authority/projection watermarks. Doctor and preview check Artifact files without changing their catalog state or appending audit events. Export materializes the latest version of each canonical record at the selected sequence, including L0/recalled records excluded by ordinary recall, with integrity metadata and sensitive-field filtering. It omits payload bytes/private locations and does not back up all history, leases, proposals/reviews or the spool.

Explicit replay/rebuild/reconcile may repair derived state through ordinary writer transactions. They preserve previous canonical versions and audit hashes, and append recovery events when applicable. Their response includes `source_read_seq`, the final `read_seq`, and watermarks. `audit.reconcile {}` is also a mutating path: it consumes outbox and reconciles Artifact state. Always specify `action:"preview"` for observation only. Readers can continue on their fixed sequence while a local writer commits through WAL.

Maintenance runs synchronously in its own CLI process. It is not an asynchronous service worker and does not hold a writer lock for read-only checks. Full audit/hash verification and portable exports may use memory and time proportional to selected history. Startup and doctor validate authority consistency; normal writes reuse that validation until `PRAGMA data_version` reports another connection's commit. Each mutation still validates its own candidate, references, ownership, and expected version in its write transaction.

If `audit.doctor` reports authority drift, invalid permissions, a broken audit chain, or missing Artifact content, treat the authority as write-blocked until the reported condition is understood. `audit.reconcile` only repairs the derived state and publication markers selected by its action; it never invents canonical records, recreates missing payloads, or changes retention policy. After restoring the database or content root, rerun `audit.doctor`, `audit.verify`, and the relevant Artifact integrity checks before resuming writers.

## Reproduce scale measurements

```sh
npm run build
node --no-warnings scripts/benchmark-authority.mjs
node --no-warnings scripts/benchmark-authority.mjs --sizes=10000,50000
node --no-warnings scripts/benchmark-authority.mjs --sizes=10000,50000 --output=/tmp/taric-authority-scale-current.json
node --no-warnings scripts/benchmark-authority.mjs --sizes=10000,50000 --output=/tmp/taric-authority-scale-current.json --replace=true
node --no-warnings scripts/benchmark-authority.mjs --sizes=500 --output=/tmp/authority-scale-smoke.json
node --test packages/core/test/authority-scale.test.mjs packages/core/test/persistent-cursor.test.mjs
```

The harness restores versioned 10k and 50k primary-Engagement fixtures, adds a 25-revision high-churn record, three secondary Engagements, and 100 direct commits plus 100 proposal-to-L1 admissions. Fixture population is reported separately. Read phases run in separate processes on the same generated authority and preserve the pinned source sequence. Each phase reports SQL statement/returned/affected row deltas, queue wait and SQL elapsed time, application-processing residual, RSS, WAL file size before/after, event-loop delay samples, serialization bytes/time, and p50/p95. Snapshot and context phases additionally time record JSON hydration, freshness/filter evaluation, record sorting, context projection, page projection, and cursor encoding; page projection includes the cursor stage, so those values are nested and must not be added together. The delay monitor includes a short post-operation observation window so an otherwise empty histogram can record its timer sample. Singleton phase summaries have one sample (so p50 equals p95); three context continuation samples are reported individually. `--output` writes a new file and refuses to overwrite an existing report unless `--replace=true` is explicitly supplied.

SQL timers bracket driver operations; application-processing residual is total phase time minus measured queue and SQL time, so it includes JSON hydration/filter work and JavaScript overhead rather than claiming a pure hydration measurement. Context ordering/projection/cursor stages use opt-in timers and contain no record data. WAL deltas are file sizes, not physical disk I/O or checkpoint cost. Event-loop delay is sampled with `monitorEventLoopDelay`; `sample_count: 0` means no timer tick landed during that phase. RSS high-water marks include worker startup and phase setup.

The report separates commit/admission p95, first list page and continuation, snapshot materialization, export materialization, and context first-page/continuation costs. Snapshot/export remain O(N) materializations. The candidate Context path uses bounded keyset pages pinned to `read_seq`; each page records `read_stats` and enforces its scan budget. The three continuation samples also have an aggregate p50/p95, but do not establish a constant-time or constant-memory deployment guarantee. These synthetic local measurements do not establish throughput for a different host, dataset, or deployment, and do not supply quality-evaluation truth or recall evidence.

See [context recovery](context-recovery.md) for key ownership, rotation, and restart behavior. The [authority-scale-v2-baseline.json](benchmarks/authority-scale-v2-baseline.json) is the preserved legacy Context baseline; [authority-scale-v3.json](benchmarks/authority-scale-v3.json) is the final bounded run in the pre-1.0.0 candidate experiment. Neither is a 1.0.1 release measurement. Never treat the 500-row smoke fixture or historical v1/v2 measurements as final candidate evidence.

The historical [v1 run](benchmarks/authority-scale-v1.json) used Node 22.21.1, SQLite WAL, and an Intel i5-7287U host; `measured_at` is 2026-10-15T02:06:33Z. At 10k/50k fixtures, commit p95 was 9.3/20.2 ms and proposal-to-L1 p95 was 139.4/66.2 ms (100 samples each). The pinned sequences were 10403/50403. Snapshot materialization took 426/2019 ms; export took 1232/4978 ms with process peak RSS of 112/234 MiB. The 50k export serialized 21.3 MB. These are observations from that host and fixture, not bounds.

The first incomplete scale run exposed an unindexed audit-to-version join. `record_versions_commit_sequence` now supports that join; a query-plan regression rejects a full version scan there. Fixture import is recorded independently of mutation latency. The preserved legacy baseline and final candidate retain raw phase metrics, RSS, sequence, SQL, WAL, event-loop, serialization, cursor, and bounded-read metadata; the 50k candidate first page measured 3.08 seconds versus 5.36 seconds legacy (42.5% lower), below the stated 50% target.
