import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("admission rejects stale proposal and admits valid proposal as L1", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const id = uuidv7();
  const first = (await store.commit({ id, engagement_id, kind: "claim", proposition: "one" }, "L1"));
  const proposal = (await store.submitProposal({ proposal_id: uuidv7(), engagement_id, subject_type: "claim", target_id: id, expected_version: first.version, content: { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "two", status: "proposed", evidence_refs: [], limitations: [] } }));
  (await store.commit({ id, engagement_id, kind: "claim", proposition: "three" }, "L1", undefined, { expected_version: first.version }));
  const result = (await store.admitProposal(proposal.id, "sha256:policy", { validate: () => undefined }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /stale/);
  (await store.close());
});

test("CAS preserves version checks", async () => {
  const store = new AuthorityStore();
  const record = (await store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "resource", name: "a" }, "L1"));
  const updated = (await store.compareAndSet(record.id, record.version, { name: "b" }));
  assert.equal(updated.name, "b");
  (await assert.rejects(async () => (await store.compareAndSet(record.id, record.version, { name: "c" })), /version conflict/));
  (await store.close());
});
