# Single-host authority reads and maintenance

CLI and MCP resolve the same persistent SQLite authority and content root. Set `TARIC_DB` and `TARIC_CONTENT_ROOT` explicitly when operating a separate deployment. SQLite uses WAL and one canonical writer; clients use that Core service. A maintenance CLI process opens its own connection to the same local authority. Shared files, NFS locks, Git repositories, or independent SQLite copies do not provide a multi-host backend.

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

Doctor, verify, preview, and export hold a pinned read transaction. Reports carry `read_seq` and authority/projection watermarks. Doctor and preview check Artifact files without changing their catalog state or appending audit events. Export materializes one selected authority state, preserves migration metadata and integrity hashes, and omits payload bytes and private Artifact locations.

Explicit replay/rebuild/reconcile may repair derived state through ordinary writer transactions. They preserve previous canonical versions and audit hashes, and append recovery events when applicable. Their response includes `source_read_seq`, the final `read_seq`, and watermarks. Artifact state changes occur only during explicit reconciliation. Readers can continue on their fixed sequence while a local writer commits through WAL.

Maintenance runs synchronously in its own CLI process. It is not an asynchronous service worker and does not hold a writer lock for read-only checks. Full audit/hash verification and portable exports may use memory and time proportional to selected history. Startup and doctor validate authority consistency; normal writes reuse that validation until `PRAGMA data_version` reports another connection's commit. Each mutation still validates its own candidate, references, ownership, and expected version in its write transaction.

## Reproduce scale measurements

```sh
npm run build
node --no-warnings scripts/benchmark-authority.mjs
node --no-warnings scripts/benchmark-authority.mjs --sizes=10000,50000
node --test packages/core/test/authority-scale.test.mjs packages/core/test/persistent-cursor.test.mjs
```

The harness builds versioned 10k and 50k fixtures through validated snapshot import, then measures 100 individual commits and 100 proposal-to-L1 admissions at each populated size. Each sample also contains two scope/Engagement records, 100 direct mutations, and 100 admitted records. Fixture population is reported separately. Read phases use separate processes and report their pinned source sequence, elapsed time, serialized bytes where applicable, and process RSS. Each RSS maximum includes that worker's startup validation; before/after RSS helps distinguish measurement allocation from the process high-water mark.

The report separates commit/admission p95, first list page and continuation, snapshot materialization, export materialization, and context first-page/continuation costs. Snapshot/export are O(N) materializations, and context continuation re-fetches and orders its pinned snapshot. The continuation sample contains three pages; it does not claim a constant-time or constant-memory implementation. These synthetic local measurements do not establish throughput for a different host, dataset, or deployment, and do not supply quality-evaluation truth or recall evidence.

See [context recovery](context-recovery.md) for key ownership, rotation, and restart behavior. Recorded scale evidence is saved separately in [authority-scale-v1.json](benchmarks/authority-scale-v1.json).

The recorded run used Node 22.21.1, SQLite WAL, and an Intel i5-7287U host on 2026-10-14. At 10k/50k fixtures, commit p95 was 17.7/15.2 ms and proposal-to-L1 p95 was 54.0/34.7 ms (100 samples each). The pinned sequences were 10403/50403. Snapshot materialization took 420/1737 ms; export took 896/2809 ms with process peak RSS of 162/446 MiB. The 50k export serialized 21.3 MB. These are observations from that host and fixture, not bounds.

The first incomplete scale run exposed an unindexed audit-to-version join. `record_versions_commit_sequence` now supports that join; a query-plan regression rejects a full version scan there. Fixture import still took 30/245 seconds in the completed run and is recorded independently of individual mutation latency. Context first pages took 1.08/3.79 seconds; the three continuation samples ranged 1.91–11.55/2.72–3.59 seconds. The raw report retains the slow sample and all RSS/sequence metadata. Context continuation is an identified O(N) read cost, not a latency release gate inferred from commit p95.
