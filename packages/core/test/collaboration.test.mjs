import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("work run fencing rejects stale checkpoint and records host action modes", () => {
  const store = new AuthorityStore();
  const runId = uuidv7(); const input = { run_id: runId, work_item_id: uuidv7(), engagement_id: uuidv7(), host_id: "pi", agent_id: "worker-1", ttl_ms: 60_000 };
  const claimed = store.claimWorkRun(input);
  const checkpoint = store.commitCheckpoint(runId, claimed.generation, "pi", { completed_steps: ["recon"], pending_steps: ["review"] });
  assert.equal(checkpoint.run_id, runId);
  assert.throws(() => store.commitCheckpoint(runId, claimed.generation - 1, "pi", {}), /lease/);
  const action = store.recordActionIntent({ run_id: runId, generation: claimed.generation, mode: "host_hitl", status: "authorized", host_decision_ref: "host:decision:1" });
  assert.equal(action.mode, "host_hitl");
  assert.equal(store.getWorkRun(runId).checkpoint_id, checkpoint.checkpoint_id);
  store.close();
});

test("unknown action outcomes remain pending for host reconciliation", () => {
  const store = new AuthorityStore(); const run = store.claimWorkRun({ work_item_id: uuidv7(), engagement_id: uuidv7(), host_id: "hermes", agent_id: "a" });
  store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "authorized_autonomous", status: "unknown" });
  assert.equal(store.pendingActionIntents(run.run_id).length, 1);
  store.close();
});
