import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("admission rejects stale proposal and admits valid proposal as L1", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const id = uuidv7();
  const first = store.commit({ id, engagement_id, kind: "claim", proposition: "one" }, "L1");
  const proposal = store.submitProposal({ id: uuidv7(), engagement_id, subject_type: "claim", base_version: first.version, content: { id, engagement_id, kind: "claim", proposition: "two" } });
  store.commit({ id, engagement_id, kind: "claim", proposition: "three" }, "L1", undefined, { expected_version: first.version });
  const result = store.admitProposal(proposal.id, "sha256:policy", { validate: () => undefined });
  assert.equal(result.ok, false);
  assert.match(result.reason, /stale/);
  store.close();
});

test("CAS preserves version checks", () => {
  const store = new AuthorityStore();
  const record = store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "resource", name: "a" }, "L1");
  const updated = store.compareAndSet(record.id, record.version, { name: "b" });
  assert.equal(updated.name, "b");
  assert.throws(() => store.compareAndSet(record.id, record.version, { name: "c" }), /version conflict/);
  store.close();
});
