import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("stale propagation creates a new current view without mutating the prior event", () => {
  const store = new AuthorityStore();
  const record = store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "finding", status: "verified" }, "L2");
  const stale = store.markStale(record.id, "evidence changed");
  assert.equal(stale.status, "stale");
  assert.equal(store.verifyAudit().valid, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE subject_id=?").get(record.id).count, 2);
  store.close();
});
