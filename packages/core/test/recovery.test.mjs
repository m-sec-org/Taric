import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("resume packet includes checkpoint and pending actions", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const work_item_id = uuidv7();
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["record evidence"] }, "L2"));
  const run = (await store.claimWorkRun({ work_item_id, engagement_id, host_id: "pi", agent_id: "a" }));
  (await store.commitCheckpoint(run.run_id, run.generation, "pi", { work_item_ref: run.work_item_id, work_run_ref: run.run_id, attempt_ref: run.attempt_ref, generation: run.generation, target_version: run.target_version, work_item_version: run.work_item_version, scope_version: run.scope_version, owner: run.owner, lease_expires_at: run.lease_expires_at, source_read_seq: run.read_seq, completed_steps: ["one"], next_steps: [], observation_refs: [], evidence_refs: [], negative_results: [], unresolved_work: [], host_decision_refs: [], external_action_state: "none", budget: { actions: 0 }, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [], context_manifest: { context_snapshot_id: uuidv7(), read_seq: run.read_seq, builder_version: "test" } }));
  const action = (await store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "authorized_autonomous", status: "recommended", target: "/admin", method: "GET", host_id: "pi" }));
  (await store.recordActionIntent({ action_id: action.action_id, run_id: run.run_id, generation: run.generation, mode: "authorized_autonomous", status: "authorized", host_decision_ref: "host:decision:1", host_id: "pi" }));
  (await store.recordActionIntent({ action_id: action.action_id, run_id: run.run_id, generation: run.generation, mode: "authorized_autonomous", status: "unknown", host_decision_ref: "host:decision:1", host_id: "pi" }));
  const packet = (await store.resumePacket(run.run_id, "pi"));
  assert.equal(packet.checkpoint.completed_steps[0], "one"); assert.equal(packet.pending_actions.length, 1);
  (await store.close());
});

test("stale action result is quarantined with original attribution", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const work_item_id = uuidv7();
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["record evidence"] }, "L2"));
  const run = (await store.claimWorkRun({ work_item_id, engagement_id, host_id: "pi", agent_id: "a" }));
  const late = (await store.recordLateResult({ run_id: run.run_id, generation: run.generation - 1, result_ref: "host:result:1", result: { status: "unknown" } }));
  assert.equal(late.status, "late_result_quarantine"); assert.equal(late.generation, run.generation - 1);
  (await store.close());
});
