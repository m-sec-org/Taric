import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("stale propagation creates a new current view without mutating the prior event", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  // A verified finding must be traceable: evidence, limitations, an independent
  // review reference and the admitting policy digest are all required (task 2.2).
  const claim_id = uuidv7();
  const evidence_id = uuidv7();
  (await store.commit({ id: claim_id, engagement_id, kind: "claim", proposition: "stale subject", status: "proposed", evidence_refs: [], limitations: [] }, "L2"));
  (await store.commit({ id: evidence_id, engagement_id, kind: "evidence", artifact_ref: { host_ref: "host-artifact:1" }, observed_at: new Date().toISOString(), limitations: [] }, "L2"));
  const review_id = uuidv7();
  (await store.commit({ id: review_id, engagement_id, kind: "review_record", reviewer_id: "reviewer-b", reviewer_kind: "reviewer", verdict: "pass", input_hash: `sha256:${"c".repeat(64)}` }, "L2"));
  const record = (await store.commit({
    id: uuidv7(),
    engagement_id,
    kind: "finding",
    title: "stale subject",
    claim_refs: [claim_id],
    evidence_refs: [evidence_id],
    limitations: ["single identity"],
    review_ref: review_id,
    policy_digest: `sha256:${"b".repeat(64)}`,
    status: "verified",
  }, "L2"));
  const stale = (await store.markStale(record.id, "evidence changed"));
  assert.equal(stale.status, "stale");
  assert.equal((await store.verifyAudit()).valid, true);
  assert.equal((await store.events()).filter((event) => event.subject_id === record.id).length, 3);
  (await store.close());
});
