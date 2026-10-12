import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, ContractValidationError, uuidv7 } from "../dist/index.js";

function baseFinding(store) {
  const engagement_id = uuidv7();
  const scope = uuidv7();
  const claim = uuidv7();
  const evidence = uuidv7();
  store.commit({ id: scope, engagement_id, kind: "scope", allowed_targets: ["target"], excluded_targets: [], rules_of_engagement_ref: "roe:1" }, "L2");
  store.commit({ id: claim, engagement_id, kind: "claim", proposition: "claim" }, "L2");
  store.commit({ id: evidence, engagement_id, kind: "evidence", artifact_ref: { host_ref: "host-artifact:1" }, observed_at: new Date().toISOString(), limitations: ["single run"] }, "L2");
  return { engagement_id, scope, claim, evidence };
}

test("proposal submission and admission retries are atomic and request-bound", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const content = { id: uuidv7(), engagement_id, kind: "claim", proposition: "candidate" };
  const first = store.submitProposal({ engagement_id, subject_type: "claim", base_version: 0, content }, { idempotencyKey: "proposal-1", operation: "proposal.submit", principal: "model-a", engagement_id });
  const retry = store.submitProposal({ engagement_id, subject_type: "claim", base_version: 0, content }, { idempotencyKey: "proposal-1", operation: "proposal.submit", principal: "model-a", engagement_id });
  assert.deepEqual(retry, first);
  assert.throws(() => store.submitProposal({ engagement_id, subject_type: "claim", base_version: 0, content: { ...content, proposition: "changed" } }, { idempotencyKey: "proposal-1", operation: "proposal.submit", principal: "model-a", engagement_id }), ContractValidationError);
  const admitted = store.admitProposal(first.id, "sha256:policy", { expectedBaseVersion: 0, idempotencyKey: "admit-1", operation: "admission.evaluate", principal: "operator-a", engagement_id });
  assert.equal(admitted.ok, true);
  assert.deepEqual(store.admitProposal(first.id, "sha256:policy", { expectedBaseVersion: 0, idempotencyKey: "admit-1", operation: "admission.evaluate", principal: "operator-a", engagement_id }), admitted);
  assert.equal(store.events().filter((event) => event.event_type === "proposal.admit").length, 1);
  store.close();
});

test("independent review binds immutable evidence snapshot and L2 promotion prerequisites", () => {
  const store = new AuthorityStore();
  const { engagement_id, scope, claim, evidence } = baseFinding(store);
  const content = { id: uuidv7(), engagement_id, kind: "finding", title: "finding", claim_refs: [claim], evidence_refs: [evidence], applicable_scope_ref: scope, limitations: ["single identity"], reproducibility: "repeat the request", status: "draft", provenance: { host_id: "pi", producer_id: "worker-a", source_kind: "worker" } };
  const proposal = store.submitProposal({ engagement_id, subject_type: "finding", base_version: 0, content });
  const rejected = store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: "sha256:policy", evidence_snapshot_hash: "sha256:wrong" });
  assert.equal(rejected.accepted, false);
  const review = store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: "sha256:policy" });
  assert.equal(review.accepted, true);
  const promoted = store.promoteFinding(proposal.id, { expectedBaseVersion: 0, policyDigest: "sha256:policy", principal: "operator-a" });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.record.trust_level, "L2");
  assert.equal(promoted.record.status, "verified");
  assert.equal(store.events().some((event) => event.event_type === "proposal.promote_l2" && event.payload.review_hash), true);
  store.close();
});

test("recall transitions exclude current reads but preserve authorized as-of history", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const record = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "current" }, "L2");
  const before = store.snapshot(engagement_id, { asOf: record.commit_seq, includeCandidates: true });
  const stale = store.retract(record.id, "retracted by operator");
  assert.equal(stale.status, "retracted");
  assert.equal(store.list(engagement_id, { includeCandidates: true }).some((item) => item.id === record.id), false);
  assert.equal(store.snapshot(engagement_id, { asOf: before.read_seq, includeCandidates: true }).records.some((item) => item.id === record.id), true);
  assert.equal(store.events().some((event) => event.event_type === "record.retracted"), true);
  store.close();
});

test("expiry, review-after, supersede and archive filters retain historical authority", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const expired = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "expired", expires_at: "2020-01-01T00:00:00.000Z" }, "L2");
  const reviewAfter = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "review", review_after: "2020-01-01T00:00:00.000Z" }, "L2");
  const archived = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "archived" }, "L2");
  const replacement = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "replacement" }, "L2");
  const before = store.snapshot(engagement_id, { asOf: replacement.commit_seq, includeCandidates: true });
  store.supersede(archived.id, replacement.id, "replaced");
  store.archive(replacement.id, "closed");
  const current = store.list(engagement_id, { includeCandidates: true });
  assert.equal(current.some((item) => item.id === expired.id || item.id === reviewAfter.id || item.id === archived.id || item.id === replacement.id), false);
  assert.ok(before.records.some((item) => item.id === archived.id));
  assert.ok(store.events().some((event) => event.event_type === "record.superseded"));
  assert.ok(store.events().some((event) => event.event_type === "record.archived"));
  store.close();
});
