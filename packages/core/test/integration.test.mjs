import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, buildContextPack, createDeepSeekHarnessAdapter, createPiAdapter, publishProjection, uuidv7 } from "../dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cross-adapter integration preserves one Core state and projection boundary", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7();
  const pi = createPiAdapter(store, "test"); const dsh = createDeepSeekHarnessAdapter(store, "test");
  const piRecord = pi.store.commit({ id: uuidv7(), engagement_id, kind: "resource", name: "pi" }, "L2");
  const dshRecord = dsh.store.commit({ id: uuidv7(), engagement_id, kind: "resource", name: "dsh" }, "L2");
  const context = buildContextPack(store, engagement_id, 10000);
  assert.equal(context.items.length, 2); assert.ok(context.read_seq > 0);
  const dir = await mkdtemp(join(tmpdir(), "taric-integration-"));
  const projection = await publishProjection(store, { engagementId: engagement_id, outputDir: dir });
  assert.equal(projection.files.length, 2); assert.equal(store.verifyAudit().valid, true);
  await rm(dir, { recursive: true, force: true }); store.close();
});
