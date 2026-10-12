import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, DEFAULT_ADMISSION_POLICY, evaluateAdmission, policyDigest, riskProfile, satisfiesStrongIndependence, uuidv7 } from "../dist/index.js";

const sha = (letter = "a") => `sha256:${letter.repeat(64)}`;

function build(store, overrides = {}) {
  const engagement_id = uuidv7();
  const scope = store.commit({ id: uuidv7(), engagement_id, kind: "scope", allowed_targets: ["https://example.test/admin"], excluded_targets: ["https://example.test/logout"], rules_of_engagement_ref: "roe:1" }, "L2");
  const claim = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "admin endpoint is unauthenticated" }, "L2");
  const evidence = store.commit({ id: uuidv7(), engagement_id, kind: "evidence", artifact_ref: { host_ref: "host-artifact:1" }, observed_at: new Date().toISOString(), limitations: ["single run"] }, "L2");
  const content = {
    id: uuidv7(),
    engagement_id,
    kind: "finding",
    title: "unauthenticated admin access",
    claim_refs: [claim.id],
    evidence_refs: [evidence.id],
    applicable_scope_ref: scope.id,
    limitations: ["single identity"],
    reproducibility: "replay the recorded request",
    status: "draft",
    provenance: { host_id: "pi", producer_id: "worker-a", source_kind: "worker" },
    ...overrides,
  };
  return { engagement_id, scope, claim, evidence, content };
}

test("hard gates are recomputed by the policy engine and ignore caller trust or accept flags", () => {
  const store = new AuthorityStore();
  try {
    const { content } = build(store);
    const proposal = store.submitProposal({ engagement_id: content.engagement_id, subject_type: "finding", base_version: 0, content });
    const decision = store.evaluateAdmission(proposal.id, { policyDigest: sha("b") });
    assert.equal(decision.gates.find((gate) => gate.gate === "schema").passed, true);
    assert.equal(decision.gates.find((gate) => gate.gate === "independence").passed, false, "no review means no L2 promotion");
    assert.equal(store.get(content.id), undefined, "an unadmitted proposal writes no canonical record");
  } finally {
    store.close();
  }
});

test("model verdict, accept=true and caller trust level cannot promote to L2", () => {
  const store = new AuthorityStore();
  try {
    const { content } = build(store);
    const proposal = store.submitProposal({ engagement_id: content.engagement_id, subject_type: "finding", base_version: 0, content });
    assert.throws(() => store.submitProposal({ engagement_id: content.engagement_id, subject_type: "finding", base_version: 0, content: { ...content, trust_level: "L2" } }), /privileged fields/);
    const promoted = store.promoteFinding(proposal.id, { expectedBaseVersion: 0, policyDigest: sha("b") });
    assert.equal(promoted.ok, false);
    assert.match(promoted.reason, /independence/);
    assert.equal(store.get(content.id), undefined);
  } finally {
    store.close();
  }
});

test("self-review, stale evidence and elapsed review_after all fail closed", () => {
  const store = new AuthorityStore();
  try {
    const selfCase = build(store);
    const selfProposal = store.submitProposal({ engagement_id: selfCase.content.engagement_id, subject_type: "finding", base_version: 0, content: selfCase.content });
    assert.equal(store.submitReview({ proposal_id: selfProposal.id, reviewer_id: "worker-a", reviewer_kind: "reviewer", input_hash: selfProposal.content_hash, verdict: "pass", policy_digest: sha("b") }).accepted, false, "the author cannot review their own proposal");
    assert.equal(store.promoteFinding(selfProposal.id, { expectedBaseVersion: 0, policyDigest: sha("b") }).ok, false);

    const staleCase = build(store);
    store.retract(staleCase.evidence.id, "evidence withdrawn");
    const staleProposal = store.submitProposal({ engagement_id: staleCase.content.engagement_id, subject_type: "finding", base_version: 0, content: staleCase.content });
    assert.equal(store.evaluateAdmission(staleProposal.id, { policyDigest: sha("b") }).gates.find((gate) => gate.gate === "evidence").passed, false, "recalled evidence cannot support a current claim");

    const elapsedCase = build(store, { review_after: "2020-01-01T00:00:00.000Z" });
    const elapsedProposal = store.submitProposal({ engagement_id: elapsedCase.content.engagement_id, subject_type: "finding", base_version: 0, content: elapsedCase.content });
    assert.equal(store.evaluateAdmission(elapsedProposal.id, { policyDigest: sha("b") }).gates.find((gate) => gate.gate === "freshness").passed, false);
    assert.equal(store.promoteFinding(elapsedProposal.id, { expectedBaseVersion: 0, policyDigest: sha("b") }).ok, false);
  } finally {
    store.close();
  }
});

test("L1 to L2 promotion requires a bound input hash, evidence snapshot and policy digest", () => {
  const store = new AuthorityStore();
  try {
    const { content } = build(store);
    const proposal = store.submitProposal({ engagement_id: content.engagement_id, subject_type: "finding", base_version: 0, content });
    assert.equal(store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: sha("c"), verdict: "pass", policy_digest: sha("b") }).accepted, false, "a review bound to a different input hash is rejected");
    assert.equal(store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass" }).accepted, false, "a reviewer verdict requires the policy digest that decided it");
    const bound = store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: sha("b"), reviewer_model: "model-a", prompt_digest: sha("d"), ruleset_digest: sha("e") });
    assert.equal(bound.accepted, true);
    const promoted = store.promoteFinding(proposal.id, { expectedBaseVersion: 0, policyDigest: sha("b"), principal: "operator-a" });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.record.trust_level, "L2");
    assert.equal(promoted.record.review_ref, bound.id);
    assert.equal(promoted.record.policy_digest, sha("b"));
    const event = store.events().find((item) => item.event_type === "proposal.promote_l2");
    assert.equal(event.payload.evidence_snapshot_hash, bound.evidence_snapshot_hash, "the promotion pins the reviewed evidence snapshot");
  } finally {
    store.close();
  }
});

test("high risk findings require heterogeneous review; identical model and prompt is not strong independence", () => {
  const store = new AuthorityStore();
  try {
    const { content } = build(store, { risk_class: "high" });
    const proposal = store.submitProposal({ engagement_id: content.engagement_id, subject_type: "finding", base_version: 0, content });
    const digest = sha("b");
    store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: digest, reviewer_model: "model-a", prompt_digest: sha("1") });
    assert.match(store.promoteFinding(proposal.id, { expectedBaseVersion: 0, policyDigest: digest }).reason, /requires 2 independent review/);

    store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-c", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: digest, reviewer_model: "model-a", prompt_digest: sha("1") });
    assert.match(store.promoteFinding(proposal.id, { expectedBaseVersion: 0, policyDigest: digest }).reason, /identical model and prompt/);

    store.submitReview({ proposal_id: proposal.id, reviewer_id: "reviewer-d", reviewer_kind: "reviewer", input_hash: proposal.content_hash, verdict: "pass", policy_digest: digest, reviewer_model: "model-b", prompt_digest: sha("2") });
    const heterogeneous = store.promoteFinding(proposal.id, { expectedBaseVersion: 0, policyDigest: digest });
    assert.equal(heterogeneous.ok, true, "a heterogeneous second model satisfies strong independence");
    assert.equal(heterogeneous.record.risk_class, "high");
    assert.equal(heterogeneous.record.review_refs.length, 3, "all supporting reviews are bound to the promoted finding");
  } finally {
    store.close();
  }
});

test("risk profiles, policy digests and independence checks are pure deterministic functions", () => {
  assert.equal(policyDigest(), policyDigest(DEFAULT_ADMISSION_POLICY));
  const high = riskProfile(DEFAULT_ADMISSION_POLICY, "high");
  assert.equal(high.strong_independence, true);
  assert.equal(high.min_independent_reviews, 2);
  const review = (reviewer_id, model, prompt) => ({ review_id: reviewer_id, reviewer_id, reviewer_kind: "model", verdict: "pass", input_hash: sha("a"), evidence_snapshot_hash: sha("b"), policy_digest: sha("c"), reviewer_model: model, prompt_digest: prompt });
  assert.equal(satisfiesStrongIndependence([review("b", "m1", "p1")], high), false);
  assert.equal(satisfiesStrongIndependence([review("b", "m1", "p1"), review("c", "m1", "p1")], high), false);
  assert.equal(satisfiesStrongIndependence([review("b", "m1", "p1"), review("c", "m2", "p2")], high), true);
  assert.equal(satisfiesStrongIndependence([{ ...review("b", "m1", "p1"), reviewer_kind: "human" }], high), true, "a human reviewer satisfies the strong independence bar alone");
  const empty = evaluateAdmission({ subject: { id: "s", kind: "finding" }, policy: DEFAULT_ADMISSION_POLICY, policy_digest: sha("c"), evidence: [], reviews: [], input_hash: sha("a"), evidence_snapshot_hash: sha("b") });
  assert.equal(empty.admitted, false);
  assert.ok(empty.reasons.some((reason) => /evidence/.test(reason)));
});
