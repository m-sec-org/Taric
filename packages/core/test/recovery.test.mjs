import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("resume packet includes checkpoint and pending actions", () => {
  const store = new AuthorityStore(); const run = store.claimWorkRun({ work_item_id: uuidv7(), engagement_id: uuidv7(), host_id: "pi", agent_id: "a" });
  store.commitCheckpoint(run.run_id, run.generation, "pi", { completed_steps: ["one"] });
  store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "authorized_autonomous", status: "unknown" });
  const packet = store.resumePacket(run.run_id, "pi");
  assert.equal(packet.checkpoint.completed_steps[0], "one"); assert.equal(packet.pending_actions.length, 1);
  store.close();
});

test("stale action result is quarantined with original attribution", () => {
  const store = new AuthorityStore(); const run = store.claimWorkRun({ work_item_id: uuidv7(), engagement_id: uuidv7(), host_id: "pi", agent_id: "a" });
  const late = store.recordLateResult({ run_id: run.run_id, generation: run.generation - 1, result_ref: "host:result:1", result: { status: "unknown" } });
  assert.equal(late.status, "late_result_quarantine"); assert.equal(late.generation, run.generation - 1);
  store.close();
});
