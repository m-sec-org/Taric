import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

const networkProvenance = {
  approved_addresses: ["127.0.0.1"],
  connected_address: "127.0.0.1",
  ip_family: "ipv4",
  protocol: "http",
  port: 8080,
  resolved_at: "2026-01-01T00:00:00.000Z",
  connected_at: "2026-01-01T00:00:01.000Z",
  completed_at: "2026-01-01T00:00:02.000Z",
  redirect_chain: [{
    from: "http://127.0.0.1/start",
    to: "http://127.0.0.1/final",
    decision: "allowed",
    decided_at: "2026-01-01T00:00:01.500Z",
  }],
};

test("Action audit is immutable, idempotent, fixed at read_seq, and quarantines stale results", async () => {
  const root = mkdtempSync(join(tmpdir(), "taric-action-audit-"));
  const filename = join(root, "authority.sqlite");
  let store = new AuthorityStore(filename);
  const engagement_id = uuidv7();
  const work_item_id = uuidv7();
  try {
    await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "audit action", status: "queued", acceptance_criteria: ["preserve action history"] }, "L2");
    const run = await store.claimWorkRun({ work_item_id, engagement_id, host_id: "host-a", agent_id: "worker-a" });
    const action = await store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", target: "http://127.0.0.1:8080/check", method: "GET", rationale: "verify a bounded target", host_id: "host-a" });
    const action_id = action.action_id;
    const afterRecommendation = (await store.events()).length;
    await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", target: "http://127.0.0.1:8080/check", method: "GET", rationale: "verify a bounded target", host_id: "host-a" });
    assert.equal((await store.events()).length, afterRecommendation, "an identical transition retry does not append another event");
    await assert.rejects(
      store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", target: "http://127.0.0.1:8080/check", method: "GET", rationale: "changed retry", host_id: "host-a" }),
      (error) => error.code === "idempotency_conflict",
    );
    await assert.rejects(
      store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", target: "http://user:secret@127.0.0.1/check", method: "GET", host_id: "host-a" }),
      /credentials/i,
    );
    await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "authorized", host_decision_ref: "decision:1", host_id: "host-a" });
    await assert.rejects(
      store.recordActionIntent({
        action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "unknown", host_decision_ref: "decision:1", host_id: "host-a",
        network_provenance: { ...networkProvenance, connected_address: "127.0.0.2" },
      }),
      /approved address set/i,
    );
    await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "unknown", host_decision_ref: "decision:1", host_id: "host-a", network_provenance: networkProvenance });
    await store.reconcileAction(run.run_id, run.generation, "result:1", "executed", action_id, "host-a");

    const first = await store.actionAuditQuery({ engagement_id, principal_id: "operator-a", page_size: 2 });
    assert.equal(first.events.length, 2);
    assert.equal(first.has_more, true);
    assert.deepEqual(first.events.map((event) => event.status), ["recommended", "authorized"]);
    const secondAction = await store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", target: "/another-check", method: "GET", host_id: "host-a" });
    assert.ok(secondAction.action_id);
    await store.close();
    store = new AuthorityStore(filename);
    const second = await store.actionAuditQuery({ engagement_id, principal_id: "operator-a", page_size: 2, cursor: first.next_cursor });
    assert.equal(second.read_seq, first.read_seq);
    assert.equal(second.events.length, 2);
    assert.deepEqual(second.events.map((event) => event.status), ["unknown", "executed"]);
    assert.equal(second.has_more, false, "later writes do not enter an existing paginated snapshot");
    assert.equal(second.events[0].payload.network_provenance.connected_address, "127.0.0.1");
    assert.equal(second.events[0].payload.before_snapshot.status, "authorized");
    assert.equal(second.events[0].payload.after_snapshot.status, "unknown");
    assert.equal(second.events[1].payload.before_snapshot.status, "unknown");
    assert.equal(second.events[1].payload.after_snapshot.status, "executed");
    await assert.rejects(
      store.actionAuditQuery({ engagement_id, principal_id: "operator-b", page_size: 2, cursor: first.next_cursor }),
      /cursor binding mismatch/i,
    );
    assert.equal((await store.actionAuditQuery({ engagement_id: uuidv7() })).events.length, 0);
    const filtered = await store.actionAuditQuery({ engagement_id, work_run_id: run.run_id, attempt_id: run.attempt_ref, generation: run.generation, status: "unknown" });
    assert.deepEqual(filtered.events.map((event) => event.status), ["unknown"]);

    const projectedBeforeLateResult = await store.getActionIntent(action_id);
    await store.renewWorkRun(run.run_id, run.generation, "host-a", 5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.reclaimWorkRun(run.run_id, "host-b", "worker-b");
    const lateInput = { engagement_id, work_run_id: run.run_id, generation: run.generation, action_id, status: "failed", result_ref: "result:late", host_id: "host-a", network_provenance: networkProvenance };
    const late = await store.recordLateResult(lateInput);
    const eventCountAfterLate = (await store.events()).length;
    const replay = await store.recordLateResult(lateInput);
    assert.equal(replay.late_result_id, late.late_result_id);
    assert.equal((await store.events()).length, eventCountAfterLate, "late result retries are idempotent");
    assert.equal(late.status, "late_result_quarantine");
    assert.deepEqual(await store.getActionIntent(action_id), projectedBeforeLateResult, "quarantined result leaves current Action projection unchanged");
    const history = await store.actionAuditQuery({ engagement_id, action_id });
    const quarantined = history.events.find((event) => event.event_id === late.late_result_id);
    assert.equal(quarantined.status, "late_result_quarantine");
    assert.equal(quarantined.payload.quarantine_reason, "stale_generation");
    assert.deepEqual(quarantined.payload.before_snapshot, quarantined.payload.after_snapshot);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
