import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SCHEMA_VERSION } from "@taric/schemas";
import { ArtifactContentStore } from "./artifact-content-store.js";
import { uuidv7 } from "./identity.js";
import { createCoreService, type ApiResponse, type CoreService, type Principal } from "./service.js";
import { createPrincipal } from "./adapter.js";
import { AuthorityStore, type CanonicalRecord } from "./store.js";
import type { AuthorityRuntimeScenario } from "./storage-contract.js";

export interface AuthorityConformanceRestoreFixture {
  store: AuthorityStore;
  restart: (current: AuthorityStore) => Promise<AuthorityStore>;
  close?: () => Promise<void>;
}

/** Hooks are supplied only by explicitly isolated integration fixtures. A live
 * authority startup must consume a saved report, never execute these scenarios. */
export interface AuthorityRuntimeConformanceFixture {
  isolated: true;
  restart: (current: AuthorityStore) => Promise<AuthorityStore>;
  /** Install an actual database failure trigger for this event, execute the
   * callback, and remove the trigger in finally. The callback observes rejection. */
  withAuditFailure: (eventType: string, operation: () => Promise<void>) => Promise<void>;
}

// Response data deliberately spans the twelve domain contracts. Assertions
// below check the observable shape before consuming fields across domains.
type Data = Record<string, any>;
const sha256 = (body: Uint8Array | string): string => `sha256:${createHash("sha256").update(body).digest("hex")}`;
const policyDigest = sha256("taric-runtime-conformance-policy");
const codeIs = (code: string) => (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && error.code === code);
function successful(response: ApiResponse<unknown>): Data {
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) throw new Error("Core conformance operation failed");
  return response.data as Data;
}
function failed(response: ApiResponse<unknown>, code: string): void {
  assert.equal(response.ok, false, JSON.stringify(response));
  if (response.ok) throw new Error("Core conformance operation unexpectedly succeeded");
  assert.equal(response.error.code, code);
}
const claimCandidate = (engagement_id: string, overrides: Data = {}): Data => ({
  schema_version: SCHEMA_VERSION, engagement_id, kind: "claim", proposition: "conformance candidate",
  status: "proposed", evidence_refs: [], limitations: ["isolated synthetic fixture"], ...overrides,
});
const proposalEnvelope = (engagement_id: string, content: Data, overrides: Data = {}): Data => ({
  engagement_id, subject_type: content.kind, expected_version: 0, content, ...overrides,
});
const checkpointFor = (run: Data, overrides: Data = {}): Data => ({
  work_item_ref: run.work_item_id, work_run_ref: run.run_id, attempt_ref: run.attempt_ref,
  generation: run.generation, target_version: run.target_version, work_item_version: run.work_item_version,
  scope_ref: run.scope_ref, scope_version: run.scope_version, owner: run.owner, lease_expires_at: run.lease_expires_at,
  source_read_seq: run.read_seq, completed_steps: ["captured visible observation"], next_steps: ["verify evidence"],
  observation_refs: [], evidence_refs: [], negative_results: [], unresolved_work: [], host_decision_refs: [],
  external_action_state: "none", budget: { actions: 0 }, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [],
  context_manifest: { context_snapshot_id: uuidv7(), read_seq: run.read_seq, builder_version: "conformance/1" }, ...overrides,
});

/** One real Core runtime suite shared by SQLite and PostgreSQL. No backend
 * governance logic or SQLite shadow state is part of this harness. Each domain
 * creates its own Engagement inside the caller's disposable database/schema. */
export function createAuthorityRuntimeScenarios(
  store: AuthorityStore,
  contentRoot: string,
  restoreFactory: () => Promise<AuthorityConformanceRestoreFixture>,
  fixture: AuthorityRuntimeConformanceFixture,
): Record<AuthorityRuntimeScenario, () => Promise<readonly string[]>> {
  assert.equal(fixture.isolated, true, "runtime conformance requires an explicitly isolated fixture");
  assert.equal(typeof fixture.restart, "function", "runtime conformance requires a real persistence restart");
  assert.equal(typeof fixture.withAuditFailure, "function", "runtime conformance requires a database failure injection");
  let authority = store;
  const core = (): Promise<CoreService> => createCoreService(authority, contentRoot);
  const invoke = async (service: CoreService, operation: string, principal: Principal, input: Data = {}): Promise<Data> => successful(await service.dispatch(operation, principal, input));
  const domain = async (name: string) => {
    const service = await core();
    const initialized = successful(await service.init({ name: `isolated-${name}`, scope: {
      allowed_targets: ["https://conformance.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:isolated-conformance",
    } }));
    const engagement_id = String(initialized.id);
    return { service, engagement_id,
      model: createPrincipal("model", "fixture-author", engagement_id),
      operator: createPrincipal("operator", "fixture-operator", engagement_id),
      writer: createPrincipal("writer", "fixture-writer", engagement_id),
      host: createPrincipal("host", "fixture-host", engagement_id),
      reviewer: createPrincipal("reviewer", "fixture-reviewer", engagement_id),
    };
  };
  const state = async (engagement_id: string) => ({
    proposals: await authority.proposals(engagement_id), records: await authority.list(engagement_id, { includeCandidates: true }),
    events: await authority.events(), pending_outbox: (await authority.doctor()).pending_outbox,
  });
  const artifactState = async (engagement_id: string, session_id: string) => ({
    catalog: await authority.artifactCatalogRows({ engagement_id, session_id }),
    uploads: await authority.artifactUploads({ engagement_id, session_id }),
    publications: await authority.artifactPublications({ engagement_id, session_id }),
  });
  const itemFor = async (engagement_id: string): Promise<CanonicalRecord> => authority.createRecord({
    schema_version: SCHEMA_VERSION, engagement_id, kind: "work_item", title: "verify isolated contract", status: "queued", acceptance_criteria: ["evidence verified"],
  }, "L2");
  const runFor = async (ctx: Awaited<ReturnType<typeof domain>>, extra: Data = {}) => {
    const workItem = await itemFor(ctx.engagement_id);
    const run = await authority.claimWorkRun({ work_item_id: workItem.id, engagement_id: ctx.engagement_id, host_id: ctx.host.id, agent_id: ctx.model.id, ttl_ms: 300_000, ...extra });
    return { workItem, run: run as Data };
  };
  const findingFor = async (name: string) => {
    const ctx = await domain(name);
    const scope = (await authority.list(ctx.engagement_id)).find((record) => record.kind === "scope");
    assert.ok(scope);
    const claim = await authority.createRecord(claimCandidate(ctx.engagement_id), "L1");
    const evidence = await authority.createRecord({ schema_version: SCHEMA_VERSION, engagement_id: ctx.engagement_id, kind: "evidence",
      artifact_ref: { host_ref: "host:isolated-sample" }, observed_at: new Date().toISOString(), limitations: ["synthetic"],
    }, "L1");
    const proposal = await invoke(ctx.service, "proposal.submit", ctx.model, proposalEnvelope(ctx.engagement_id, {
      schema_version: SCHEMA_VERSION, engagement_id: ctx.engagement_id, kind: "finding", title: "isolated finding", status: "draft",
      claim_refs: [claim.id], evidence_refs: [evidence.id], applicable_scope_ref: scope.id, limitations: ["synthetic"], reproducibility: "repeat isolated fixture",
    }));
    const admission = await invoke(ctx.service, "admission.evaluate", ctx.operator, { engagement_id: ctx.engagement_id,
      proposal_id: proposal.id, expected_version: 0, policy_digest: policyDigest,
    });
    const review = await invoke(ctx.service, "review.submit", ctx.reviewer, { engagement_id: ctx.engagement_id,
      proposal_id: proposal.id, reviewer_id: ctx.reviewer.id, reviewer_kind: "reviewer", input_hash: proposal.content_hash,
      policy_digest: policyDigest, verdict: "pass",
    });
    assert.equal(review.accepted, true);
    const promotion = { engagement_id: ctx.engagement_id, proposal_id: proposal.id, target_id: admission.record.id,
      expected_version: admission.record.version, input_hash: proposal.content_hash, evidence_snapshot_hash: review.evidence_snapshot_hash,
      policy_digest: policyDigest, review_refs: [review.id],
    };
    return { ...ctx, evidence, proposal, admission, review, promotion };
  };

  return {
    async proposal() {
      const ctx = await domain("proposal");
      const before = await state(ctx.engagement_id);
      const foreignEvidence = await authority.createRecord({ schema_version: SCHEMA_VERSION, engagement_id: uuidv7(), kind: "evidence",
        artifact_ref: { host_ref: "host:foreign-fixture" }, observed_at: new Date().toISOString(), limitations: ["foreign synthetic fixture"],
      }, "L1");
      const afterForeign = await state(ctx.engagement_id);
      assert.equal(afterForeign.records.length, before.records.length);
      const invalid = [
        proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id, { kind: undefined }), { subject_type: "claim" }),
        proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id, { proposition: undefined })),
        proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id), { subject_type: "finding" }),
        proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id, { id: uuidv7() })),
        proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id, { trust_level: "L2" })),
        proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id, { evidence_refs: [uuidv7()] })),
        proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id, { evidence_refs: [foreignEvidence.id] })),
      ];
      for (const input of invalid) {
        failed(await ctx.service.dispatch("proposal.submit", ctx.model, input), "validation_error");
        assert.deepEqual(await state(ctx.engagement_id), afterForeign, "invalid proposal has zero authority mutation");
      }
      const input = proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id), { client_request_id: "isolated-proposal", idempotency_key: uuidv7() });
      const proposed = await invoke(ctx.service, "proposal.submit", ctx.model, input);
      assert.equal(proposed.status, "pending"); assert.equal(proposed.canonical_id, undefined);
      assert.equal("id" in proposed.content, false);
      assert.deepEqual(await invoke(ctx.service, "proposal.submit", ctx.model, input), proposed);
      const submittedState = await state(ctx.engagement_id);
      failed(await ctx.service.dispatch("proposal.submit", ctx.model, { ...input, content: claimCandidate(ctx.engagement_id, { proposition: "rebound" }) }), "idempotency_conflict");
      assert.deepEqual(await state(ctx.engagement_id), submittedState);
      assert.equal(submittedState.proposals.length, 1);
      assert.equal(submittedState.records.some((record) => record.kind === "claim"), false);
      return ["real Core proposal boundary rejects missing kind, privileged identity, absent/foreign refs with zero mutation", "request-bound proposal idempotency preserves one pending envelope"];
    },
    async review() {
      const ctx = await findingFor("review");
      const input = { engagement_id: ctx.engagement_id, proposal_id: ctx.proposal.id, reviewer_id: ctx.reviewer.id,
        reviewer_kind: "reviewer", input_hash: ctx.proposal.content_hash, policy_digest: policyDigest, verdict: "pass", idempotency_key: uuidv7(),
      };
      const before = await state(ctx.engagement_id);
      failed(await ctx.service.dispatch("review.submit", { ...ctx.reviewer, id: "forged" }, input), "authorization_error");
      failed(await ctx.service.dispatch("review.submit", ctx.model, input), "authorization_error");
      assert.deepEqual(await state(ctx.engagement_id), before);
      const wrong = await invoke(ctx.service, "review.submit", ctx.reviewer, { ...input, input_hash: sha256("different proposal"), idempotency_key: uuidv7() });
      assert.equal(wrong.accepted, false);
      const self = createPrincipal("reviewer", ctx.model.id, ctx.engagement_id);
      assert.equal((await invoke(ctx.service, "review.submit", self, { ...input, reviewer_id: self.id, idempotency_key: uuidv7() })).accepted, false);
      const review = await invoke(ctx.service, "review.submit", ctx.reviewer, input);
      assert.equal(review.accepted, true); assert.equal(review.proposal_hash, ctx.proposal.content_hash);
      assert.match(review.evidence_snapshot_hash, /^sha256:[a-f0-9]{64}$/); assert.match(review.review_hash, /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(await invoke(ctx.service, "review.submit", ctx.reviewer, input), review);
      return ["authenticated principal controls review identity and author cannot review own proposal", "immutable proposal/evidence/review hashes and request-bound review retries are verified"];
    },
    async admission_l1() {
      const ctx = await domain("l1");
      const claim = await authority.createRecord(claimCandidate(ctx.engagement_id), "L1");
      const proposal = await invoke(ctx.service, "proposal.submit", ctx.model, proposalEnvelope(ctx.engagement_id, {
        schema_version: SCHEMA_VERSION, engagement_id: ctx.engagement_id, kind: "finding", title: "evidence pending", status: "draft",
        claim_refs: [claim.id], evidence_refs: [], limitations: ["awaiting evidence"],
      }));
      const admitted = await invoke(ctx.service, "admission.evaluate", ctx.operator, { engagement_id: ctx.engagement_id,
        proposal_id: proposal.id, expected_version: 0, policy_digest: policyDigest, idempotency_key: uuidv7(),
      });
      assert.equal(admitted.trust_phase, "machine_approved"); assert.equal(admitted.record.trust_level, "L1");
      assert.ok(admitted.remaining_l2_requirements.includes("evidence")); assert.ok(admitted.remaining_l2_requirements.includes("independent_review"));
      assert.equal("gates" in admitted, false);
      assert.equal((await authority.list(ctx.engagement_id)).some((record) => record.id === admitted.record.id), false);
      assert.equal((await authority.list(ctx.engagement_id, { includeCandidates: true })).some((record) => record.id === admitted.record.id), true);
      assert.notEqual(admitted.record.id, proposal.id); assert.match(admitted.record.id, /^[a-f0-9]{8}-[a-f0-9]{4}-7/);
      return ["L1 reports machine_approved with explicit remaining evidence and independent-review requirements", "candidate UUIDv7 is Core allocated and excluded from ordinary fact recall"];
    },
    async admission_l2() {
      const ctx = await findingFor("l2");
      const before = await state(ctx.engagement_id);
      for (const principal of [ctx.model, ctx.host, ctx.reviewer]) {
        failed(await ctx.service.dispatch("admission.promote_l2", principal, ctx.promotion), "authorization_error");
        assert.deepEqual(await state(ctx.engagement_id), before);
      }
      failed(await ctx.service.dispatch("admission.promote_l2", ctx.writer, { ...ctx.promotion, expected_version: 999 }), "stale_version");
      failed(await ctx.service.dispatch("admission.promote_l2", ctx.writer, { ...ctx.promotion, input_hash: sha256("wrong") }), "conflict");
      failed(await ctx.service.dispatch("admission.promote_l2", ctx.writer, { ...ctx.promotion, evidence_snapshot_hash: sha256("wrong") }), "stale_version");
      assert.equal((await ctx.service.dispatch("admission.promote_l2", ctx.writer, { ...ctx.promotion, review_refs: [] })).ok, false);
      assert.deepEqual(await state(ctx.engagement_id), before);
      const input = { ...ctx.promotion, idempotency_key: uuidv7() };
      const promoted = await invoke(ctx.service, "admission.promote_l2", ctx.writer, input);
      assert.equal(promoted.trust_phase, "independently_verified"); assert.equal(promoted.record.trust_level, "L2");
      assert.equal(promoted.record.status, "verified"); assert.equal(promoted.record.id, ctx.promotion.target_id);
      assert.deepEqual(await invoke(ctx.service, "admission.promote_l2", ctx.writer, input), promoted);
      const stale = await findingFor("l2-stale");
      await authority.compareAndSet(stale.evidence.id, Number(stale.evidence.version), { statement: "changed evidence" });
      const changed = await state(stale.engagement_id);
      failed(await stale.service.dispatch("admission.promote_l2", stale.writer, stale.promotion), "stale_version");
      assert.deepEqual(await state(stale.engagement_id), changed);
      return ["writer-only L2 promotion binds independent review, fixed proposal/evidence hash and expected canonical version", "changed evidence fails stale_version without mutation; successful promotion and retry yield one L2 fact"];
    },
    async checkpoint() {
      const ctx = await domain("checkpoint"); const { run } = await runFor(ctx);
      const checkpoint = checkpointFor(run);
      const before = await state(ctx.engagement_id);
      for (const [extra, code] of [
        [{ owner: { host_id: "different", agent_id: ctx.model.id } }, "authorization_error"],
        [{ attempt_ref: uuidv7() }, "conflict"], [{ work_item_version: 999 }, "stale_version"],
        [{ target_version: 999 }, "stale_version"], [{ scope_version: 999 }, "stale_version"],
        [{ hidden_reasoning: "private chain" }, "validation_error"], [{ budget: { hidden_reasoning: "nested" } }, "validation_error"],
      ] as Array<[Data, string]>) {
        await assert.rejects(authority.commitCheckpoint(String(run.run_id), Number(run.generation), ctx.host.id, { ...checkpoint, ...extra }), codeIs(code));
        assert.deepEqual(await state(ctx.engagement_id), before);
      }
      const committed = await authority.commitCheckpoint(String(run.run_id), Number(run.generation), ctx.host.id, checkpoint);
      assert.equal((await authority.getWorkRun(String(run.run_id)))?.checkpoint_id, committed.checkpoint_id);
      const resumed = await authority.resumePacket(String(run.run_id), ctx.host.id) as Data;
      assert.equal(resumed.checkpoint.checkpoint_id, committed.checkpoint_id);
      assert.deepEqual(resumed.checkpoint.completed_steps, checkpoint.completed_steps);
      assert.doesNotMatch(JSON.stringify(resumed), /private chain|hidden_reasoning/);
      return ["checkpoint rejects forged owner, Attempt, target/WorkItem/Scope version and nested hidden reasoning without mutation", "committed executable checkpoint survives resume with fixed visible state"];
    },
    async action() {
      const ctx = await domain("action"); const { run } = await runFor(ctx); const action_id = uuidv7();
      const common = { action_id, run_id: String(run.run_id), generation: Number(run.generation), host_id: ctx.host.id, mode: "host_hitl" as const };
      const before = await state(ctx.engagement_id);
      await assert.rejects(authority.recordActionIntent({ ...common, status: "executed", result_ref: "host:too-early" }), codeIs("conflict"));
      assert.deepEqual(await state(ctx.engagement_id), before);
      assert.equal((await authority.recordActionIntent({ ...common, target: "/admin", method: "GET", status: "recommended" })).status, "recommended");
      await assert.rejects(authority.recordActionIntent({ ...common, status: "authorized" }), codeIs("validation_error"));
      await authority.recordActionIntent({ ...common, status: "authorized", host_decision_ref: "host:decision" });
      await authority.recordActionIntent({ ...common, status: "unknown", host_decision_ref: "host:decision" });
      const unknown = await state(ctx.engagement_id);
      await assert.rejects(authority.recordActionIntent({ ...common, status: "executed", host_decision_ref: "host:decision", result_ref: "host:result" }), codeIs("conflict"));
      assert.deepEqual(await state(ctx.engagement_id), unknown);
      assert.equal((await authority.pendingActionIntents(String(run.run_id))).filter((entry) => entry.action_id === action_id && entry.status === "unknown").length, 1);
      assert.equal((await authority.reconcileAction(String(run.run_id), Number(run.generation), "host:result", "executed", action_id, ctx.host.id)).status, "executed");
      assert.equal((await authority.pendingActionIntents(String(run.run_id))).some((entry) => entry.action_id === action_id), false);
      return ["action cannot skip recommendation/host authorization or turn unknown into an executed result automatically", "unknown action stays pending until explicit current-owner reconciliation"];
    },
    async artifact() {
      const ctx = await domain("artifact"); const session_id = `session-${uuidv7()}`; const sessionRoot = join(contentRoot, session_id);
      await invoke(ctx.service, "artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root: sessionRoot });
      const reader = createPrincipal("host", ctx.host.id, ctx.engagement_id, ["content_read"]);
      const body = Buffer.from([0, 255, 42, 10, 8, 1]); const content_hash = sha256(body);
      const begin = await invoke(ctx.service, "artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream" });
      const append = { engagement_id: ctx.engagement_id, session_id, upload_id: begin.upload_id, ordinal: 0, data: body.toString("base64"), chunk_hash: content_hash };
      await invoke(ctx.service, "artifact.store.append", ctx.host, append);
      assert.equal((await invoke(ctx.service, "artifact.store.append", ctx.host, append)).idempotent, true);
      const committed = await invoke(ctx.service, "artifact.store.commit", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.upload_id,
        total_bytes: body.length, chunk_count: 1, content_hash, idempotency_key: uuidv7(),
      });
      authority = await fixture.restart(authority); const restarted = await core();
      const read = await invoke(restarted, "artifact.content.read", reader, { engagement_id: ctx.engagement_id, session_id, content_ref: committed.content_ref });
      assert.deepEqual(Buffer.from(read.data, "base64"), body); assert.equal(read.chunk_verified, true);
      const row = await authority.artifactCatalogRow(ctx.engagement_id, session_id, String(committed.content_ref)); assert.ok(row);
      await writeFile(join(sessionRoot, String(row.relative_dir), "payload-000001.part"), Buffer.from([1, 2, 3, 4, 5, 6]));
      failed(await restarted.dispatch("artifact.content.read", reader, { engagement_id: ctx.engagement_id, session_id, content_ref: committed.content_ref }), "conflict");
      await rm(join(sessionRoot, String(row.relative_dir), "payload-000001.part"));
      failed(await restarted.dispatch("artifact.content.read", reader, { engagement_id: ctx.engagement_id, session_id, content_ref: committed.content_ref }), "unavailable_host");
      const faultSession = `fault-${uuidv7()}`;
      const artifacts = new ArtifactContentStore(contentRoot, authority, { fault: (point) => { if (point === "after_publication_marker") throw new Error("isolated publication stop"); } });
      await artifacts.initialize(); await artifacts.bind({ engagement_id: ctx.engagement_id, session_id: faultSession, root: join(contentRoot, faultSession) });
      const upload = await artifacts.begin({ engagement_id: ctx.engagement_id, session_id: faultSession, payload_kind: "binary", media_type: "application/octet-stream" });
      await artifacts.append({ engagement_id: ctx.engagement_id, session_id: faultSession, upload_id: String(upload.upload_id), ordinal: 0, data: body.toString("base64"), chunk_hash: content_hash });
      await assert.rejects(artifacts.commit({ engagement_id: ctx.engagement_id, session_id: faultSession, upload_id: String(upload.upload_id), total_bytes: body.length, content_hash }), /isolated publication stop/);
      assert.equal((await authority.artifactCatalogRows()).some((entry) => entry.session_id === faultSession), false);
      authority = await fixture.restart(authority);
      const recovered = new ArtifactContentStore(contentRoot, authority); await recovered.initialize();
      const rows = (await authority.artifactCatalogRows()).filter((entry) => entry.session_id === faultSession);
      assert.equal(rows.length, 1); assert.equal(rows[0]!.content_status, "available"); assert.equal(rows[0]!.integrity_status, "verified");
      assert.deepEqual(Buffer.from(String((await recovered.read({ engagement_id: ctx.engagement_id, session_id: faultSession, content_ref: String(rows[0]!.content_ref) })).data), "base64"), body);
      return ["real Core binary upload/catalog/read survives authority restart; corrupt and missing chunks fail closed", "publication-marker fault exposes no premature catalog row and restart recovers only verified bytes"];
    },
    async lease() {
      const ctx = await domain("lease"); const before = await state(ctx.engagement_id);
      await assert.rejects(authority.claimWorkRun({ engagement_id: ctx.engagement_id, work_item_id: uuidv7(), host_id: ctx.host.id, agent_id: ctx.model.id }), codeIs("validation_error"));
      assert.deepEqual(await state(ctx.engagement_id), before);
      const workItem = await itemFor(ctx.engagement_id);
      const competing = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => authority.claimWorkRun({ engagement_id: ctx.engagement_id,
        work_item_id: workItem.id, host_id: `host-${index}`, agent_id: `agent-${index}`, ttl_ms: 60_000,
      })));
      const winners = competing.filter((entry): entry is PromiseFulfilledResult<Record<string, unknown>> => entry.status === "fulfilled");
      assert.equal(winners.length, 1); assert.equal(competing.filter((entry) => entry.status === "rejected").length, 7);
      const run = winners[0]!.value as Data;
      assert.equal((await authority.getWorkRun(String(run.run_id)))?.generation, run.generation);
      const shortened = await authority.renewWorkRun(String(run.run_id), Number(run.generation), String(run.owner.host_id), 20);
      assert.ok(Date.parse(String(shortened.lease_expires_at)) - Date.parse(String(shortened.heartbeat_at)) <= 20);
      await delay(40);
      await assert.rejects(authority.renewWorkRun(String(run.run_id), Number(run.generation), String(run.owner.host_id)), codeIs("stale_version"));
      const reclaimed = await authority.reclaimWorkRun(String(run.run_id), "replacement-host", "replacement-agent", 60_000);
      assert.equal(reclaimed.generation, Number(run.generation) + 1); assert.notEqual(reclaimed.attempt_ref, run.attempt_ref);
      return ["lease requires existing same-Engagement WorkItem; eight concurrent claims yield exactly one owner", "server expiry fences renew and reclaim creates one new generation and Attempt"];
    },
    async fencing() {
      const ctx = await domain("fencing"); const session_id = `fence-${uuidv7()}`;
      await invoke(ctx.service, "artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root: join(contentRoot, session_id) });
      const { run } = await runFor(ctx, { task_session_ref: session_id });
      const body = Buffer.from("fenced upload"); const content_hash = sha256(body);
      const upload = await invoke(ctx.service, "artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "text", media_type: "text/plain",
        work_run_id: String(run.run_id), attempt_id: String(run.attempt_ref), generation: Number(run.generation),
      });
      await invoke(ctx.service, "artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: String(upload.upload_id), ordinal: 0, data: body.toString("base64"), chunk_hash: content_hash });
      await authority.renewWorkRun(String(run.run_id), Number(run.generation), ctx.host.id, 20); await delay(40);
      await authority.reclaimWorkRun(String(run.run_id), "replacement-host", "replacement-agent", 60_000);
      const before = await state(ctx.engagement_id);
      const artifactBefore = await artifactState(ctx.engagement_id, session_id);
      const rejected = [
        () => authority.renewWorkRun(String(run.run_id), Number(run.generation), ctx.host.id),
        () => authority.transitionWorkRun(String(run.run_id), Number(run.generation), ctx.host.id, "running"),
        () => authority.commitCheckpoint(String(run.run_id), Number(run.generation), ctx.host.id, checkpointFor(run)),
        () => authority.recordActionIntent({ run_id: String(run.run_id), generation: Number(run.generation), host_id: ctx.host.id, status: "recommended", mode: "host_hitl", target: "/admin", method: "GET" }),
        () => authority.reconcileAction(String(run.run_id), Number(run.generation), "result:stale", "executed", uuidv7(), ctx.host.id),
        () => authority.validateArtifactFence({ engagement_id: ctx.engagement_id, session_id, work_run_id: String(run.run_id), attempt_id: String(run.attempt_ref), generation: Number(run.generation), principal: ctx.host.id }),
        () => authority.recordHostError({ engagement_id: ctx.engagement_id, work_run_id: String(run.run_id), generation: Number(run.generation), host_id: ctx.host.id, error_ref: "host:stale-error" }),
      ];
      for (const operation of rejected) {
        await assert.rejects(operation(), codeIs("stale_version"));
        assert.deepEqual(await state(ctx.engagement_id), before);
        assert.deepEqual(await artifactState(ctx.engagement_id, session_id), artifactBefore);
      }
      for (const [operation, input] of [
        ["artifact.store.begin", { engagement_id: ctx.engagement_id, session_id, payload_kind: "text", media_type: "text/plain", work_run_id: String(run.run_id), attempt_id: String(run.attempt_ref), generation: Number(run.generation) }],
        ["artifact.store.append", { engagement_id: ctx.engagement_id, session_id, upload_id: String(upload.upload_id), ordinal: 1, data: body.toString("base64"), chunk_hash: content_hash }],
        ["artifact.store.commit", { engagement_id: ctx.engagement_id, session_id, upload_id: String(upload.upload_id), total_bytes: body.length, content_hash }],
        ["error.report", { engagement_id: ctx.engagement_id, work_run_id: String(run.run_id), generation: Number(run.generation), error_ref: "host:stale-error" }],
      ] as const) {
        failed(await ctx.service.dispatch(operation, ctx.host, input), "stale_version");
        assert.deepEqual(await state(ctx.engagement_id), before);
        assert.deepEqual(await artifactState(ctx.engagement_id, session_id), artifactBefore);
      }
      const stale = await authority.submitProposal(proposalEnvelope(ctx.engagement_id, claimCandidate(ctx.engagement_id)) as Parameters<AuthorityStore["submitProposal"]>[0], {
        workRunId: String(run.run_id), generation: Number(run.generation), principal: ctx.model.id, principalRole: "model",
      });
      assert.equal(stale.status, "rejected"); assert.equal((await authority.list(ctx.engagement_id, { includeCandidates: true })).some((record) => record.id === stale.canonical_id), false);
      return ["reclaimed generation fences run transition, checkpoint, action, reconciliation, Core Artifact begin/append/commit and Core error reporting with zero authority mutation", "stale model proposal is explicitly quarantined and cannot create a canonical record"];
    },
    async audit_outbox() {
      const ctx = await domain("audit");
      const initialEvents = await authority.events();
      const records = await Promise.all(Array.from({ length: 8 }, (_, index) => authority.createRecord(claimCandidate(ctx.engagement_id, { proposition: `parallel ${index}` }), "L1")));
      assert.equal(new Set(records.map((record) => record.display_id)).size, records.length);
      const events = await authority.events();
      assert.deepEqual(events.map((event) => event.commit_seq), Array.from({ length: events.length }, (_, index) => index + 1));
      assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);
      assert.equal((await authority.verifyAudit()).valid, true);
      const pending = (await authority.doctor()).pending_outbox;
      const batches = await Promise.all([authority.consumeOutbox(10_000), authority.consumeOutbox(10_000)]);
      const drained = batches.flat();
      assert.equal(new Set(drained.map((row) => row.commit_seq)).size, drained.length);
      assert.equal(drained.length, pending); assert.equal((await authority.doctor()).pending_outbox, 0);
      assert.deepEqual(drained.map((row) => Number(row.commit_seq)).filter((sequence) => sequence > initialEvents.length).sort((a, b) => a - b), events.slice(initialEvents.length).map((event) => event.commit_seq));
      const before = await state(ctx.engagement_id); const rejectedId = uuidv7(); const key = uuidv7();
      await fixture.withAuditFailure("record.commit", async () => {
        await assert.rejects(authority.commit({ id: rejectedId, engagement_id: ctx.engagement_id, kind: "claim", proposition: "must roll back" }, "L1", key, { principal: ctx.writer.id, engagement_id: ctx.engagement_id }));
      });
      assert.equal(await authority.get(rejectedId), undefined); assert.deepEqual(await state(ctx.engagement_id), before);
      const committed = await authority.commit({ id: rejectedId, engagement_id: ctx.engagement_id, kind: "claim", proposition: "must roll back" }, "L1", key, { principal: ctx.writer.id, engagement_id: ctx.engagement_id });
      assert.equal(committed.commit_seq, events.length + 1, "failed transaction does not consume global event order");
      assert.equal((await authority.verifyAudit()).valid, true);
      return ["concurrent records retain globally unique display IDs and gap-free audit hash order; outbox consumers cannot duplicate events", "database event failure atomically rolls back record, event, outbox and idempotency before a successful same-key retry"];
    },
    async pinned_read() {
      const ctx = await domain("pin");
      const initial = await Promise.all(Array.from({ length: 7 }, (_, index) => authority.createRecord(claimCandidate(ctx.engagement_id, { proposition: `pinned ${index}` }), "L1")));
      const page = await authority.recordsPage({ engagement_id: ctx.engagement_id, include_candidates: true, page_size: 2, principal_id: ctx.operator.id, cursor_key_root: contentRoot });
      const expected = await authority.snapshot(ctx.engagement_id, { asOf: page.read_seq, includeCandidates: true });
      await authority.compareAndSet(initial[0]!.id, Number(initial[0]!.version), { proposition: "newer version" });
      const newer = await authority.createRecord(claimCandidate(ctx.engagement_id, { proposition: "newer record" }), "L1");
      const seen = [...page.records]; let cursor = page.next_cursor;
      while (cursor) {
        const next = await authority.recordsPage({ engagement_id: ctx.engagement_id, include_candidates: true, page_size: 2, principal_id: ctx.operator.id, cursor_key_root: contentRoot, cursor });
        assert.equal(next.read_seq, page.read_seq); seen.push(...next.records); cursor = next.next_cursor;
      }
      assert.equal(new Set(seen.map((record) => record.id)).size, seen.length);
      assert.deepEqual(seen.map((record) => record.id).sort(), expected.records.map((record) => record.id).sort());
      assert.equal(seen.some((record) => record.id === newer.id), false);
      assert.equal(seen.find((record) => record.id === initial[0]!.id)?.proposition, "pinned 0");
      assert.deepEqual((await authority.snapshot(ctx.engagement_id, { asOf: page.read_seq, includeCandidates: true })).records, expected.records);
      assert.equal((await authority.getAt(initial[0]!.id, page.read_seq))?.version, initial[0]!.version);
      return ["keyset continuation retains the same authority read sequence with no duplicate or omitted record", "later inserts and updates remain absent from pinned pages, snapshots and getAt"];
    },
    async backup_restore() {
      const ctx = await domain("backup");
      const created = await authority.createRecord(claimCandidate(ctx.engagement_id, { proposition: "original backup version" }), "L1");
      const updated = await authority.compareAndSet(created.id, Number(created.version), { proposition: "version retained after restore" });
      const backup = await authority.exportSnapshot(ctx.engagement_id);
      assert.equal(backup.schema_version, SCHEMA_VERSION); assert.match(backup.hash, /^sha256:[a-f0-9]{64}$/);
      const sourceEvents = await authority.events();
      const destination = await restoreFactory(); let restored = destination.store;
      try {
        assert.notEqual(restored, authority, "restore target must be an independent authority");
        assert.equal(typeof destination.restart, "function", "restore fixture requires a real persistence restart");
        const empty = await restored.events();
        assert.deepEqual(empty, [], "restore fixture must start with an empty independent authority");
        await assert.rejects(restored.importSnapshot({ ...backup, hash: sha256("corrupt") }), codeIs("validation_error"));
        assert.deepEqual(await restored.events(), empty);
        assert.equal((await restored.list(ctx.engagement_id, { includeCandidates: true })).length, 0);
        await assert.rejects(restored.importSnapshot({ ...backup, schema_version: "99.0.0" }), codeIs("unsupported_schema_version"));
        assert.deepEqual(await restored.events(), empty);
        const result = await restored.importSnapshot(backup);
        assert.equal(result.integrity_verified, true); assert.equal(result.imported_records, backup.records.length);
        assert.deepEqual((await restored.list(ctx.engagement_id, { includeCandidates: true })).map((record) => record.id).sort(), backup.records.map((record) => record.id).sort());
        const current = await restored.get(created.id); assert.ok(current);
        assert.equal(current.version, updated.version); assert.equal(current.display_id, updated.display_id);
        assert.equal(current.proposition, updated.proposition); assert.equal((await restored.verifyAudit()).valid, true);
        restored = await destination.restart(restored);
        assert.equal((await restored.get(created.id))?.version, updated.version);
        const postRestore = await restored.compareAndSet(created.id, Number(updated.version), { proposition: "post restart CAS" });
        assert.equal(postRestore.version, Number(updated.version) + 1);
        assert.equal(postRestore.display_id, updated.display_id); assert.equal((await restored.verifyAudit()).valid, true);
        const sourceAfterRestore = await authority.get(created.id);
        assert.deepEqual(sourceAfterRestore && { id: sourceAfterRestore.id, version: sourceAfterRestore.version, display_id: sourceAfterRestore.display_id, proposition: sourceAfterRestore.proposition },
          { id: updated.id, version: updated.version, display_id: updated.display_id, proposition: updated.proposition },
          "destination writes cannot change the source authority");
        assert.deepEqual(await authority.events(), sourceEvents);
      } finally {
        if (destination.close) await destination.close(); else await restored.close();
      }
      return ["integrity and schema version failures leave an independent restore destination unmodified", "atomic restore preserves identity/version/display alias and valid audit; real restart supports expected-version CAS"];
    },
  };
}
