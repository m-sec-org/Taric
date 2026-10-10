import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

test("Core dispatch keeps proposals private and binds review identity to the verified principal", () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const engagement_id = uuidv7();
  const model = createPrincipal("model", "model-a", engagement_id);
  const operator = createPrincipal("operator", "operator-a", engagement_id);
  const reviewer = createPrincipal("reviewer", "reviewer-a", engagement_id);
  const content = { id: uuidv7(), engagement_id, kind: "claim", proposition: "candidate" };

  const submitted = service.dispatch("proposal.submit", model, { engagement_id, subject_type: "claim", base_version: 0, content });
  assert.equal(submitted.ok, true);
  assert.equal(store.get(content.id), undefined, "model proposal cannot mutate canonical records");
  assert.equal(service.dispatch("review.submit", { ...reviewer, id: "forged" }, {
    engagement_id, proposal_id: submitted.data.id, reviewer_id: "reviewer-a", reviewer_kind: "reviewer",
    input_hash: submitted.data.content_hash, verdict: "pass", policy_digest: "sha256:policy",
  }).error.code, "authorization_error");

  const review = service.dispatch("review.submit", reviewer, {
    engagement_id, proposal_id: submitted.data.id, reviewer_id: "reviewer-a", reviewer_kind: "reviewer",
    input_hash: submitted.data.content_hash, verdict: "pass", policy_digest: "sha256:policy",
  });
  assert.equal(review.ok, true);
  const admission = service.dispatch("admission.commit", operator, {
    engagement_id, proposal_id: submitted.data.id, policy_digest: "sha256:policy", expected_base_version: 0,
  });
  assert.equal(admission.ok, true);
  assert.equal(admission.data.record.trust_level, "L1");
  store.close();
});

test("Core dispatch returns stable unsupported responses for deferred and unknown operations", () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const operator = createPrincipal("operator", "operator-a");
  assert.equal(service.dispatch("work.renew", operator, {}).error.code, "unsupported_capability");
  assert.equal(service.dispatch("operation.missing", operator, {}).error.code, "unsupported_capability");
  assert.equal(service.dispatch("query", operator, undefined).error.code, "validation_error");
  assert.equal(service.dispatch("query", operator, { engagement_id: uuidv7(), contract_version: "9.9.9" }).error.code, "unsupported_schema_version");
  store.close();
});
