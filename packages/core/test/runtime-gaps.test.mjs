import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, ContractValidationError, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

async function workItem(store, engagement_id = uuidv7()) {
  const id = uuidv7();
  (await store.commit({ id, engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["evidence"] }, "L2"));
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
  const item = (await workItem(store));
  const first = (await store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi-a", agent_id: "worker-a", ttl_ms: 1_000 }));
  assert.equal(first.status, "claimed");
  assert.ok(first.attempt_ref ?? first.attempt_id, "claim returns an explicit attempt reference");
  (await assert.rejects(async () => (await store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi-b", agent_id: "worker-b" })), /active leased WorkRun/i));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  (await assert.rejects(async () => (await store.renewWorkRun(first.run_id, first.generation, "pi-a", 60_000)), /expired|fenced|stale/i));
  const second = (await store.reclaimWorkRun(first.run_id, "pi-b", "worker-b", 60_000));
  assert.equal(second.generation, first.generation + 1);
  assert.equal(second.owner.host_id, "pi-b");
  (await assert.rejects(async () => (await store.renewWorkRun(first.run_id, first.generation, "pi-a", 60_000)), /expired|fenced|stale/i));
  (await store.close());
});

test("historical proposal material keeps source references and limits while transport provenance stays authenticated", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const host = createPrincipal("host", "history-host", engagement_id);
  try {
    const evidence = await store.commit({ id: uuidv7(), engagement_id, kind: "evidence", statement: "historical report reference", observed_at: "2024-01-02T03:04:05.000Z", limitations: ["source was not rechecked"] }, "L1");
    const response = await service.dispatch("proposal.submit", host, {
      engagement_id,
      subject_type: "claim",
      expected_version: 0,
      content: {
        schema_version: "1.0.0",
        engagement_id,
        kind: "claim",
        proposition: "historical material is relevant context",
        status: "proposed",
        provenance: { host_id: "forged", producer_id: "historical-import", source_kind: "import", source_refs: [evidence.id] },
        evidence_refs: [evidence.id],
        limitations: ["not a current observation", "source was not rechecked"],
      },
    });
    assert.equal(response.ok, true);
    assert.equal(response.data.status, "pending");
    assert.deepEqual(response.data.content.provenance.source_refs, [evidence.id]);
    assert.equal(response.data.content.provenance.source_kind, "host");
    assert.equal(response.data.content.provenance.host_id, host.id);
    assert.equal((await store.list(engagement_id)).some((record) => record.id === response.data.canonical_id), false);
  } finally { await service.close(); }
});

test("checkpoint commit requires the complete executable boundary and rejects hidden reasoning or foreign refs", async () => {
  const store = new AuthorityStore();
  const item = (await workItem(store));
  const run = (await store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi", agent_id: "worker" }));
  (await assert.rejects(async () => (await store.commitCheckpoint(run.run_id, run.generation, "pi", { completed_steps: [] })), /reference|invalid|missing|required/i));
  (await assert.rejects(async () => (await store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id, { hidden_reasoning: "secret" }))), /hidden reasoning/i));
  (await assert.rejects(async () => (await store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id, { observation_refs: [uuidv7()] }))), /reference|invalid|missing/i));
  (await assert.rejects(async () => (await store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id, { evidence_refs: [item.id] }))), /reference kind mismatch|must reference/i));
  (await assert.rejects(async () => (await store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id, { action_refs: [item.id] }))), /reference kind mismatch|must reference/i));
  const committed = (await store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint(run, item.id)));
  assert.equal(committed.work_item_ref, item.id);
  assert.equal((await store.getWorkRun(run.run_id)).checkpoint_id, committed.checkpoint_id);
  (await store.close());
});

test("action intents cannot skip recommendation or authorization and stale results stay quarantined", async () => {
  const store = new AuthorityStore();
  const item = (await workItem(store));
  const run = (await store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi", agent_id: "worker" }));
  const action_id = uuidv7();
  (await assert.rejects(async () => (await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "executed", result_ref: "host:result:early", host_id: "pi" })), /transition|recommended|authorized/i));
  const recommended = (await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", target: "/admin", method: "GET", host_id: "pi" }));
  assert.equal(recommended.status, "recommended");
  (await assert.rejects(async () => (await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "authorized", host_id: "pi" })), /decision reference|required/i));
  (await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "authorized", host_decision_ref: "host:decision:1", host_id: "pi" }));
  (await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "unknown", host_decision_ref: "host:decision:1", host_id: "pi" }));
  (await assert.rejects(async () => (await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "executed", host_decision_ref: "host:decision:1", result_ref: "host:result:1", host_id: "pi" })), /explicit host reconciliation/i));
  const reconciled = (await store.reconcileAction(run.run_id, run.generation, "host:result:1", "executed", action_id, "pi"));
  assert.equal(reconciled.status, "executed");
  const late = (await store.recordLateResult({ run_id: run.run_id, generation: run.generation - 1, result_ref: "host:result:late", result: { status: "executed" } }));
  assert.equal(late.status, "late_result_quarantine");
  assert.equal((await store.pendingActionIntents(run.run_id)).some((entry) => entry.result_ref === "host:result:late"), false);
  (await store.close());
});

test("work run and active Attempt use the same legal transition fence", async () => {
  const store = new AuthorityStore();
  const item = (await workItem(store));
  const run = (await store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi", agent_id: "worker" }));
  const checkpointed = (await store.transitionWorkRun(run.run_id, run.generation, "pi", "checkpointed"));
  assert.equal(checkpointed.status, "checkpointed");
  (await assert.rejects(async () => (await store.transitionWorkRun(run.run_id, run.generation, "pi", "claimed")), /illegal|transition/i));
  (await assert.rejects(async () => (await store.transitionWorkRun(run.run_id, run.generation, "other-host", "running")), /fenced|owner|lease/i));
  (await store.close());
});

test("checkpoint proposals stay L0 and stale Attempt proposals are quarantined", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const item = (await workItem(store));
  const model = createPrincipal("model", "worker-a", item.engagement_id);
  const run = (await store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi-a", agent_id: model.id }));
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
  const proposed = (await service.dispatch("checkpoint.propose", model, { engagement_id: item.engagement_id, work_run_id: run.run_id, generation: run.generation, checkpoint: checkpointCandidate }));
  assert.equal(proposed.ok, true);
  assert.equal(proposed.data.status, "pending");
  assert.equal((await store.getWorkRun(run.run_id)).checkpoint_id, undefined);

  await awaitReclaim(store, run.run_id);
  const stale = (await service.dispatch("checkpoint.propose", model, { engagement_id: item.engagement_id, work_run_id: run.run_id, generation: run.generation, checkpoint: checkpointCandidate }));
  assert.equal(stale.ok, true);
  assert.equal(stale.data.status, "rejected");
  assert.ok((await store.events()).some((event) => event.event_type === "proposal.stale_attempt_quarantine"));
  (await store.close());
});

test("run-scoped proposals verify the active Attempt, owner, lease, and task session", async () => {
  const store = new AuthorityStore();
  const root = mkdtempSync(join(tmpdir(), "taric-proposal-fence-"));
  try {
    const item = (await workItem(store));
    const session_id = "proposal-session";
    await store.saveArtifactSession({ engagement_id: item.engagement_id, session_id, root: join(root, session_id), binding_id: uuidv7(), created_at: new Date().toISOString(), mode: "host-session" });
    const run = (await store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: "pi", agent_id: "worker", task_session_ref: session_id, ttl_ms: 60_000 }));
    const content = (runValue = run, workItemRef = item.id, overrides = {}) => ({ schema_version: "1.0.0", engagement_id: item.engagement_id, kind: "checkpoint", ...checkpoint(runValue, workItemRef), ...overrides });
    const submit = (candidate, options = {}) => store.submitProposal({ proposal_id: uuidv7(), engagement_id: item.engagement_id, subject_type: "checkpoint", expected_version: 0, content: candidate }, { principal: options.principal ?? "worker", principalRole: options.principalRole ?? "model", engagement_id: item.engagement_id, workRunId: options.workRunId ?? run.run_id, generation: options.generation ?? run.generation });

    const valid = await submit(content());
    assert.equal(valid.status, "pending");

    await assert.rejects(async () => submit(content(run, item.id, { attempt_ref: undefined })), (error) => error.code === "validation_error");
    const wrongOwner = await submit(content(), { principal: "other-worker" });
    assert.equal(wrongOwner.status, "rejected");
    const staleGeneration = await submit(content(), { generation: run.generation + 1 });
    assert.equal(staleGeneration.status, "rejected");

    const shortItem = (await workItem(store, item.engagement_id));
    const expiring = (await store.claimWorkRun({ work_item_id: shortItem.id, engagement_id: item.engagement_id, host_id: "pi", agent_id: "worker", ttl_ms: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const expired = await store.submitProposal({ proposal_id: uuidv7(), engagement_id: item.engagement_id, subject_type: "checkpoint", expected_version: 0, content: content(expiring, shortItem.id) }, { principal: "worker", principalRole: "model", engagement_id: item.engagement_id, workRunId: expiring.run_id, generation: expiring.generation });
    assert.equal(expired.status, "rejected");
    assert.equal((await store.list(item.engagement_id, { includeCandidates: true })).some((record) => record.kind === "checkpoint"), false);
    assert.ok((await store.events()).filter((event) => event.event_type === "proposal.stale_attempt_quarantine").length >= 3);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Core action dispatch audits host decisions and outcomes against the current owner and Attempt without executing targets", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "taric-action-dispatch-")));
  const item = await workItem(store);
  const session_id = "action-audit-session";
  const owner = createPrincipal("host", "action-owner", item.engagement_id, [], undefined, session_id);
  const nonOwner = createPrincipal("host", "action-other-host", item.engagement_id, [], undefined, session_id);
  const model = createPrincipal("model", "action-model", item.engagement_id);
  const crossEngagementHost = createPrincipal("host", "action-cross-engagement", uuidv7());
  const targetServer = createServer((_request, response) => response.end("target must remain untouched"));
  try {
    await new Promise((resolve, reject) => {
      targetServer.once("error", reject);
      targetServer.listen(0, "127.0.0.1", resolve);
    });
    const targetAddress = targetServer.address();
    assert.ok(targetAddress && typeof targetAddress !== "string");
    let targetCalls = 0;
    targetServer.on("request", () => { targetCalls++; });
    await store.saveArtifactSession({ engagement_id: item.engagement_id, session_id, root: join(root, session_id), binding_id: uuidv7(), created_at: new Date().toISOString(), mode: "host-session" });
    const run = await store.claimWorkRun({ work_item_id: item.id, engagement_id: item.engagement_id, host_id: owner.id, agent_id: "worker", task_session_ref: session_id });
    const recommendation = await service.dispatch("action.recommend", owner, {
      engagement_id: item.engagement_id,
      work_run_id: run.run_id,
      generation: run.generation,
      target: `http://127.0.0.1:${targetAddress.port}/must-not-execute`,
      method: "GET",
      rationale: "verify exposure",
      scope: "in-scope",
    });
    assert.equal(recommendation.ok, true);
    assert.equal(recommendation.data.execution, undefined, "recommendation describes a proposed action but does not execute it");
    const actionId = recommendation.data.recommendation_id;
    const recommended = await store.getActionIntent(actionId);
    assert.equal(recommended.status, "recommended");
    assert.equal(recommended.engagement_id, item.engagement_id);
    assert.equal(recommended.run_id, run.run_id);
    assert.equal(recommended.generation, run.generation);
    assert.equal(recommended.host_id, owner.id);
    assert.deepEqual(recommended.owner, { host_id: owner.id, agent_id: "worker" });

    const beforeDeniedCalls = await store.events();
    const modelDecision = await service.dispatch("action.host-decision", model, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      mode: "host_hitl", status: "authorized", host_decision_ref: "decision:model",
    });
    assert.equal(modelDecision.error.code, "authorization_error");
    const crossEngagementDecision = await service.dispatch("action.host-decision", crossEngagementHost, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      mode: "host_hitl", status: "authorized", host_decision_ref: "decision:cross-engagement",
    });
    assert.equal(crossEngagementDecision.error.code, "authorization_error");
    const nonOwnerDecision = await service.dispatch("action.host-decision", nonOwner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      mode: "host_hitl", status: "authorized", host_decision_ref: "decision:non-owner",
    });
    assert.equal(nonOwnerDecision.error.code, "authorization_error");
    const staleDecision = await service.dispatch("action.host-decision", owner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation + 1,
      mode: "host_hitl", status: "authorized", host_decision_ref: "decision:stale",
    });
    assert.equal(staleDecision.error.code, "stale_version");
    assert.deepEqual(await store.events(), beforeDeniedCalls, "denied or stale dispatches make no authority or audit mutation");
    assert.equal((await store.getActionIntent(actionId)).status, "recommended");

    const decision = await service.dispatch("action.host-decision", owner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      mode: "host_hitl", status: "authorized", host_decision_ref: "decision:1", host_id: "forged-body-host", role: "operator",
    });
    assert.equal(decision.ok, true);
    const authorized = await store.getActionIntent(actionId);
    assert.equal(authorized.status, "authorized");
    assert.equal(authorized.host_decision_ref, "decision:1");
    assert.equal(authorized.host_id, owner.id, "Core binds the decision to the authenticated principal, not request fields");
    assert.equal(authorized.engagement_id, item.engagement_id);
    assert.equal(authorized.run_id, run.run_id);
    assert.equal(authorized.generation, run.generation);
    assert.deepEqual(authorized.owner, { host_id: owner.id, agent_id: "worker" });

    const unknown = await service.dispatch("action.host-result", owner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      mode: "host_hitl", status: "unknown", host_decision_ref: "decision:1",
    });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.data.status, "unknown");
    assert.equal((await store.pendingActionIntents(run.run_id)).some((action) => action.action_id === actionId && action.status === "unknown"), true);
    const resumed = await store.resumePacket(run.run_id, owner.id);
    assert.equal(resumed.pending_actions.some((action) => action.action_id === actionId && action.status === "unknown"), true, "unknown outcomes remain visible for host reconciliation after restart");

    const attemptedReplay = await service.dispatch("action.host-result", owner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      mode: "host_hitl", status: "executed", result_ref: "result:unreconciled", host_decision_ref: "decision:1",
    });
    assert.equal(attemptedReplay.error.code, "conflict", "unknown is not converted into an execution result by an ordinary result report");
    const modelReconcile = await service.dispatch("action.reconcile", model, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      status: "executed", result_ref: "result:model-reconcile",
    });
    assert.equal(modelReconcile.error.code, "authorization_error");
    const nonOwnerReconcile = await service.dispatch("action.reconcile", nonOwner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      status: "executed", result_ref: "result:non-owner-reconcile",
    });
    assert.equal(nonOwnerReconcile.error.code, "authorization_error");
    const staleReconcile = await service.dispatch("action.reconcile", owner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation + 1,
      status: "executed", result_ref: "result:stale-reconcile",
    });
    assert.equal(staleReconcile.error.code, "stale_version");
    assert.equal((await store.getActionIntent(actionId)).status, "unknown");

    const reconciled = await service.dispatch("action.reconcile", owner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: actionId, generation: run.generation,
      status: "executed", result_ref: "result:1",
    });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.data.status, "executed");
    assert.equal(reconciled.data.result_ref, "result:1");
    assert.equal(reconciled.data.host_decision_ref, "decision:1");
    assert.equal(reconciled.data.host_id, owner.id);
    assert.equal(reconciled.data.engagement_id, item.engagement_id);
    assert.equal(reconciled.data.run_id, run.run_id);
    assert.equal(reconciled.data.generation, run.generation);
    assert.deepEqual(reconciled.data.owner, { host_id: owner.id, agent_id: "worker" });
    assert.equal((await store.pendingActionIntents(run.run_id)).some((action) => action.action_id === actionId), false);

    const lifecycle = (await store.events()).filter((event) => event.subject_id === actionId && event.event_type.startsWith("action_intent."));
    assert.deepEqual(lifecycle.map((event) => event.event_type), ["action_intent.recommended", "action_intent.authorized", "action_intent.unknown", "action_intent.executed"]);
    for (const event of lifecycle.slice(1)) {
      assert.equal(event.payload.host_id, owner.id);
      assert.equal(event.payload.work_run_id, run.run_id);
      assert.equal(event.payload.generation, run.generation);
      assert.equal(event.payload.agent_id, "worker");
    }

    const executionRows = await store.executionCatalogRows({ engagement_id: item.engagement_id, session_id, work_run_id: run.run_id });
    assert.equal(executionRows.length, 4, "Core records action lifecycle sidecars without a target-execution side effect");
    for (const row of executionRows) {
      assert.equal(row.engagement_id, item.engagement_id);
      assert.equal(row.work_run_id, run.run_id);
      assert.equal(row.attempt_id, run.attempt_ref);
      assert.equal(row.generation, run.generation);
      assert.equal(row.reference_id, actionId);
      assert.equal(row.sidecar_status, "available", "run-bound action audit sidecar bytes are integrity verified");
    }
    assert.deepEqual(executionRows.map((row) => row.kind), ["action", "action", "result", "result"]);
    assert.equal(JSON.stringify([recommendation.data, decision.data, unknown.data, reconciled.data]).includes("execution"), false, "Core exposes audit results and references, not a target executor result channel");
    assert.equal(targetCalls, 0, "action recommendation, host decision, result, and reconciliation record intent only; no Core dispatch contacts the target");

    const staleRecommendation = await service.dispatch("action.recommend", owner, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, generation: run.generation,
      target: "http://127.0.0.1:1/stale-generation", method: "GET", rationale: "verify generation fencing",
    });
    assert.equal(staleRecommendation.ok, true);
    await store.renewWorkRun(run.run_id, run.generation, owner.id, 5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replacement = createPrincipal("host", "action-replacement-owner", item.engagement_id, [], undefined, session_id);
    const nextRun = await store.reclaimWorkRun(run.run_id, replacement.id, "worker-next");
    assert.equal(nextRun.generation, run.generation + 1);
    const beforeStaleGeneration = await store.events();
    const staleGenerationAfterReclaim = await service.dispatch("action.host-decision", replacement, {
      engagement_id: item.engagement_id, work_run_id: run.run_id, action_id: staleRecommendation.data.recommendation_id,
      generation: run.generation, mode: "host_hitl", status: "authorized", host_decision_ref: "decision:old-generation",
    });
    assert.equal(staleGenerationAfterReclaim.error.code, "stale_version");
    assert.deepEqual(await store.events(), beforeStaleGeneration, "a prior generation cannot record decisions after reclaim");
    assert.equal((await store.getActionIntent(staleRecommendation.data.recommendation_id)).status, "recommended");
    assert.equal(targetCalls, 0);
  } finally {
    await new Promise((resolve) => targetServer.close(resolve));
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function awaitReclaim(store, runId) {
  const run = (await store.getWorkRun(runId));
  (await store.renewWorkRun(runId, run.generation, run.owner.host_id, 5));
  await new Promise((resolve) => setTimeout(resolve, 10));
  (await store.reclaimWorkRun(runId, "pi-b", "worker-b"));
}

