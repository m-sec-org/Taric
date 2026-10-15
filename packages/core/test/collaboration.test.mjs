import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("work run fencing rejects stale checkpoint and records host action modes", async () => {
  const store = new AuthorityStore();
  const runId = uuidv7(); const input = { run_id: runId, work_item_id: uuidv7(), engagement_id: uuidv7(), host_id: "pi", agent_id: "worker-1", ttl_ms: 60_000 };
  (await store.commit({ id: input.work_item_id, engagement_id: input.engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["record evidence"] }, "L2"));
  const claimed = (await store.claimWorkRun(input));
  const checkpoint = (await store.commitCheckpoint(runId, claimed.generation, "pi", { work_item_ref: input.work_item_id, work_run_ref: runId, attempt_ref: claimed.attempt_ref, generation: claimed.generation, target_version: claimed.target_version, work_item_version: claimed.work_item_version, scope_version: claimed.scope_version, owner: claimed.owner, lease_expires_at: claimed.lease_expires_at, source_read_seq: claimed.read_seq, completed_steps: ["recon"], next_steps: ["review"], observation_refs: [], evidence_refs: [], negative_results: [], unresolved_work: [], host_decision_refs: [], external_action_state: "none", budget: { actions: 0 }, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [], context_manifest: { context_snapshot_id: uuidv7(), read_seq: claimed.read_seq, builder_version: "test" } }));
  assert.equal(checkpoint.run_id, runId);
  (await assert.rejects(async () => (await store.commitCheckpoint(runId, claimed.generation - 1, "pi", {})), /lease/));
  const action = (await store.recordActionIntent({ run_id: runId, generation: claimed.generation, mode: "host_hitl", status: "recommended", target: "/admin", method: "GET", host_id: "pi" }));
  (await store.recordActionIntent({ action_id: action.action_id, run_id: runId, generation: claimed.generation, mode: "host_hitl", status: "authorized", host_decision_ref: "host:decision:1", host_id: "pi" }));
  assert.equal(action.mode, "host_hitl");
  assert.equal((await store.getWorkRun(runId)).checkpoint_id, checkpoint.checkpoint_id);
  (await store.close());
});

test("unknown action outcomes remain pending for host reconciliation", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const work_item_id = uuidv7();
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["record evidence"] }, "L2"));
  const run = (await store.claimWorkRun({ work_item_id, engagement_id, host_id: "hermes", agent_id: "a" }));
  const action = (await store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "authorized_autonomous", status: "recommended", target: "/admin", method: "GET", host_id: "hermes" }));
  (await store.recordActionIntent({ action_id: action.action_id, run_id: run.run_id, generation: run.generation, mode: "authorized_autonomous", status: "authorized", host_decision_ref: "host:decision:1", host_id: "hermes" }));
  (await store.recordActionIntent({ action_id: action.action_id, run_id: run.run_id, generation: run.generation, mode: "authorized_autonomous", status: "unknown", host_decision_ref: "host:decision:1", host_id: "hermes" }));
  assert.equal((await store.pendingActionIntents(run.run_id)).length, 1);
  (await store.close());
});
