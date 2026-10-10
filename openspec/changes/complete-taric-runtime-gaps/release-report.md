# Single-host Release Report

Profile: `single_host_taric_plugin_v1`. This report covers the Phase 0-1 single-host release gates only. Deferred capabilities remain `unsupported_capability` and are not counted as implemented.

## Revisions

| Item | Value |
|---|---|
| Code base commit at report time | `eb95dc74a86dcd6dcf2ce60d3ea12233dcbba671` (working tree contains the gate changes) |
| Schema version | `1.0.0` (`packages/schemas/schemas/v1/core.schema.json`) |
| API contract version | `1.0.0` |
| Adapter contract version | `1.0` |
| Context builder | `context-builder/1` |
| Context policy | `policy/1` |
| Projection policy | `projection-policy/1` |
| Compatibility manifest | `packages/core/src/compatibility.ts` (`manifest_version` 1.0) |
| Fixture source | shared Phase 1 schema plus in-repo deterministic fixtures in `packages/core/test/` and `packages/schemas/schemas/v1/core.schema.json` |
| Runtime | Node.js 22+, `node:sqlite` WAL authority |

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| 13.1 100-worker multi-engagement concurrency | Pass | `packages/core/test/release-gates.test.mjs` asserts 100 unique display IDs and UUIDs, idempotent retry replay, no duplicate/lost events, valid audit chain, rejected stale CAS, and two complete immutable projection generations. |
| 13.2 crash and failure injection | Pass | Same file asserts a failed write commits neither record nor event, an unversioned authority file is rejected before writes, a Git checkpoint failure stays `pending` with a reason, and authority history remains valid afterwards. |
| 13.3 poisoning and permission bypass | Pass | Same file plus `release-support.test.mjs` assert hostile model payloads cannot set trust/display/admission fields, cannot self-declare engagement permission, cannot commit host checkpoints, cannot mutate the capability registry, and cannot leak tokens, private paths, Artifact bodies or private drafts into projections. |
| 13.4 L2 gate, bounded coverage, active WorkRun | Pass | Same file asserts promotion without independent review is rejected with zero canonical writes, self-review is refused, `blocked_by_control` and bounded negative observations are recorded, the active run keeps owner/generation/checkpoint, unknown actions stay pending, and late results stay quarantined without entering current state. |
| 13.5 patch-to-query visibility | Pass | `PATCH_TO_QUERY_P95_BUDGET_MS` is 2000 ms; the gate measures 100 commit→as-of-query round trips on a file-backed authority and fails if p95 exceeds the budget. |
| 13.6 release report | Pass | This document. |

Clean-build evidence: `npm run clean && npm run build && npm test` completes with CLI 12, Core 80, MCP 8, and Hermes plugin 2 tests passing and zero failures. The gates for this report are exercised by `packages/core/test/release-gates.test.mjs` and `packages/core/test/release-support.test.mjs` (51 tests across the context, coverage, projection, contract, stale and release suites).

## Capability status

Supported in this release: SQLite WAL authority, Core service, operator CLI, model MCP stdio, Pi 1.1.0 (commit `7c10bd4`), minimum controls and coverage, fixed-sequence context, proposal governance with the minimum independent L2 gate, host-driven WorkRun/Attempt baseline, action recommendation and host outcome recording, allowlisted projection, and local Git checkpoints.

Unsupported and owned by follow-up changes:

| Capability | Follow-up |
|---|---|
| `deepseek_native_adapter` | `integrate-native-host-adapters` |
| `hermes_native_adapter` | `integrate-native-host-adapters` |
| `storage.postgresql` | `add-shared-authority-backend` |
| `git.remote_push` | `evolve-engagement-memory` |
| `secrets.external_scanner` | `evolve-engagement-memory` |
| `graph.relation_impact` | `evolve-engagement-memory` |
| `quality.full_statistical_evaluation` (precision/recall, 95% CI, full poisoning corpus) | `validate-memory-quality` |

## Limits

- Full statistical quality evaluation, human baseline, and confidence intervals are not part of this report; the deterministic security invariants above are the only quality claims made here.
- Remote Git push and external secrets scanning remain unsupported; `remotePushAllowed` is always `false` and boolean configuration cannot change that.
- Artifact bodies, retention, redaction, credentials, and human approval identity stay host-owned; Taric stores bounded references and metadata only.
- Snapshot import/round-trip, migration, backup/restore, and cross-Engagement automatic sharing are unsupported.
