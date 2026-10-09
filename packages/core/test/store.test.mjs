import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("store commits records, events and idempotent results", () => {
  const store = new AuthorityStore();
  const record = { id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "safe" };
  const first = store.commit(record, "L1", "once");
  const second = store.commit(record, "L1", "once");
  assert.deepEqual(second, first);
  assert.equal(store.get(record.id).trust_level, "L1");
  assert.equal(store.verifyAudit().valid, true);
  store.close();
});

test("ordinary recall excludes proposals and machine candidates unless requested", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "verified" }, "L2");
  store.commit({ id: uuidv7(), engagement_id, kind: "claim", title: "candidate" }, "L1");
  assert.equal(store.list(engagement_id).length, 1);
  assert.equal(store.list(engagement_id, { includeCandidates: true }).length, 2);
  store.close();
});
