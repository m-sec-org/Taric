import test from "node:test";
import assert from "node:assert/strict";
import { API_CONTRACT_VERSION, AuthorityStore, createCoreService, createPrincipal, policyDigest, uuidv7 } from "../dist/index.js";

test("Core dispatch keeps proposals private and binds review identity to the verified principal", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const model = createPrincipal("model", "model-a", engagement_id);
  const operator = createPrincipal("operator", "operator-a", engagement_id);
  const reviewer = createPrincipal("reviewer", "reviewer-a", engagement_id);
  const policy_digest = policyDigest();
  const content = { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "candidate", status: "proposed", evidence_refs: [], limitations: [] };

  const submitted = (await service.dispatch("proposal.submit", model, { engagement_id, subject_type: "claim", expected_version: 0, content }));
  assert.equal(submitted.ok, true);
  assert.equal((await store.list(engagement_id, { includeCandidates: true })).length, 0, "model proposal cannot mutate canonical records");
  assert.equal((await service.dispatch("review.submit", { ...reviewer, id: "forged" }, {
    engagement_id, proposal_id: submitted.data.id, reviewer_id: "reviewer-a", reviewer_kind: "reviewer",
    input_hash: submitted.data.content_hash, verdict: "pass", policy_digest,
  })).error.code, "authorization_error");

  const review = (await service.dispatch("review.submit", reviewer, {
    engagement_id, proposal_id: submitted.data.id, reviewer_id: "reviewer-a", reviewer_kind: "reviewer",
    input_hash: submitted.data.content_hash, verdict: "pass", policy_digest,
  }));
  assert.equal(review.ok, true);
  const admission = (await service.dispatch("admission.commit", operator, {
    engagement_id, proposal_id: submitted.data.id, policy_digest: `sha256:${"a".repeat(64)}`, expected_version: 0,
  }));
  assert.equal(admission.ok, true);
  assert.equal(admission.data.record.trust_level, "L1");
  (await store.close());
});

test("Core dispatch distinguishes unauthorized supported operations from unsupported operations", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const operator = createPrincipal("operator", "operator-a");
  assert.equal((await service.dispatch("work.renew", operator, {})).error.code, "authorization_error");
  assert.equal((await service.dispatch("operation.missing", operator, {})).error.code, "unsupported_capability");
  assert.equal((await service.dispatch("query", operator, undefined)).error.code, "validation_error");
  assert.equal(API_CONTRACT_VERSION, "1.3.0");
  assert.equal((await service.dispatch("query", operator, { engagement_id: uuidv7(), contract_version: API_CONTRACT_VERSION })).ok, true);
  const before = await store.events();
  assert.equal((await service.dispatch("query", operator, { engagement_id: uuidv7(), contract_version: "1.2.0" })).error.code, "unsupported_schema_version");
  assert.deepEqual(await store.events(), before, "a request using the prior API contract version is rejected before state changes");
  assert.equal((await service.dispatch("query", operator, { engagement_id: uuidv7(), contract_version: "9.9.9" })).error.code, "unsupported_schema_version");
  (await store.close());
});

test("dispatch rejects self-asserted principals and host requests outside the bound engagement", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const forged = { id: "forged-host", role: "host", engagement_id, transport_verified: true };
  assert.equal((await service.dispatch("work.claim", forged, { engagement_id, work_item_id: uuidv7(), agent_id: "worker" })).error.code, "authorization_error");

  const host = createPrincipal("host", "pi-host", engagement_id);
  assert.equal((await service.dispatch("work.claim", host, { engagement_id: uuidv7(), work_item_id: uuidv7(), agent_id: "worker" })).error.code, "authorization_error");
  (await store.close());
});
