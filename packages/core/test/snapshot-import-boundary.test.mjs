import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal } from "../dist/index.js";

test("public snapshot.import is unsupported before dispatch or Core service mutation", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const operator = createPrincipal("operator", "snapshot-operator");
  try {
    const before = await store.events();
    const request = { engagement_id: "not-used", snapshot: { records: [{ secret: "must not be read" }] } };
    assert.deepEqual(await service.dispatch("snapshot.import", operator, request), {
      ok: false,
      error: {
        code: "unsupported_capability",
        message: "operation is deferred to evolve-engagement-memory",
        follow_up: "evolve-engagement-memory",
      },
    });
    assert.deepEqual(await service.snapshotImport(operator, request), {
      ok: false,
      error: {
        code: "unsupported_capability",
        message: "public snapshot import is unsupported; use isolated backend backup/restore",
        follow_up: "evolve-engagement-memory",
      },
    });
    assert.deepEqual(await store.events(), before);
  } finally {
    await service.close();
  }
});
