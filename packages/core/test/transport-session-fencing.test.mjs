import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

function checkpoint(run, work_item_ref) {
  return {
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
    work_item_ref,
  };
}

async function visibleState(store, engagement_id) {
  const snapshot = await store.snapshot(engagement_id, { includeCandidates: true });
  return {
    records: snapshot.records,
    events: await store.events(),
    proposals: await store.sql.all("SELECT id,status FROM proposals ORDER BY id"),
    idempotency: await store.sql.all("SELECT key,operation,principal,engagement_id,request_hash,result FROM idempotency ORDER BY key"),
    outbox: await store.sql.all("SELECT id,commit_seq,status FROM outbox ORDER BY id"),
  };
}

test("trusted session association fences host attachments before state mutation and keeps stale proposals quarantined", async () => {
  const store = new AuthorityStore();
  const directory = mkdtempSync(join(tmpdir(), "taric-session-fence-"));
  const service = await createCoreService(store, join(directory, "content"));
  const engagement_id = uuidv7();
  const work_item_id = uuidv7();
  const session_id = "transport-session";
  const host = createPrincipal("host", "fenced-host", engagement_id, [], undefined, session_id);
  const otherSession = createPrincipal("host", "fenced-host", engagement_id, [], undefined, "other-session");
  const otherOwner = createPrincipal("host", "other-host", engagement_id, [], undefined, session_id);
  const unboundHost = createPrincipal("host", "unbound-host", engagement_id);

  try {
    host.transport_session_id = "mutated-session";
    const binding = await service.dispatch("artifact.session.bind", host, {
      engagement_id,
      session_id,
      root: join(directory, "content", session_id),
      mode: "host-session",
    });
    assert.equal(binding.ok, true);
    await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "fencing", status: "queued", acceptance_criteria: ["verified"] }, "L2");
    const forgedClaim = await service.dispatch("work.claim", host, { engagement_id, work_item_id, host_id: host.id, agent_id: "worker", task_session_ref: "body-session" });
    assert.equal(forgedClaim.error.code, "authorization_error");
    const claimed = await service.dispatch("work.claim", host, { engagement_id, work_item_id, host_id: host.id, agent_id: "worker", ttl_ms: 60_000 });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    assert.equal(claimed.data.task_session_ref, session_id);
    const substitutedBinding = await service.dispatch("artifact.session.bind", host, {
      engagement_id,
      session_id: "body-session",
      root: join(directory, "content", "body-session"),
      mode: "host-session",
    });
    assert.equal(substitutedBinding.error.code, "authorization_error");
    assert.equal((await store.artifactSessions({ engagement_id, session_id }))[0].mode, "host-session");

    const candidate = {
      schema_version: "1.0.0",
      engagement_id,
      kind: "claim",
      proposition: "candidate remains pending",
      status: "proposed",
      provenance: { host_id: host.id, producer_id: host.id, source_kind: "host" },
      evidence_refs: [],
      limitations: [],
    };
    const hostSessionProposal = await service.dispatch("proposal.submit", host, {
      engagement_id, subject_type: "claim", expected_version: 0, content: candidate, idempotency_key: "missing-run",
    });
    assert.equal(hostSessionProposal.ok, true);
    assert.equal(hostSessionProposal.data.status, "pending");
    const before = await visibleState(store, engagement_id);
    const partial = await service.dispatch("checkpoint.propose", host, {
      engagement_id, work_run_id: claimed.data.run_id, checkpoint: checkpoint(claimed.data, work_item_id),
    });
    assert.equal(partial.error.code, "validation_error");
    const wrongSession = await service.dispatch("checkpoint.propose", otherSession, {
      engagement_id, work_run_id: claimed.data.run_id, generation: claimed.data.generation, checkpoint: checkpoint(claimed.data, work_item_id),
    });
    assert.equal(wrongSession.error.code, "authorization_error");
    const wrongOwner = await service.dispatch("checkpoint.propose", otherOwner, {
      engagement_id, work_run_id: claimed.data.run_id, generation: claimed.data.generation, checkpoint: checkpoint(claimed.data, work_item_id),
    });
    assert.equal(wrongOwner.error.code, "authorization_error");
    const missingTransport = await service.dispatch("checkpoint.propose", unboundHost, {
      engagement_id, work_run_id: claimed.data.run_id, generation: claimed.data.generation, checkpoint: checkpoint(claimed.data, work_item_id),
    });
    assert.equal(missingTransport.error.code, "authorization_error");
    const staleGeneration = await service.dispatch("action.recommend", host, {
      engagement_id, work_run_id: claimed.data.run_id, generation: claimed.data.generation + 1,
      target: "/admin", method: "GET", rationale: "test stale binding",
    });
    assert.equal(staleGeneration.error.code, "stale_version");
    const bodySession = await service.dispatch("action.host-result", host, {
      engagement_id, work_run_id: claimed.data.run_id, generation: claimed.data.generation,
      session_id: "body-session", action_id: uuidv7(), mode: "host_hitl", status: "unknown",
    });
    assert.equal(bodySession.error.code, "authorization_error");
    assert.deepEqual(await visibleState(store, engagement_id), before);

    await store.renewWorkRun(claimed.data.run_id, claimed.data.generation, host.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforeLateProposal = await visibleState(store, engagement_id);
    const lateProposal = await service.dispatch("checkpoint.propose", host, {
      engagement_id, work_run_id: claimed.data.run_id, generation: claimed.data.generation, checkpoint: checkpoint(claimed.data, work_item_id),
    });
    assert.equal(lateProposal.ok, true);
    assert.equal(lateProposal.data.status, "rejected");
    const afterLateProposal = await visibleState(store, engagement_id);
    const newEvents = afterLateProposal.events.slice(beforeLateProposal.events.length);
    assert.deepEqual(newEvents.map((event) => event.event_type), ["proposal.stale_attempt_quarantine"]);
    assert.equal(afterLateProposal.records.some((record) => record.kind === "checkpoint"), false);
    assert.equal(afterLateProposal.outbox.length, beforeLateProposal.outbox.length + 1);
  } finally {
    await service.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
