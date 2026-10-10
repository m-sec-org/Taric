import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, buildContextPack, createCoreService, createDeepSeekHarnessAdapter, createPiAdapter, createPrincipal, publishProjection, uuidv7 } from "../dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cross-adapter integration preserves one Core state and projection boundary", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7();
  const service = createCoreService(store);
  const pi = createPiAdapter(service, createPrincipal("host", "pi-host", engagement_id));
  const dsh = createDeepSeekHarnessAdapter(service, createPrincipal("host", "dsh-host", engagement_id), "test");
  assert.equal(dsh.descriptor.supported, false);
  // adapter 不再持有 store，只能经 Core service 观察同一份 authority 状态。
  const piRecord = store.commit({ id: uuidv7(), engagement_id, kind: "resource", name: "pi" }, "L2");
  const dshRecord = store.commit({ id: uuidv7(), engagement_id, kind: "resource", name: "dsh" }, "L2");
  const throughCore = await pi.call("query", { engagement_id });
  assert.equal(throughCore.ok, true);
  assert.equal(throughCore.data.records.length, 2);
  const context = buildContextPack(store, engagement_id, 10000);
  assert.equal(context.items.length, 2); assert.ok(context.read_seq > 0);
  const dir = await mkdtemp(join(tmpdir(), "taric-integration-"));
  const projection = await publishProjection(store, { engagementId: engagement_id, outputDir: dir });
  assert.equal(projection.files.length, 2); assert.equal(store.verifyAudit().valid, true);
  await rm(dir, { recursive: true, force: true }); store.close();
});
