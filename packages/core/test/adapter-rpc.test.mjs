import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, listenAdapterRpc, uuidv7 } from "../dist/index.js";

async function request(socketPath, params) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let data = "";
    socket.setEncoding("utf8"); socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "taric.dispatch", params })}\n`));
    socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) { socket.end(); resolve(JSON.parse(data)); } }); socket.on("error", reject);
  });
}

test("native adapter socket authenticates a scoped host and rejects token or engagement bypass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-adapter-rpc-")); const store = new AuthorityStore();
  const engagement_id = uuidv7(); store.commit({ id: engagement_id, engagement_id, kind: "engagement", name: "test" }, "L2");
  const path = join(dir, "core.sock"); const token = "a".repeat(48);
  const listener = await listenAdapterRpc(createCoreService(store), { socket_path: path, token, principal: createPrincipal("host", "hermes", engagement_id) });
  try {
    const connected = await request(path, { token, operation: "engagement.status", request: { engagement_id } });
    assert.equal(connected.result.ok, true);
    const unauthenticated = await request(path, { token: "bad", operation: "engagement.status", request: { engagement_id } });
    assert.equal(unauthenticated.error.message, "authorization_error");
    const cross = await request(path, { token, operation: "engagement.status", request: { engagement_id: uuidv7() } });
    assert.equal(cross.result.error.code, "authorization_error");
  } finally { await listener.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
