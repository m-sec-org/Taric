import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, buildContextPack, createAccessDecisionObservation, createControlObservation, createCoverageCell, createNegativeObservation, evaluateCoverageGate, uuidv7 } from "../dist/index.js";

test("coverage cells and bounded negative observations preserve conditions", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const resource_ref = uuidv7();
  (await store.commit({ id: resource_ref, engagement_id, kind: "endpoint", name: "/admin" }, "L1"));
  const cell = (await createCoverageCell(store, { engagement_id, resource_ref, test_category: "access-control", status: "blocked_by_control", limitations: ["edge block"] }));
  const negative = (await createNegativeObservation(store, { engagement_id, statement: "未在本次测试条件下观察到越权", method: "GET", baseline_ref: resource_ref, tested_resource_refs: [resource_ref], conditions: ["role=user"], evidence_refs: [], limitations: ["edge block"] }));
  assert.equal(cell.status, "blocked_by_control"); assert.deepEqual(negative.conditions, ["role=user"]);
  (await assert.rejects(async () => (await createNegativeObservation(store, { engagement_id, statement: "vulnerable", method: "GET", tested_resource_refs: [resource_ref], conditions: [], evidence_refs: [], limitations: [] })), /bounded/));
  (await store.close());
});

test("context packs preserve a pinned sequence and mark truncation", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7();
  for (let i = 0; i < 3; i++) (await store.commit({ id: uuidv7(), engagement_id, kind: "note", text: "large note".repeat(20) }, "L2"));
  const pack = (await buildContextPack(store, engagement_id, 220));
  assert.equal(pack.omitted_as_unexamined, true);
  assert.equal(pack.omitted_count_complete, true, "the count of omitted records is complete for this exhausted scan");
  assert.ok(pack.omitted_count > 0 || pack.truncated_count > 0);
  assert.ok(pack.items.length > 0, "bounded incomplete context is not presented as an empty complete result");
  assert.ok(pack.cursor); assert.ok(pack.read_seq > 0);
  (await store.close());
});

test("budget pressure keeps scope and target WorkItem constraints ahead of background", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const scope_id = uuidv7(); const work_item_id = uuidv7();
  for (let i = 0; i < 8; i++) (await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "background filler ".repeat(40) }, "L2"));
  (await store.commit({ id: scope_id, engagement_id, kind: "rule_of_engagement", name: "in-scope host", scope: ["10.0.0.1"], excluded: ["10.0.0.2"] }, "L2"));
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", goal: "verify admin access", acceptance: ["evidence recorded"], risk_budget: { actions: 0 } }, "L2"));
  const pack = (await buildContextPack(store, engagement_id, 500, { workItemId: work_item_id }));
  assert.ok(pack.mandatory_ids.includes(scope_id));
  assert.ok(pack.mandatory_ids.includes(work_item_id));
  const constraints = pack.mandatory_constraints.find((entry) => entry.id === work_item_id).constraints;
  assert.equal(constraints.goal, "verify admin access");
  assert.deepEqual(constraints.risk_budget, { actions: 0 });
  assert.equal(pack.omitted_as_unexamined, true);
  assert.ok(pack.manifest.every((source) => typeof source.hash === "string" && source.hash.startsWith("sha256:")));
  assert.equal(pack.schema_version, "1.0.0");
  assert.equal(pack.adapter_version, "adapter/1.1");
  (await store.close());
});

test("context pack keeps the latest checkpoint mandatory and identifies its worker scope", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const work_item_id = uuidv7();
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", goal: "verify access", acceptance: ["evidence recorded"] }, "L2"));
  const old_checkpoint = (await store.commit({ id: uuidv7(), engagement_id, kind: "checkpoint", work_item_ref: work_item_id, created_at: "2026-01-01T00:00:00.000Z", next_steps: ["old"] }, "L2"));
  const latest_checkpoint = (await store.commit({ id: uuidv7(), engagement_id, kind: "checkpoint", work_item_ref: work_item_id, created_at: "2026-01-02T00:00:00.000Z", next_steps: ["current"] }, "L2"));
  const pack = (await buildContextPack(store, engagement_id, 1000, { workItemId: work_item_id, workerRole: "reviewer" }));
  assert.equal(pack.latest_checkpoint_id, latest_checkpoint.id);
  assert.ok(pack.mandatory_ids.includes(latest_checkpoint.id));
  assert.ok(!pack.mandatory_ids.includes(old_checkpoint.id));
  assert.equal(pack.work_item_id, work_item_id);
  assert.equal(pack.worker_role, "reviewer");
  (await store.close());
});

test("context continuation is bound to principal, engagement, and filters", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const other_engagement = uuidv7();
  for (let i = 0; i < 6; i++) (await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "segment ".repeat(30) }, "L2"));
  const pack = (await buildContextPack(store, engagement_id, 400, { principalId: "worker-a" }));
  assert.ok(pack.cursor);
  const next = (await buildContextPack(store, engagement_id, 400, { principalId: "worker-a", cursor: pack.cursor }));
  assert.equal(next.context_snapshot_id, pack.context_snapshot_id);
  assert.equal(next.read_seq, pack.read_seq);
  (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 400, { principalId: "worker-b", cursor: pack.cursor })), /binding mismatch/));
  (await assert.rejects(async () => (await buildContextPack(store, other_engagement, 400, { principalId: "worker-a", cursor: pack.cursor })), /binding mismatch/));
  (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 401, { principalId: "worker-a", cursor: pack.cursor })), /budget mismatch/));
  (await store.close());
});

test("context trust filtering omits L0 and unrequested L1 and can exclude prior reviewer verdicts", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7();
  const l0 = (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "unreviewed", status: "proposed", evidence_refs: [], limitations: [] } }));
  const l1 = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "candidate", limitations: ["unverified"], evidence_refs: [] }, "L1"));
  const l2 = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "verified" }, "L2"));
  (await store.commit({ id: uuidv7(), engagement_id, kind: "review", verdict: "pass", review_text: "prior verdict" }, "L2"));
  const ordinary = (await buildContextPack(store, engagement_id, 10000));
  assert.ok(!ordinary.sources.includes(l0.id));
  assert.ok(!ordinary.sources.includes(l1.id));
  assert.ok(ordinary.sources.includes(l2.id));
  const reviewer = (await buildContextPack(store, engagement_id, 10000, { includeCandidates: true, reviewerMode: true }));
  const candidate = reviewer.items.find((item) => item.id === l1.id);
  assert.equal(candidate.trust_level, "L1");
  assert.deepEqual(candidate.limitations, ["unverified"]);
  assert.ok(!reviewer.items.some((item) => item.kind === "review"));
  (await store.close());
});

test("context continuation walks every record exactly once", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const scope_id = uuidv7(); const work_item_id = uuidv7();
  (await store.commit({ id: scope_id, engagement_id, kind: "rule_of_engagement", name: "roe", scope: ["10.0.0.0/24"] }, "L2"));
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", goal: "g", acceptance: ["a"], risk_budget: { actions: 0 } }, "L2"));
  for (let i = 0; i < 6; i++) (await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: `segment ${i} `.repeat(25) }, "L2"));
  const seen = []; let cursor; let guard = 0;
  do {
    const page = (await buildContextPack(store, engagement_id, 460, { workItemId: work_item_id, cursor }));
    seen.push(...page.items.map((item) => item.id));
    assert.equal(page.context_snapshot_id, page.context_snapshot_id);
    cursor = page.cursor;
  } while (cursor && guard++ < 20);
  assert.equal(new Set(seen).size, seen.length, "no duplicates across pages");
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen).has(scope_id), true);
  assert.equal(new Set(seen).has(work_item_id), true);
  (await store.close());
});

test("context pack reports the minimum budget needed for mandatory constraints", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const work_item_id = uuidv7();
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", goal: "verify access", acceptance: ["evidence"], risk_budget: { actions: 0 } }, "L2"));
  (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 100, { workItemId: work_item_id })), (error) => {
    assert.equal(error.code, "minimum_budget_required");
    assert.ok(error.minimum_budget > error.requested_budget);
    return true;
  }));
  (await store.close());
});

test("control outcome and access decision stay separate observations", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const resource_ref = uuidv7(); const identity_ref = uuidv7(); const control_ref = uuidv7();
  const control_evidence = uuidv7(); const decision_evidence = uuidv7();
  (await store.commit({ id: resource_ref, engagement_id, kind: "note", statement: "resource:portal" }, "L1"));
  (await store.commit({ id: identity_ref, engagement_id, kind: "note", statement: "identity:service-account" }, "L1"));
  (await store.commit({ id: control_ref, engagement_id, kind: "note", statement: "control:waf" }, "L1"));
  (await store.commit({ id: control_evidence, engagement_id, kind: "note", statement: "evidence:waf-banner" }, "L1"));
  (await store.commit({ id: decision_evidence, engagement_id, kind: "note", statement: "evidence:403-response" }, "L1"));
  const observation = (await createControlObservation(store, {
    engagement_id, resource_ref, operation: "POST /admin", conditions: ["role=user"], outcome: "suspected",
    decision_layer: "edge", origin_reached: false, origin_outcome: "not_reached", evidence_refs: [control_evidence],
    limitations: ["fingerprint based"], control_ref, fingerprint: "cloudfront"
  }));
  const decision = (await createAccessDecisionObservation(store, {
    engagement_id, resource_ref, operation: "POST /admin", conditions: ["role=user"], decision: "deny",
    decision_layer: "edge", origin_reached: false, origin_outcome: "not_reached", evidence_refs: [decision_evidence],
    limitations: [], control_ref, identity_ref, auth_metadata: { scheme: "bearer", principal_class: "service" }
  }));
  assert.equal(observation.kind, "control_observation"); assert.equal(decision.kind, "access_decision_observation");
  assert.equal(decision.identity_ref, identity_ref); assert.notEqual(observation.identity_ref, identity_ref);
  (await store.close());
});

test("control guards reject unknown attribution and evidence-free origin claims", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const resource_ref = uuidv7(); const control_ref = uuidv7();
  (await store.commit({ id: resource_ref, engagement_id, kind: "note", statement: "resource:portal" }, "L1"));
  (await store.commit({ id: control_ref, engagement_id, kind: "note", statement: "control:waf" }, "L1"));
  const base = { engagement_id, resource_ref, operation: "GET /", conditions: ["role=user"], decision_layer: "unknown", origin_reached: "unknown", origin_outcome: "unknown", evidence_refs: [], limitations: [] };
  (await assert.rejects(async () => (await createControlObservation(store, { ...base, outcome: "observed", control_ref })), /unknown decision layer/));
  (await assert.rejects(async () => (await createAccessDecisionObservation(store, { ...base, decision: "deny", control_ref })), /unknown decision layer/));
  (await assert.rejects(async () => (await createControlObservation(store, { ...base, decision_layer: "origin", outcome: "observed", origin_reached: true, origin_outcome: "reached", control_ref })), /requires evidence/));
  (await assert.rejects(async () => (await createControlObservation(store, { ...base, decision_layer: "edge", outcome: "observed", origin_reached: false, origin_outcome: "reached", control_ref })), /not_reached/));
  (await assert.rejects(async () => (await createControlObservation(store, { ...base, decision_layer: "edge", outcome: "observed", origin_reached: false, origin_outcome: "not_reached", auth_metadata: { token: "secret" } })), /non-secret/));
  (await assert.rejects(async () => (await createControlObservation(store, { ...base, decision_layer: "edge", outcome: "observed", origin_reached: false, origin_outcome: "not_reached", fingerprint: "cdn" })), /suspected/));
  (await store.close());
});

test("coverage gate keeps dimensions open and never authorizes actions", () => {
  const cell = (overrides) => ({
    id: uuidv7(), engagement_id: uuidv7(), kind: "coverage", resource_ref: uuidv7(), test_category: "authz",
    conditions: ["role=user"], status: "positive", limitations: [], evidence_refs: [uuidv7()], ...overrides
  });
  const user = cell({ identity_ref: "identity-user", operation: "GET /admin" });
  const admin = cell({ identity_ref: "identity-admin", operation: "GET /admin", status: "not_tested", evidence_refs: [] });
  const result = evaluateCoverageGate([user, admin]);
  assert.equal(result.can_close, false);
  assert.equal(result.action_authorized, false);
  assert.ok(result.gaps.some((gap) => gap.kind === "untested" && gap.cell_ids.includes(admin.id)));
  assert.ok(!result.gaps.some((gap) => gap.cell_ids.includes(user.id)));
});

test("negative observations use structured bounds instead of statement keywords", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const resource_ref = uuidv7();
  (await store.commit({ id: resource_ref, engagement_id, kind: "endpoint", name: "/admin" }, "L1"));
  const negative = (await createNegativeObservation(store, {
    engagement_id,
    statement: "No unauthorized access was observed during this test.",
    method: "GET /admin",
    baseline_ref: resource_ref,
    tested_resource_refs: [resource_ref],
    identity_ref: resource_ref,
    operation: "GET /admin",
    conditions: ["role=user"],
    evidence_refs: [],
    limitations: ["tested one identity and operation"]
  }));
  assert.equal(negative.bounded, true);
  assert.ok(negative.tested_at);
  (await store.close());
});
