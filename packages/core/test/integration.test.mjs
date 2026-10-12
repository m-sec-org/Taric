import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, buildContextPack, createCoreService, createDeepSeekHarnessAdapter, createHermesAdapter, createPiAdapter, createPrincipal, publishProjection, uuidv7 } from "../dist/index.js";
import { createMcpServer } from "../../mcp/dist/server.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cross-adapter integration preserves one Core state and projection boundary", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7();
  const service = createCoreService(store);
  const pi = createPiAdapter(service, createPrincipal("host", "pi-host", engagement_id));
  const dsh = createDeepSeekHarnessAdapter(service, createPrincipal("host", "dsh-host", engagement_id));
  const hermes = createHermesAdapter(service, createPrincipal("host", "hermes-host", engagement_id));
  assert.equal(dsh.descriptor.supported, true);
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

test("Pi, DeepSeek, Hermes and MCP share pinned state, identity and scoped errors", async () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7(); const service = createCoreService(store);
  service.init({ id: engagement_id, name: "conformance" });
  const record = store.commit({ id: uuidv7(), engagement_id, kind: "resource", name: "shared" }, "L2");
  const pinnedSeq = store.snapshot(engagement_id).read_seq;
  const pi = createPiAdapter(service, createPrincipal("host", "pi-host", engagement_id));
  const dsh = createDeepSeekHarnessAdapter(service, createPrincipal("host", "dsh-host", engagement_id));
  const hermes = createHermesAdapter(service, createPrincipal("host", "hermes-host", engagement_id));
  const mcp = createMcpServer(service, createPrincipal("model", "mcp-model", engagement_id));
  const reads = await Promise.all([pi.call("query", { engagement_id, as_of: pinnedSeq }), dsh.call("query", { engagement_id, as_of: pinnedSeq }), hermes.call("query", { engagement_id, as_of: pinnedSeq })]);
  for (const result of reads) {
    assert.equal(result.ok, true);
    assert.equal(result.data.records.some((item) => item.id === record.id), true);
  }
  const mcpRead = mcp.toolsCall({ name: "resource.query", arguments: { engagement_id, as_of: pinnedSeq } });
  assert.equal(JSON.parse(mcpRead.content[0].text).ok, true);
  for (const adapter of [pi, dsh, hermes]) {
    const denied = await adapter.call("query", { engagement_id: uuidv7() });
    assert.equal(denied.ok, false); assert.equal(denied.error.code, "authorization_error");
  }
  store.close();
});
