import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, uuidv7 } from "@taric/core";
import { modelTools, createMcpServer } from "../dist/server.js";

function modelService() {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  return { store, service, principal: { id: "mcp-model", role: "model", engagement_id: "engagement-a", transport_verified: true } };
}

test("initialize and tools/list expose only model-facing tools", () => {
  const { store, service, principal } = modelService();
  const server = createMcpServer(service, principal);
  const init = server.initialize({ protocolVersion: "2024-11-05" });
  assert.equal(init.serverInfo.name, "taric-mcp");
  const listed = server.toolsList();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [...modelTools]);
  for (const tool of listed.tools) {
    assert.ok(tool.inputSchema.required.length > 0, `${tool.name} requires arguments`);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  store.close();
});

test("tools/call rejects host and operator operations", () => {
  const { store, service, principal } = modelService();
  const server = createMcpServer(service, principal);
  const eventCount = store.events().length;
  for (const name of ["checkpoint.commit", "admission.evaluate", "snapshot.export", "engagement.init", "action.host-decision", "target.execute", "writer.commit"]) {
    const result = server.toolsCall({ name, arguments: { engagement_id: "engagement-a" } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, "authorization_error");
  }
  const extraPath = server.toolsCall({ name: "resource.query", arguments: { engagement_id: "engagement-a", path: "/etc/passwd" } });
  assert.equal(extraPath.isError, true);
  assert.equal(JSON.parse(extraPath.content[0].text).error.code, "validation_error");
  assert.equal(store.events().length, eventCount);
  store.close();
});

test("tools/call validates required and unexpected arguments", () => {
  const { store, service, principal } = modelService();
  const server = createMcpServer(service, principal);
  const missing = server.toolsCall({ name: "action.recommend", arguments: { engagement_id: "engagement-a" } });
  assert.equal(JSON.parse(missing.content[0].text).error.code, "validation_error");
  const extra = server.toolsCall({ name: "resource.query", arguments: { engagement_id: "engagement-a", display_id: "TAR-1" } });
  assert.equal(JSON.parse(extra.content[0].text).error.code, "validation_error");
  store.close();
});

test("model principal cannot read another engagement", () => {
  const { store, service, principal } = modelService();
  const server = createMcpServer(service, principal);
  const result = server.toolsCall({ name: "resource.query", arguments: { engagement_id: "engagement-b" } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "authorization_error");
  store.close();
});

test("MCP protocol layer never returns credentials or db paths", () => {
  const { store, service, principal } = modelService();
  const server = createMcpServer(service, principal);
  const result = server.toolsCall({ name: "resource.query", arguments: { engagement_id: "engagement-a" } });
  assert.doesNotMatch(result.content[0].text, /AuthorityStore|\.sqlite|credential|SecretRef/i);
  store.close();
});
