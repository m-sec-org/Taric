import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("SQLite event-boundary aborts roll back records, governance, checkpoints and actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-atomic-failure-"));
  const filename = join(directory, "authority.sqlite");
  const store = new AuthorityStore(filename);
  await store.events();
  const db = new DatabaseSync(filename);
  const engagement_id = uuidv7();
  const trigger = (eventType) => {
    db.exec("DROP TRIGGER IF EXISTS inject_event_failure");
    db.exec(`CREATE TRIGGER inject_event_failure BEFORE INSERT ON events WHEN NEW.event_type='${eventType}' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`);
  };
  const clear = () => db.exec("DROP TRIGGER IF EXISTS inject_event_failure");
  try {
    const recordId = uuidv7();
    db.exec("CREATE TRIGGER inject_outbox_failure BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END");
    (await assert.rejects(async () => (await store.commit({ id: recordId, engagement_id, kind: "note", statement: "atomic" })), /injected outbox failure/));
    assert.equal((await store.get(recordId)), undefined);
    assert.equal((await store.doctor()).pending_outbox, 0);
    assert.equal((await store.events()).length, 0, "event written before the failed outbox insert also rolls back");
    db.exec("DROP TRIGGER inject_outbox_failure");

    const proposalContent = { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "proposal", status: "proposed", evidence_refs: [], limitations: [] };
    trigger("proposal.submit");
    (await assert.rejects(async () => (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: proposalContent }, { idempotencyKey: "atomic-proposal", principal: "model" })), /injected event failure/));
    assert.equal((await store.proposals(engagement_id)).length, 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE key='atomic-proposal'").get().n), 0);
    clear();
    const proposal = (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: proposalContent }, { idempotencyKey: "atomic-proposal", principal: "model" }));

    trigger("review.submit");
    (await assert.rejects(async () => (await store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: "sha256:policy" })), /injected event failure/));
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM reviews").get().n), 0);
    assert.equal((await store.events()).some((event) => event.event_type === "review.submit"), false);
    clear();

    const claimContent = { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "admit me", status: "proposed", evidence_refs: [], limitations: [] };
    const admissionProposal = (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: claimContent }));
    trigger("proposal.admit");
    (await assert.rejects(async () => (await store.admitProposal(admissionProposal.id, `sha256:${"a".repeat(64)}`, { idempotencyKey: "atomic-admission" })), /injected event failure/));
    assert.equal((await store.list(engagement_id, { includeCandidates: true })).length, 0);
    assert.equal((await store.proposals(engagement_id)).find((item) => item.id === admissionProposal.id).status, "pending");
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM idempotency WHERE key='atomic-admission'").get().n), 0);
    clear();

    const workItem = { id: uuidv7(), engagement_id, kind: "work_item", title: "verify", status: "queued" };
    (await store.commit(workItem, "L2"));
    const run = (await store.claimWorkRun({ work_item_id: workItem.id, engagement_id, host_id: "pi", agent_id: "worker" }));
    trigger("work_run.checkpoint");
    const checkpoint = {
      work_item_ref: workItem.id, work_run_ref: run.run_id, attempt_ref: run.attempt_ref, generation: run.generation,
      target_version: run.target_version, work_item_version: run.work_item_version, scope_version: run.scope_version,
      owner: run.owner, lease_expires_at: run.lease_expires_at, source_read_seq: run.read_seq,
      completed_steps: [], next_steps: [], observation_refs: [], evidence_refs: [], negative_results: [],
      unresolved_work: [], host_decision_refs: [], external_action_state: "none", budget: {}, draft_refs: [],
      handoff_refs: [], action_refs: [], tool_result_refs: [],
      context_manifest: { context_snapshot_id: uuidv7(), read_seq: run.read_seq, builder_version: "test" },
    };
    (await assert.rejects(async () => (await store.commitCheckpoint(run.run_id, run.generation, "pi", checkpoint)), /injected event failure/));
    assert.equal((await store.getWorkRun(run.run_id)).status, "claimed");
    assert.equal((await store.getWorkRun(run.run_id)).checkpoint_id, undefined);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get().n), 0);
    clear();

    const actionId = uuidv7();
    trigger("action_intent.recommended");
    (await assert.rejects(async () => (await store.recordActionIntent({ action_id: actionId, run_id: run.run_id, generation: run.generation, mode: "host_hitl", target: "/admin", method: "GET", status: "recommended", host_id: "pi" })), /injected event failure/));
    assert.equal((await store.getActionIntent(actionId)), undefined);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM action_intents").get().n), 0);
  } finally {
    clear();
    db.close();
    (await store.close());
    await rm(directory, { recursive: true, force: true });
  }
});
