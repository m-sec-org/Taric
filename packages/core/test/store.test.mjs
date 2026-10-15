import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("store commits records, events and idempotent results", async () => {
  const store = new AuthorityStore();
  const record = { id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "safe" };
  const first = (await store.commit(record, "L1", "once"));
  const second = (await store.commit(record, "L1", "once"));
  assert.deepEqual(second, first);
  assert.equal((await store.get(record.id)).trust_level, "L1");
  assert.equal((await store.verifyAudit()).valid, true);
  (await store.close());
});

test("ordinary recall excludes proposals and machine candidates unless requested", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  (await store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "verified" }, "L2"));
  (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", title: "candidate" }, "L1"));
  assert.equal((await store.list(engagement_id)).length, 1);
  assert.equal((await store.list(engagement_id, { includeCandidates: true })).length, 2);
  (await store.close());
});
