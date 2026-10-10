# Tasks

本清单只覆盖 `proposal.md` 和 `design.md` 定义的 Phase 0–1 单机首发。所有任务保持未完成状态，直到对应验证证据产生；不能通过修改 normative docs、main specs 或 README 把未实现能力标记为完成。每项任务均要求实现代码、测试和支持文档同步落地。

依赖关系：1→2；2→3/4；3+4→5/6/8；5+6+8→7/9；3+7+8+9→10；4+5+7→11；10+11→12；1–12→13。同一依赖层中互不写同一模块的任务可并行，所有写路径必须经过 3–5 的公共 guard。任务组 13 是跨组 release gate；组 14 仅登记 follow-up 依赖，不属于本 change 的实现。

## 1. Phase 0 baseline and contract registry

- [x] 1.1 Freeze the supported single-host profile and Pi host version/commit in a machine-readable compatibility manifest; list DeepSeek, Hermes, PostgreSQL, remote push, and full evaluation as `unsupported_capability`, and verify diagnostics expose the same manifest.
- [x] 1.2 Freeze the supported reference/tools/kb, reference/link, PTES, and pentest-skills source commits for design input only; verify no old KB/Link runtime, schema, CLI, or format compatibility is advertised.
- [x] 1.3 Define the Phase 1 API, error, capability, schema, trust, coverage, and adapter version registry from `docs/taric-design.md`; verify every supported operation has request, response, error, and unsupported behavior contracts.
- [x] 1.4 Define the non-goal registry and security invariants: no platform, model provider, agent loop, worker scheduler, target execution, action grant, HITL identity, credential/Artifact-content management, cross-Engagement auto-sharing, or legacy format compatibility; verify poisoning input cannot change these flags.
- [x] 1.5 Add a clean-checkout command that installs dependencies, builds all workspaces, then runs tests without pre-existing `dist`; verify stdout/stderr and nonzero failures are deterministic.

## 2. Phase 0 schema and validation foundation

- [x] 2.1 Add strict Phase 1 contracts for Engagement, Scope, Resource, Observation, Claim, Evidence, Finding, ProtectiveControl, ControlObservation, AccessDecisionObservation, Coverage, WorkItem, WorkRun, Attempt, Checkpoint, ActionIntent, Proposal, Review, AuditEvent, API envelopes, and unsupported-capability errors; verify missing, extra, malformed, and invalid-enum fields are rejected.
- [ ] 2.2 Add cross-field and cross-reference validators for engagement ownership, reference kinds, time ranges, provenance, scope, evidence limitations, trust transitions, legal WorkRun/action states, and `decision_layer/origin_reached/origin_outcome`; verify invalid examples fail closed with structured errors.
- [x] 2.3 Route every Core write path, including internal writer calls, through the shared validator; verify direct transport bypass cannot persist invalid records or caller-supplied trust/admission/display IDs.
- [x] 2.4 Add schema version identifiers and compatibility checks for the local SQLite authority; verify unsupported schema versions fail before writes and no legacy format is imported or migrated implicitly.
- [x] 2.5 Generate TypeScript types and Python-facing fixtures from the same Phase 1 schemas; verify Pi, CLI, MCP, and Core tests consume identical field definitions.

## 3. Core service and authority boundary

- [ ] 3.1 Implement the versioned single-host Core service for every supported Phase 1 operation and return declared success or structured error envelopes; verify deferred operations return `unsupported_capability`.
- [ ] 3.2 Introduce transport-verified principals and engagement capabilities for model, Pi host, reviewer, writer, and operator operations; verify self-asserted role/host/engagement fields cannot grant access.
- [x] 3.3 Remove public model/Pi access to `AuthorityStore.db` and canonical writer; expose scoped clients only; verify no model-facing integration can reach `.db` or `commit`.
- [x] 3.4 Add idempotency records bound to operation, principal, engagement, and normalized request hash; verify retries return the original result and key reuse with another payload returns a conflict.
- [ ] 3.5 Add stable validation, authorization, stale-version, conflict, unsupported-capability, unsupported-schema-version, unavailable-host, and internal error codes; verify CLI/MCP/Pi preserve codes and do not fail open.

## 4. SQLite authority, IDs, snapshots, and audit

- [ ] 4.1 Refactor record, proposal, review, admission, canonical mutation, event, idempotency, display-ID, and outbox writes into short atomic SQLite WAL transactions; inject failures and verify complete commit or no visible commit.
- [ ] 4.2 Enforce installation-wide unique monotonic display IDs allocated only by Core; preserve aliases across revisions and reject caller IDs; verify 100 concurrent workers across multiple engagements produce no duplicates or resets.
- [ ] 4.3 Move expected-version, scope, owner, lease, and generation checks into the same transaction as every mutation; verify concurrent CAS and fencing never silently last-write-wins.
- [ ] 4.4 Implement true as-of snapshots and fixed-sequence continuation with stable ordering, read-your-writes, committed/projected watermarks, and no gaps/duplicates; verify a query never mixes current state into an older sequence.
- [ ] 4.5 Implement versioned append-only audit events with actor/host/worker/dispatch/WorkItem/Attempt/proposal/review/entity/policy/input/evidence/idempotency/changed-field metadata; verify every governance/canonical transition emits an attributable event without Artifact or credential contents.
- [ ] 4.6 Implement local outbox consumption, doctor/reconcile status, startup verification, and consistent snapshot export sufficient to inspect single-host state; verify failures are explicit and import/migration/backup/restore requests return `unsupported_capability` without altering authority history.

## 5. Governance and writer isolation

- [x] 5.1 Make model-facing capture, observation, proposal, and draft operations proposal-only; reject caller trust level, admission status, policy result, display ID, or direct Markdown/database writes; verify canonical records remain unchanged.
- [ ] 5.2 Make proposal submission, review, rejection, admission, canonical mutation, audit, idempotency, and outbox updates atomic; inject failure at each boundary and verify retryable proposal/no partial admission.
- [ ] 5.3 Implement deterministic admission checks for schema, references, scope, base version, evidence/provenance, policy digest, and legal transition; verify missing checks fail closed and remain auditable.
- [ ] 5.4 Implement the minimum independent L2 review gate: service-verified reviewer capability, fixed proposal/evidence snapshot, author/worker/reviewer independence, reviewer context without earlier verdict text, and retained model/policy/input hashes; verify self-review/unbound reviewer promotion fails.
- [ ] 5.5 Implement atomic L2 promotion with evidence freshness, limitations, reproducibility, applicability, review hash, policy digest, and explicit finding status; verify unauthorized L1→L2 promotion is zero.
- [ ] 5.6 Implement retract, supersede, archive, stale, review-after, and expiry recall filters needed by Phase 1; verify current recall excludes them while authorized as-of history retains prior state and audit.

## 6. Minimum controls and coverage

- [x] 6.1 Implement minimal ProtectiveControl, ControlObservation, AccessDecisionObservation, and non-secret authentication/session metadata contracts; verify control outcome and access decision stay separate and bind to resource/identity/operation/conditions.
- [x] 6.2 Add hard guards for unknown layer, missing origin evidence, edge block with origin not reached, and suspected fingerprint attribution; verify unknown responses cannot be attributed to a specific control/origin.
- [x] 6.3 Implement dimension-preserving Coverage cells for resource, test category, identity, operation/parameter, conditions, status, limitations, evidence, and time; verify one identity/operation result leaves other cells open.
- [x] 6.4 Implement bounded negative observations with method, baseline/control, conditions, identity, limitations, and evidence references; verify no string heuristic converts a negative observation into universal absence.
- [x] 6.5 Implement the minimum coverage close gate exposing untested, blocked, blocked-by-control, negative-only, unverified-positive, conflicting, and un-ingested external results; verify edge blocks never close origin coverage and the gate never grants action authorization.

## 7. Context, recall, and trust filtering

- [x] 7.1 Build fixed-sequence Context Packs that prioritize scope/ROE, worker role/risk budget, WorkItem goals/acceptance, latest checkpoint, relevant direct changes, entities/evidence, then background; verify mandatory constraints survive budget pressure.
- [x] 7.2 Add context snapshot ID, declared token/character budget, adapter/builder/policy manifest, source IDs/hashes/times/versions, authorized slice byte/line/HTTP locations and permission metadata, omitted/truncated ranges, and explicit unexamined markers; verify over-budget requests return structured continuation/minimum-budget errors.
- [x] 7.3 Implement opaque continuation cursors bound to principal, engagement, filters, pinned sequence, ordering, and budget; verify continuation has no gaps/duplicates and cannot cross engagements.
- [x] 7.4 Apply trust/permission filtering to query, Context Pack, Brief, Index, and model-facing output: L0 and unrequested L1 are absent from ordinary facts; explicit L1 candidates carry provenance, limitations, and evidence refs.
- [x] 7.5 Preserve independent reviewer context from a fixed sequence without earlier verdict text; verify context/query results never expose raw Artifact, credentials, private paths, unreviewed proposals, or sensitive drafts.

## 8. WorkRun, Attempt, checkpoint, and fencing baseline

- [ ] 8.1 Add WorkItem reference validation, explicit Attempt records, and legal queued/claimed/running/checkpointed/blocked/completed/failed/cancelled/lost transitions; verify terminal or actively leased runs cannot be reclaimed illegally.
- [ ] 8.2 Implement atomic claim, heartbeat, renewal, expiry, reclaim, owner change, and old-Attempt-lost transitions with fencing generation; verify expired owners cannot renew or claim current state.
- [ ] 8.3 Implement the complete minimum Checkpoint schema: WorkItem/scope/target version, completed steps, observations/evidence refs, negative results, unresolved hypotheses/work, host decision refs, external action state, next steps, budget, draft/handoff refs, context manifest, source `read_seq`, owner, Attempt, lease, and generation; reject hidden reasoning and invalid refs.
- [ ] 8.4 Bind proposal, observation, evidence, restricted patch, checkpoint, ActionIntent, host decision, and result writes to active Attempt/generation in one transaction; verify stale writes are rejected/quarantined with original attribution.
- [ ] 8.5 Implement resume with latest checkpoint, fixed source sequence, pending actions, current scope/WorkItem/authorization checks, and blocked/replan advice when current premises cannot be confirmed; do not claim full dependency delta or draft rebase support.
- [ ] 8.6 Implement external action idempotency and unknown-result reconciliation without automatic replay; verify reconciliation is audited before unknown state is resolved.

## 9. Action recommendation and host outcomes

- [ ] 9.1 Implement structured `action.recommend` input/output with target/method, rationale, uncertainty, constraints, memory refs, and no execution/grant fields; verify recommendation cannot invoke tools or mutate authorization.
- [ ] 9.2 Validate host-selected `llm_recommend`, `authorized_autonomous`, and `host_hitl` modes without a Taric global default; store only opaque host decision/authorization references.
- [ ] 9.3 Implement legal ActionIntent transitions with owner/Attempt/generation, idempotency, target/method metadata, and atomic audit; verify denied/authorized/executed/failed/unknown states cannot skip required transitions.
- [ ] 9.4 Quarantine late results under the old Attempt/generation; verify they cannot appear as current observations or trigger automatic target action replay.

## 10. Executable CLI, MCP, and Pi adapter

- [x] 10.1 Implement the CLI binary, configuration discovery, JSON input/output, stderr diagnostics, nonzero exits, and Phase 1 dispatch; verify `taric --help`, invalid commands, and `unsupported_capability` behave predictably.
- [x] 10.2 Implement MCP stdio initialize/tools/list/tools/call through the model capability boundary; verify stdout contains protocol JSON only and canonical commit/admission/checkpoint commit, credentials, arbitrary paths, and target tools are unavailable.
- [ ] 10.3 Implement authenticated local Core client transport for Pi with no store/DB handle exposure; verify engagement capabilities and host identity are checked before writes.
- [ ] 10.4 Implement real Pi lifecycle hooks for session/context/proposal/checkpoint/action/result/error paths for the pinned supported host version; verify callbacks run in a host contract test and reload is idempotent.
- [x] 10.5 Register only the documented Phase 1 model tools; verify DeepSeek/Hermes adapter operations and their lifecycle hooks return `unsupported_capability` and do not simulate support.
- [ ] 10.6 Run CLI/MCP/Pi subprocess/host contract tests from a clean build; verify repeated idempotent calls and unauthorized calls produce stable responses with no partial writes.

## 11. Projection and local Git

- [x] 11.1 Generate distinct Engagement Brief and Attack Surface Index views with explicit field allowlists, trust labels, watermarks, generation manifest, file hashes, and authority sequence; verify canaries for raw Artifact, SecretRef, token, private path, unreviewed proposal, and sensitive draft are absent.
- [x] 11.2 Stage complete immutable generations and atomically switch a current pointer without deleting reader-pinned generations; verify concurrent readers see complete old or new generations only.
- [x] 11.3 Enforce principal/engagement/generation projection permissions; reject cross-engagement and arbitrary-path reads without metadata leakage.
- [x] 11.4 Create local Git checkpoints by default when enabled, binding commit to manifest and authority sequence; verify commit failure leaves authority intact with pending/retry status.
- [x] 11.5 Keep remote push and external secrets scanner unsupported; verify no boolean configuration can claim a remote scan or push succeeded.
- [x] 11.6 Document host-owned Artifact retention/redaction and Taric-owned projection filtering without changing normative design docs or implying Artifact storage.

## 12. Documentation and unsupported surface

- [x] 12.1 Update only change-local proposal/design/tasks and implementation-facing package documentation to describe the single-host profile; do not modify `docs/taric-design.md` or main specs to hide deferred behavior.
- [x] 12.2 Publish the supported capability matrix and explicit follow-up references: `integrate-native-host-adapters`, `evolve-engagement-memory`, `validate-memory-quality`, and `add-shared-authority-backend`; verify diagnostics, CLI, MCP, and Pi report identical unsupported names.
- [x] 12.3 Verify no example claims full `taric-design.md` implementation, cross-Engagement sharing, native DeepSeek/Hermes support, complete graph/Impact, statistical quality completion, PostgreSQL, or target action execution.
- [x] 12.4 Verify every deferred design requirement is mapped to an existing follow-up proposal/spec/task with prerequisites and release gate in the handoff register; fail handoff validation for missing capability coverage, missing files, ambiguous owner, or completion claims.

## 13. Single-host release gates

- [x] 13.1 Run 100-worker, multi-engagement concurrency tests for UUID/display IDs, idempotency, CAS, fixed-sequence reads, fencing, and generation publication; require zero duplicate IDs, lost events, stale writes, or partial projections.
- [x] 13.2 Inject crashes at SQLite transaction, outbox, checkpoint, action, schema-compatibility rejection, projection, and local Git boundaries; require complete recovery or explicit repair state with no silent success.
- [x] 13.3 Run deterministic poisoning and permission-bypass tests over HTTP/tool/Markdown/proposal inputs and malicious reviewer/model payloads; require unchanged policy, trust, writer capability, host authorization, scope, and allowlists.
- [x] 13.4 Verify the minimum independent L2 gate, bounded negative/blocked coverage, active WorkRun checkpoint/lease/context/action state, and no automatic target action replay.
- [x] 13.5 Enforce single-host patch-to-query visibility p95 ≤2 seconds only after a documented Phase 0 baseline; if it fails, block the release report. Do not substitute this gate for deferred precision/recall/95% CI evaluation.
- [x] 13.6 Produce a single-host release report naming code/schema/policy/fixture commits and every pass/fail/unsupported capability; a failed required gate prevents an implementation-complete report.

## 14. Follow-up handoff register (not part of this change)

| Follow-up change | 本 change 提供的前置契约 | 后续交付与验收范围 |
|---|---|---|
| `integrate-native-host-adapters` | Core transport、capability/adapter registry、Pi/MCP conformance baseline | DeepSeek/Hermes 原生 adapter、installation/diagnostics、真实 host version CI 与 native/MCP 等价测试 |
| `evolve-engagement-memory` | authority versions、固定 read sequence、受限 CAS proposal、checkpoint/action baseline、local projection | revisions/variants、typed graph、PatchSet merge/conflict、ImpactEvent、resume delta、advanced retrieval/cache、snapshot import/round-trip、migration/backup/restore、remote Git push/真实 secrets scan |
| `validate-memory-quality` | stable governance/independent L2 gate、query/context/coverage/projection、versioned security fixtures | 完整 corpus、poisoning benchmark、human baseline、precision/recall/unsupported-claim metrics、95% CI、mature replay/reconcile evaluation |
| `add-shared-authority-backend` | SQLite storage interface、ID/CAS/lease/event/outbox conformance fixtures | PostgreSQL、multi-host lease/event ordering、shared backup/restore、deployment runbook 与跨后端 conformance |
