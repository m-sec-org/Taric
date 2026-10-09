import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, buildContextPack, createCoverageCell, createNegativeObservation, uuidv7 } from "../dist/index.js";

test("coverage cells and bounded negative observations preserve conditions", () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const resource_ref = uuidv7();
  store.commit({ id: resource_ref, engagement_id, kind: "endpoint", name: "/admin" }, "L1");
  const cell = createCoverageCell(store, { engagement_id, resource_ref, test_category: "access-control", status: "blocked_by_control", limitations: ["edge block"] });
  const negative = createNegativeObservation(store, { engagement_id, statement: "未在本次测试条件下观察到越权", method: "GET", tested_resource_refs: [resource_ref], conditions: ["role=user"], evidence_refs: [], limitations: ["edge block"] });
  assert.equal(cell.status, "blocked_by_control"); assert.deepEqual(negative.conditions, ["role=user"]);
  assert.throws(() => createNegativeObservation(store, { engagement_id, statement: "vulnerable", method: "GET", tested_resource_refs: [resource_ref], conditions: [], evidence_refs: [], limitations: [] }), /bounded/);
  store.close();
});

test("context packs preserve a pinned sequence and mark truncation", () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7();
  for (let i = 0; i < 3; i++) store.commit({ id: uuidv7(), engagement_id, kind: "note", text: "large note".repeat(20) }, "L2");
  const pack = buildContextPack(store, engagement_id, 100);
  assert.equal(pack.omitted_as_unexamined, true); assert.ok(pack.cursor); assert.ok(pack.read_seq > 0);
  store.close();
});
