# Tasks

## 1. Baseline, contracts, and release evidence

- [ ] 1.1 Freeze the supported reference/tools/kb, reference/link, PTES, and pentest-skills source commits in a machine-readable baseline manifest, and verify the manifest is included in diagnostics and release reports.
- [ ] 1.2 Freeze the Pi, DeepSeek Harness, and Hermes host version/commit compatibility matrix, and verify an unlisted version is reported as unsupported rather than inferred compatible.
- [ ] 1.3 Define the Taric API, error, capability, adapter, and schema version registry from `docs/taric-api.md` and `docs/taric-design.md`, and verify every documented operation has a request, response, and error contract.
- [ ] 1.4 Add versioned known-positive, known-negative, blocked-by-control, stale, conflict, and poisoning fixtures for representative web and host scenarios, and verify fixture metadata includes expected coverage and trust outcomes.
- [ ] 1.5 Add a clean-checkout script that installs dependencies, builds all workspaces, then runs tests, and verify it passes without pre-existing `dist` directories.

## 2. Schema and validation foundation

- [ ] 2.1 Expand `packages/schemas` with strict contracts for TestHypothesis, ResourceRevision, ProtectiveControl and revision, ControlObservation, AccessDecisionObservation, PatchSet, Conflict, ImpactEvent, AttackPath, authentication metadata/session revision, WorkRun, Attempt, Checkpoint, ActionIntent, AuditEvent, and all API envelopes, and verify Ajv rejects missing, extra, malformed, and invalid-enum fields.
- [ ] 2.2 Add cross-field and cross-reference validators for engagement ownership, reference kind, time ranges, state transitions, origin/control semantics, evidence limitations, trust-level transitions, and required provenance, and verify every documented invalid example returns a structured validation error.
- [ ] 2.3 Route every Core write path through the shared validator before persistence, including direct internal calls, and verify bypassing the transport cannot persist an invalid record.
- [ ] 2.4 Add schema migration identifiers and compatibility checks, and verify an unsupported schema version fails before any write.
- [ ] 2.5 Generate TypeScript types and Python-facing contract fixtures from the same schemas, and verify Pi, DeepSeek, Hermes, CLI, and MCP contract tests consume identical field definitions.

## 3. Core service and authority boundary

- [ ] 3.1 Implement a versioned Core service facade for every operation in the runtime API spec, and verify each operation returns its declared success or structured error envelope.
- [ ] 3.2 Introduce transport-verified principals and Taric engagement capability checks for model, host adapter, reviewer, writer, and operator operations, and verify self-asserted role fields cannot grant access.
- [ ] 3.3 Remove public model/adapter access to the database handle and canonical writer; expose only scoped clients, and verify an integration test cannot reach `AuthorityStore.commit` or `.db` from a model-facing client.
- [ ] 3.4 Add idempotency records bound to operation, principal, engagement, and normalized request hash, and verify retries return the original result while key reuse with a different payload returns a conflict.
- [ ] 3.5 Add stable error codes for validation, authorization, stale version, conflict, unavailable host, unsupported capability, migration, and internal failures, and verify CLI/MCP/native adapters preserve those codes.

## 4. Durable storage, IDs, and recovery

- [ ] 4.1 Refactor record, proposal, review, admission, revision, event, idempotency, display-ID, and outbox writes into short atomic transactions, and verify forced process termination yields complete commit or no visible commit.
- [ ] 4.2 Enforce installation-wide unique monotonic display identifiers allocated only by Core and keep the alias stable across revisions, and verify 100 concurrent writers across engagements produce no duplicate or reset sequence.
- [ ] 4.3 Move expected-version, scope, owner, lease, and generation checks into the same transaction as each mutation, and verify concurrent CAS tests never silently use last-write-wins.
- [ ] 4.4 Implement true as-of snapshots with pinned authority sequence, stable ordering, indexed/projected watermarks, and read-your-writes behavior, and verify writes are visible at returned commit sequence while stale indexes are labeled.
- [ ] 4.5 Implement versioned canonical audit event encoding with actor/host/worker/dispatch/WorkItem/Attempt/proposal/review/entity/policy/input/evidence/idempotency/changed-field metadata, and verify all governance and canonical transitions emit one attributable event.
- [ ] 4.6 Implement outbox consumption, doctor, replay, reconcile, materialized-view drift reporting, and explicit rebuild actions, and verify rebuild never edits authoritative history silently.
- [ ] 4.7 Implement versioned JSON/JSONL snapshot export/import with integrity metadata and conflict checks, and verify a round trip preserves records, revisions, provenance, and source sequence while malformed imports leave the destination unchanged.
- [ ] 4.8 Implement local schema migrations and backup/restore verification for the default SQLite store, and verify upgrade, restart, and restore reports the recovered sequence and validation result.

## 5. Governance and writer isolation

- [ ] 5.1 Make model-facing capture, observation, patch, and draft operations proposal-only and reject caller-supplied trust level, admission status, policy result, or display ID, and verify canonical records remain unchanged.
- [ ] 5.2 Make proposal submission, review, rejection, admission, canonical mutation, audit, idempotency, and outbox updates atomic, and verify a failure at each boundary leaves a retryable proposal and no partial admission.
- [ ] 5.3 Implement deterministic admission checks for schema, references, scope, base version, evidence, provenance, policy digest, and legal state transition, and verify missing checks fail closed and remain auditable.
- [ ] 5.4 Implement service-verified reviewer capability, fixed proposal/evidence snapshot binding, reviewer/worker/author independence, and independent review context without earlier verdict text, and verify self-review and unbound reviewer promotion fail.
- [ ] 5.5 Implement atomic L2 promotion with evidence freshness, limitations, reproducibility, applicability, review input hash, and policy digest checks, and verify unauthorized L1-to-L2 promotion rate is zero in the release suite.
- [ ] 5.6 Implement retract, supersede, archive, stale, review-after, and expiry transitions with append-only audit events and recall filters, and verify historical as-of queries retain the prior state while ordinary recall excludes it.

## 6. Domain revisions, patches, controls, and coverage

- [ ] 6.1 Implement stable logical resource identity, immutable ResourceRevision, variant identity, content hash, source observation, and validity metadata, and verify changed bundle/API content creates a new revision without rewriting the old observation.
- [ ] 6.2 Implement typed Relation revisions with source observations, validity, dependency criticality, and legal removal semantics, and verify relation history is queryable as-of a pinned sequence.
- [ ] 6.3 Implement PatchSet base generation, object base versions, read/write sets, three-way merge for non-overlapping changes, and conflict records for overlapping or destructive changes, and verify no conflicting field is silently lost.
- [ ] 6.4 Implement ImpactEvent dependency traversal with bounded batches, continuation state, criticality ordering, and revalidation WorkItem creation, and verify critical premise withdrawal stales dependent findings/actions while unrelated descriptions do not fan out globally.
- [ ] 6.5 Implement ProtectiveControl and revision persistence plus immutable ControlObservation and AccessDecisionObservation contracts, and verify control outcome and access decision remain separate and bind to resource/identity/operation/condition versions.
- [ ] 6.6 Implement hard guards for unknown layer, missing origin evidence, edge block with origin not reached, and suspected fingerprint attribution, and verify no unknown response is attributed to a specific control or origin.
- [ ] 6.7 Implement dimensioned Coverage Matrix cells and bounded negative observations with baseline, method, conditions, identity, operation, limitations, and evidence references, and verify one identity/operation result does not close other cells.
- [ ] 6.8 Implement blocked-by-control and coverage-close gates that expose untested, blocked, negative-only, unverified-positive, conflicting, and un-ingested external results, and verify a protective edge block never closes origin coverage.

## 7. Context and retrieval

- [ ] 7.1 Implement Context Pack selection priority for scope/ROE, WorkItem acceptance, latest checkpoint, relevant deltas, direct entities, evidence references, and background summaries, and verify mandatory constraints are retained before optional material.
- [ ] 7.2 Add token/character budget declaration, builder/policy manifest, source hashes, omitted/truncated ranges, and explicit unexamined markers, and verify over-budget requests return a structured continuation or minimum-budget error.
- [ ] 7.3 Implement signed/opaque continuation cursors bound to principal, engagement, filters, pinned sequence, ordering, and budget, and verify continuation has no gaps or duplicates and cannot be reused for another engagement.
- [ ] 7.4 Implement candidate/trust/permission filtering for query, context, Brief, Index, and model-facing outputs, and verify L0 and unrequested L1 never appear as ordinary facts.
- [ ] 7.5 Add context cache invalidation and resume delta generation from ImpactEvents and authority sequence changes, and verify a resumed attempt receives all relevant changes since its checkpoint without unrelated noise.

## 8. WorkRun, Attempt, checkpoint, and fencing

- [ ] 8.1 Add explicit Attempt records, WorkItem reference validation, and the documented WorkRun state transition table, and verify illegal terminal, active-lease, and reclaim transitions are rejected.
- [ ] 8.2 Implement atomic claim, heartbeat, lease renewal, expiry, reclaim, owner change, and old-Attempt-lost transitions with fencing generation, and verify an expired owner cannot renew or claim current state.
- [ ] 8.3 Implement strict Checkpoint schema and reference validation for progress, unresolved work, evidence, external action state, next steps, source sequence, owner, Attempt, lease, and generation, and verify arbitrary hidden reasoning or invalid refs are rejected.
- [ ] 8.4 Bind proposal, observation, evidence, patch, checkpoint, ActionIntent, decision, and result writes to the active Attempt/generation in one transaction, and verify stale writes are quarantined with original attribution.
- [ ] 8.5 Implement resume packets with checkpoint, pinned sequence, relevant delta, changed scope/dependencies, pending actions, context manifest, and sealed old drafts, and verify scope or authorization changes yield blocked/replan-required advice.
- [ ] 8.6 Implement external action idempotency and unknown-result reconciliation without automatic replay, and verify result reconciliation is audited before an unknown intent becomes resolved.

## 9. Action recommendation and host outcomes

- [ ] 9.1 Implement structured `action.recommend` input/output with target/method, rationale, uncertainty, constraints, memory references, and no execution/grant fields, and verify recommendations cannot mutate authorization or invoke tools.
- [ ] 9.2 Implement host-selected `llm_recommend`, `authorized_autonomous`, and `host_hitl` mode validation without a Taric global default, and verify Taric records mode and opaque host references only.
- [ ] 9.3 Implement legal ActionIntent decision/result transitions with owner/Attempt/generation, idempotency, target/method metadata, and atomic audit, and verify denied, authorized, executed, failed, and unknown states cannot skip required transitions.
- [ ] 9.4 Add late-result quarantine and explicit review/rebase promotion into current state, and verify a late host result never appears as a new Attempt observation automatically.

## 10. Executable CLI and MCP

- [ ] 10.1 Implement the CLI package binary, configuration discovery, argument parsing, JSON input/output, stderr diagnostics, and nonzero error exits, and verify `taric --help` and an invalid command behave predictably.
- [ ] 10.2 Dispatch all documented operator operations: init/status, context/query/as-of, capture/proposal/review/admission, control/access, resource revise/draft/patch/relation/claim/impact, work claim/renew/checkpoint/resume, action recommend/decision/result/reconcile, audit/reconcile, snapshot, and adapter management/diagnostics, and verify each command reaches the matching Core operation.
- [ ] 10.3 Implement CLI adapter install/remove/config/health/version diagnostics from the compatibility manifest, and verify an unsupported host version returns a diagnostic without installation or capability inflation.
- [ ] 10.4 Implement an MCP stdio process with initialize, tools/list, and tools/call using protocol JSON only on stdout and diagnostics only on stderr, and verify a subprocess handshake succeeds.
- [ ] 10.5 Register only model-facing read/context/proposal/checkpoint.propose/control-proposal/action.recommend tools in MCP, and verify canonical commit, admission, checkpoint commit, credentials, arbitrary paths, and target tools are unavailable.
- [ ] 10.6 Add subprocess tests that run CLI and MCP from a clean build, and verify repeated calls with idempotency keys and unauthorized calls produce stable responses without partial writes.

## 11. Projection, sharing, and Git

- [ ] 11.1 Implement distinct Engagement Brief and Attack Surface Index views with explicit field allowlists, trust labels, watermarks, manifest, and file hashes, and verify raw Artifact, SecretRef, token, private path, unreviewed proposal, and sensitive draft canary values are absent.
- [ ] 11.2 Implement complete generation staging and atomic current-pointer publication without deleting reader-pinned generations, and verify concurrent readers see either a complete old generation or complete new generation.
- [ ] 11.3 Replace boolean/path projection authorization with principal/engagement/generation permission checks, and verify cross-engagement and arbitrary-path reads are denied without metadata leakage.
- [ ] 11.4 Implement default local Git checkpoint commits bound to manifest and authority sequence with pending/retry status, and verify local commit failure leaves authority intact and retryable.
- [ ] 11.5 Implement explicit per-Engagement remote push configuration requiring private repository, access control, retention policy, and successful secrets scan callback, and verify missing or failed safeguards prevent push.
- [ ] 11.6 Document host-owned Artifact retention/redaction and Taric-owned projection filtering, and verify the agent guide does not imply Taric stores or sanitizes Artifact bodies.

## 12. Native adapters and Hermes integration

- [ ] 12.1 Implement authenticated local Core client transport for native adapters with no store/DB handle exposure, and verify transport credentials and engagement capabilities are checked before any write.
- [ ] 12.2 Implement a real Pi extension entry point for tested session/context/proposal/checkpoint/action/result/error hooks, and verify callbacks execute in an actual Pi runtime contract test.
- [ ] 12.3 Implement a pinned DeepSeek Harness Cordis adapter with tested lifecycle/tool hooks and explicit preview compatibility metadata, and verify an untested release falls back to MCP/CLI with missing capabilities reported.
- [ ] 12.4 Implement Hermes Python general plugin RPC hooks for pre-LLM, pre-tool, post-tool, and session end, and verify it coexists without replacing the configured external MemoryProvider.
- [ ] 12.5 Implement adapter install/remove/config/health/version behavior and cancellation/reload error mapping, and verify reload retrieves committed state without duplicate proposal/checkpoint writes.
- [ ] 12.6 Run one shared adapter conformance suite against native and MCP fallback paths, and verify state, identity attribution, pinned reads, action mode, and errors are equivalent where capabilities overlap.

## 13. Quality, security, and release gates

- [ ] 13.1 Add concurrency tests for 100 workers, multiple engagements, display IDs, idempotency, CAS, reader pinning, and generation publication, and verify zero duplicate IDs, lost events, and partial projections.
- [ ] 13.2 Add crash/fault injection at transaction, outbox, checkpoint, action, migration, and projection boundaries, and verify restart recovers or reports explicit repair state with no silent success.
- [ ] 13.3 Add poisoning and permission-bypass tests using HTTP/tool/Markdown/proposal instructions and malicious reviewer/model payloads, and verify policy, trust, writer capability, host authorization, and allowlists remain unchanged.
- [ ] 13.4 Run representative known-positive/negative web/host fixtures through query, review, coverage, projection, and report flows, and verify negative and blocked results remain bounded.
- [ ] 13.5 Produce a quality evaluation report with sample counts, human baseline, retrieval/finding precision and recall, unsupported-claim rate, coverage miss rate, review agreement, recovery success, latency, and 95% confidence intervals, and verify the report names fixture/schema/policy commits.
- [ ] 13.6 Enforce release gates for zero unauthorized L2 promotions, zero high/critical unsupported claims, known-positive recall no worse than baseline, visible coverage gaps, adapter compatibility, and single-host patch visibility p95 at most two seconds, and verify a failed gate blocks a passing release report.
- [ ] 13.7 Update `docs/taric-api.md`, `docs/agent-integration.md`, `docs/taric-design.md`, package READMEs, and support diagnostics with only implemented commands/capabilities, and verify every documented example runs in the clean-checkout environment.

## 14. Conditional multi-host authority

- [ ] 14.1 Define the PostgreSQL backend configuration and deployment guard so it is enabled only when multi-host authority is explicitly selected, and verify the default single-host deployment has no PostgreSQL dependency.
- [ ] 14.2 Implement PostgreSQL transactions, unique display-ID sequence, server-side lease/fencing, event ordering, and outbox behavior behind the storage interface, and verify the storage conformance suite matches SQLite for externally visible behavior.
- [ ] 14.3 Implement multi-host snapshot, backup, restore, and migration verification, and verify a failed restore/import leaves the destination unchanged and reports the recovered sequence.
- [ ] 14.4 Run multi-host failure and reader-pinning tests, and verify shared SQLite files, NFS locks, shared Git clones, and independent SQLite replicas are rejected as unsupported deployments.
- [ ] 14.5 Publish the multi-host compatibility and operational runbook only after the conditional conformance gates pass, and verify the single-host release report clearly marks this phase enabled or not enabled.
