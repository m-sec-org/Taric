import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, ContractValidationError, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

function workItem(store, engagement_id = uuidv7()) {
  const id = uuidv7();
  store.commit({ id, engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["evidence"] }, "L2");
  return { id, engagement_id };
}

function checkpoint(run, work_item_ref, extra = {}) {
  return {
    work_item_ref,
    work_run_ref: run.run_id,
    attempt_ref: run.attempt_ref ?? run.attempt_id,
    generation: run.generation,
    target_version: run.target_version,
    work_item_version: run.work_item_version,
    scope_version: run.scope_version,
    owner: run.owner,
    lease_expires_at: run.lease_expires_at,
    source_read_seq: run.read_seq ?? 0,
    completed_steps: [],
    next_steps: ["verify"],
    observation_refs: [],
    evidence_refs: [],
    negative_results: [],
    unresolved_work: [],
    host_decision_refs: [],
    external_action_state: "none",
    budget: { actions: 0 },
    draft_refs: [],
    handoff_refs: [],
    action_refs: [],
    tool_result_refs: [],
    context_manifest: { context_snapshot_id: uuidv7(), read_seq: run.read_seq ?? 0, builder_version: "test" },
    ...extra,
  };
}

test("work claims create an explicit attempt and reclaim fences the old generation", async () => {
  const store = new AuthorityStore();
  const item = workItem(store);
  const first = store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi-a", agent_id: "worker-a", ttl_ms: 1_000 });
  assert.equal(first.status, "claimed");
  assert.ok(first.attempt_ref ?? first.attempt_id, "claim returns an explicit attempt reference");
  assert.throws(() => store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi-b", agent_id: "worker-b" }), /active leased WorkRun/i);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.throws(() => store.renewWorkRun(first.run_id, first.generation, "pi-a", 60_000), /expired|fenced|stale/i);
  const second = store.reclaimWorkRun(first.run_id, "pi-b", "worker-b", 60_000);
  assert.equal(second.generation, first.generation + 1);
  assert.equal(second.owner.host_id, "pi-b");
  assert.throws(() => store.renewWorkRun(first.run_id, first.generation, "pi-a", 60_000), /expired|fenced|stale/i);
  store.close();
});

test("checkpoint commit requires the complete executable boundary and rejects hidden reasoning or foreign refs", () => {
  const store = new AuthorityStore();
  const item = workItem(store);
  const run = store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi", agent_id: "worker" });
  assert.throws(() => store.commitCheckpoint(run.run_id, run.generation, "pi", { completed_steps: [] }), /reference|invalid|missing|required/i);
  assert.throws(() => store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id, { hidden_reasoning: "secret" })), /hidden reasoning/i);
  assert.throws(() => store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id, { observation_refs: [uuidv7()] })), /reference|invalid|missing/i);
  assert.throws(() => store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id, { evidence_refs: [item.id] })), /reference kind mismatch|must reference/i);
  assert.throws(() => store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id, { action_refs: [item.id] })), /reference kind mismatch|must reference/i);
  const committed = store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id));
  assert.equal(committed.work_item_ref, item.id);
  assert.equal(store.getWorkRun(run.run_id).checkpoint_id, committed.checkpoint_id);
  store.close();
});

test("action intents cannot skip recommendation or authorization and stale results stay quarantined", () => {
  const store = new AuthorityStore();
  const item = workItem(store);
  const run = store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi", agent_id: "worker" });
  const action_id = uuidv7();
  assert.throws(() => store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "executed", result_ref: "host:result:early", host_id: "pi" }), /transition|recommended|authorized/i);
  const recommended = store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", target: "/admin", method: "GET", host_id: "pi" });
  assert.equal(recommended.status, "recommended");
  assert.throws(() => store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "authorized", host_id: "pi" }), /decision reference|required/i);
  store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "authorized", host_decision_ref: "host:decision:1", host_id: "pi" });
  store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "unknown", host_decision_ref: "host:decision:1", host_id: "pi" });
  assert.throws(() => store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "executed", host_decision_ref: "host:decision:1", result_ref: "host:result:1", host_id: "pi" }), /explicit host reconciliation/i);
  const reconciled = store.reconcileAction(run.run_id, run.generation, "host:result:1", "executed", action_id, "pi");
  assert.equal(reconciled.status, "executed");
  const late = store.recordLateResult({ run_id: run.run_id, generation: run.generation - 1, result_ref: "host:result:late", result: { status: "executed" } });
  assert.equal(late.status, "late_result_quarantine");
  assert.equal(store.pendingActionIntents(run.run_id).some((entry) => entry.result_ref === "host:result:late"), false);
  store.close();
});

test("work run and active Attempt use the same legal transition fence", () => {
  const store = new AuthorityStore();
  const item = workItem(store);
  const run = store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi", agent_id: "worker" });
  const checkpointed = store.transitionWorkRun(run.run_id, run.generation, "pi", "checkpointed");
  assert.equal(checkpointed.status, "checkpointed");
  assert.throws(() => store.transitionWorkRun(run.run_id, run.generation, "pi", "claimed"), /illegal|transition/i);
  assert.throws(() => store.transitionWorkRun(run.run_id, run.generation, "other-host", "running"), /fenced|owner|lease/i);
  store.close();
});

test("checkpoint proposals stay L0 and stale Attempt proposals are quarantined", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const item = workItem(store);
  const model = createPrincipal("model", "worker-a", item.engagement_id);
  const run = store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi-a", agent_id: model.id });
  const checkpointCandidate = {
    source_read_seq: run.read_seq,
    completed_steps: [],
    next_steps: ["verify"],
    observation_refs: [],
    evidence_refs: [],
    negative_results: [],
    unresolved_work: [],
    host_decision_refs: [],
    external_action_state: "none",
    budget: { actions: 0 },
    draft_refs: [],
    handoff_refs: [],
    action_refs: [],
    tool_result_refs: [],
    context_manifest: { context_snapshot_id: uuidv7(), read_seq: run.read_seq, builder_version: "test" },
  };
  const proposed = service.dispatch("checkpoint.propose", model, { engagement_id: item.engagement_id, work_run_id: run.run_id, generation: run.generation, checkpoint: checkpointCandidate });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.data.status, "pending");
  assert.equal(store.getWorkRun(run.run_id).checkpoint_id, undefined);

  await awaitReclaim(store, run.run_id);
  const stale = service.dispatch("checkpoint.propose", model, { engagement_id: item.engagement_id, work_run_id: run.run_id, generation: run.generation, checkpoint: checkpointCandidate });
  assert.equal(stale.ok, true);
  assert.equal(stale.data.status, "rejected");
  assert.ok(store.events().some((event) => event.event_type === "proposal.stale_attempt_quarantine"));
  store.close();
});

test("service action recommendation flows through host decision and result without execution", () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const item = workItem(store);
  const host = createPrincipal("host", "pi", item.engagement_id);
  const run = store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: host.id, agent_id: "worker" });
  const recommendation = service.dispatch("action.recommend", host, { engagement_id: item.engagement_id, work_run_id: run.run_id, generation: run.generation, target: "/admin", method: "GET", rationale: "verify exposure", scope: "in-scope" });
  assert.equal(recommendation.ok, true);
  assert.equal(recommendation.data.execution, undefined);
  const actionId = recommendation.data.recommendation_id;
  const decision = service.dispatch("action.host-decision", host, { engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation, mode: "host_hitl", status: "authorized", host_decision_ref: "decision:1" });
  assert.equal(decision.ok, true);
  const result = service.dispatch("action.host-result", host, { engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation, mode: "host_hitl", status: "executed", result_ref: "result:1", host_decision_ref: "decision:1" });
  assert.equal(result.ok, true);
  assert.equal(store.getActionIntent(actionId).status, "executed");
  store.close();
});

async function awaitReclaim(store, runId) {
  const run = store.getWorkRun(runId);
  store.renewWorkRun(runId, run.generation, run.owner.host_id, 5);
  await new Promise((resolve) => setTimeout(resolve, 10));
  store.reclaimWorkRun(runId, "pi-b", "worker-b");
}

