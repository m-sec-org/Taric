import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, ContractValidationError, uuidv7 } from "../dist/index.js";

async function baseFinding(store) {
  const engagement_id = uuidv7();
  const scope = uuidv7();
  const claim = uuidv7();
  const evidence = uuidv7();
  (await store.commit({ id: scope, engagement_id, kind: "scope", allowed_targets: ["target"], excluded_targets: [], rules_of_engagement_ref: "roe:1" }, "L2"));
  (await store.commit({ id: claim, engagement_id, kind: "claim", proposition: "claim" }, "L2"));
  (await store.commit({ id: evidence, engagement_id, kind: "evidence", artifact_ref: { host_ref: "host-artifact:1" }, observed_at: new Date().toISOString(), limitations: ["single run"] }, "L2"));
  return { engagement_id, scope, claim, evidence };
}

test("proposal submission and admission retries are atomic and request-bound", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const content = { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "candidate", status: "proposed", evidence_refs: [], limitations: [] };
  const first = (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content }, { idempotencyKey: "proposal-1", operation: "proposal.submit", principal: "model-a", engagement_id }));
  const retry = (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content }, { idempotencyKey: "proposal-1", operation: "proposal.submit", principal: "model-a", engagement_id }));
  assert.deepEqual(retry, first);
  (await assert.rejects(async () => (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: { ...content, proposition: "changed" } }, { idempotencyKey: "proposal-1", operation: "proposal.submit", principal: "model-a", engagement_id })), ContractValidationError));
  const digest = `sha256:${"a".repeat(64)}`;
  const admitted = (await store.admitProposal(first.id, digest, { expectedBaseVersion: 0, idempotencyKey: "admit-1", operation: "admission.evaluate", principal: "operator-a", engagement_id }));
  assert.equal(admitted.ok, true);
  assert.deepEqual((await store.admitProposal(first.id, digest, { expectedBaseVersion: 0, idempotencyKey: "admit-1", operation: "admission.evaluate", principal: "operator-a", engagement_id })), admitted);
  assert.equal((await store.events()).filter((event) => event.event_type === "proposal.admit").length, 1);
  (await store.close());
});

test("independent review binds immutable evidence snapshot and L2 promotion prerequisites", async () => {
  const store = new AuthorityStore();
  const { engagement_id, scope, claim, evidence } = (await baseFinding(store));
  const content = { schema_version: "1.0.0", engagement_id, kind: "finding", title: "finding", claim_refs: [claim], evidence_refs: [evidence], applicable_scope_ref: scope, limitations: ["single identity"], reproducibility: "repeat the request", status: "draft", provenance: { host_id: "pi", producer_id: "worker-a", source_kind: "worker" } };
  const proposal = (await store.submitProposal({ engagement_id, subject_type: "finding", expected_version: 0, content }));
  const digest = `sha256:${"a".repeat(64)}`;
  const l1 = (await store.admitProposal(proposal.id, digest, { expectedBaseVersion: 0 }));
  assert.equal(l1.ok, true);
  const pack = await store.reviewPack(engagement_id, proposal.id);
  await assert.rejects(store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: digest, evidence_snapshot_hash: `sha256:${"0".repeat(64)}` }), /review evidence snapshot does not match/);
  const review = (await store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: digest, evidence_snapshot_hash: pack.evidence_snapshot_hash }));
  assert.equal(review.accepted, true);
  const promoted = (await store.promoteFinding(proposal.id, { expectedBaseVersion: l1.record.version, policyDigest: digest, principal: "operator-a" }));
  assert.equal(promoted.ok, true);
  assert.equal(promoted.record.trust_level, "L2");
  assert.equal(promoted.record.status, "verified");
  assert.equal((await store.events()).some((event) => event.event_type === "proposal.promote_l2" && event.payload.review_hash), true);
  (await store.close());
});

test("recall transitions exclude current reads but preserve authorized as-of history", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const record = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "current" }, "L2"));
  const before = (await store.snapshot(engagement_id, { asOf: record.commit_seq, includeCandidates: true }));
  const stale = (await store.retract(record.id, "retracted by operator"));
  assert.equal(stale.status, "retracted");
  assert.equal((await store.list(engagement_id, { includeCandidates: true })).some((item) => item.id === record.id), false);
  assert.equal((await store.snapshot(engagement_id, { asOf: before.read_seq, includeCandidates: true })).records.some((item) => item.id === record.id), true);
  assert.equal((await store.events()).some((event) => event.event_type === "record.retracted"), true);
  (await store.close());
});

test("expiry, review-after, supersede and archive filters retain historical authority", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const expired = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "expired", expires_at: "2020-01-01T00:00:00.000Z" }, "L2"));
  const reviewAfter = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "review", review_after: "2020-01-01T00:00:00.000Z" }, "L2"));
  const archived = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "archived" }, "L2"));
  const replacement = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "replacement" }, "L2"));
  const before = (await store.snapshot(engagement_id, { asOf: replacement.commit_seq, includeCandidates: true }));
  (await store.supersede(archived.id, replacement.id, "replaced"));
  (await store.archive(replacement.id, "closed"));
  const current = (await store.list(engagement_id, { includeCandidates: true }));
  assert.equal(current.some((item) => item.id === expired.id || item.id === reviewAfter.id || item.id === archived.id || item.id === replacement.id), false);
  assert.ok(before.records.some((item) => item.id === archived.id));
  assert.ok((await store.events()).some((event) => event.event_type === "record.superseded"));
  assert.ok((await store.events()).some((event) => event.event_type === "record.archived"));
  (await store.close());
});
