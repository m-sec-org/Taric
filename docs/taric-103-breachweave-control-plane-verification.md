# Taric 1.0.4 Control Plane Verification

- Verification date: 2026-11-01
- Review baseline: Taric `2314880` (`23148800ca08595ffce0c7ee83a88f190c245633`).
- Verified source: the updated working tree based on that baseline; the verification does not describe the baseline commit itself.
- Package versions: root workspace and runtime components `1.0.4`; API contract `1.4.0`, adapter contract `1.1`, record schema `1.0.0`, authority storage contract `authority-storage/4`, SQL layout `authority-sql/4`.
- Status: Taric implementation and local contract checks passed. This is not BreachWeave local acceptance or production certification.

## Delivered Contracts

- Immutable `scope_revision` and `scope_invalidation` records bind a normalized Scope policy to a committed, integrity-verified ROE Artifact. Scope history is queryable at a fixed authority sequence, and WorkRun/Action/Coverage/report checks reject stale or ineffective revisions.
- Coverage manifests pin expected dimensions to ScopeRevision and ResourceRevision records. `coverage.snapshot` pages a fixed complete-domain view with a signed, principal-bound cursor, a stable digest, missing dimensions, visibility disclosure, truncation state and a fail-closed gate.
- The public `coverage.record` request schema now accepts the ScopeRevision/policy digest pair already enforced by Core, so scoped cells can be written through the registry instead of only by internal store calls.
- Action lifecycle history is append-only and queryable by Engagement, WorkRun, Attempt, generation, Action, status and authority sequence. Network provenance is structured and validated; late results are quarantined from the current projection.
- Every new WorkRun requires an initialized Engagement and a current approved, effective ScopeRevision. Missing or stale bindings fail closed during claim, renewal, active lifecycle transitions, checkpoint/Action writes, and run-bound Artifact publication; legacy unbound runs cannot be resumed as valid current work.
- `report_snapshot` and `close_decision` are canonical immutable records. Report commit revalidates its Artifact, manifest, Scope, ResourceRevision, Coverage and Evidence bindings. Close uses Engagement-version and authority-sequence checks, requires no unfinished WorkRun or authorized/unknown Action, and commits the decision with the completed Engagement atomically. Reopen supersedes the current closed decision.
- Report idempotency hashes contain only business request fields and authenticated principal binding; a service recreation with a changed local content root replays the same ReportSnapshot instead of changing the request identity.
- Ordinary canonical writes and WorkRun claims are fenced while an Engagement is closed. Taric remains a memory and governance component; the host owns agent scheduling, tool execution, target-action authorization and report generation.
- `authority-storage/4` declares Scope, Coverage, Action audit, ReportSnapshot and CloseDecision backend methods and invariants; SQLite and PostgreSQL expose the same shared Core implementation.

## Local Verification

- `npm run build`: passed.
- `npm run typecheck`: passed.
- `npm test`: all workspace suites passed: CLI 38/38, Core 392 passed and 9 optional live PostgreSQL tests skipped (401 total), Bun driver 12/12, Hermes 5/5, MCP 12/12 and Schemas 11/11. PostgreSQL tests were skipped because `TARIC_TEST_DATABASE_URL` was not configured.
- Focused Scope/Action/runtime-gap regressions: 41 passed and 1 optional live PostgreSQL test skipped; Bun transport/authorization suite: 12/12 passed.
- `npm run verify:matrix`: passed; generated API/operation metadata agrees with the registry.
- `node scripts/verify-clean-consumer.mjs`: passed for isolated package tarballs, startup/migration, restart reads, CLI persistence and Bun driver imports.
- `node scripts/check-doc-links.mjs`: passed after current-source documentation was added.
- CLI gateway tests passed, including Unix RPC, TLS TCP and HTTPS operation dispatch. CLI control-plane help inventory contains 60 commands; the model-facing MCP inventory remains six tools.

## Evidence Limits

The live PostgreSQL suite did not run in this verification. No BreachWeave workspace was changed or used to claim host conformance, and the BreachWeave `localAcceptance` gate must be rerun against this source before describing integration as accepted. Cross-physical-host coordination, network-partition recovery, production credentials/egress policy and disaster-recovery evidence remain separate deployment checks. The isolated consumer test validates local tarball contents and dependency closure, not registry publication.
