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
  const engagement_id = uuidv7(); (await store.commit({ id: engagement_id, engagement_id, kind: "engagement", name: "test" }, "L2"));
  const path = join(dir, "core.sock"); const token = "a".repeat(48);
  const listener = await listenAdapterRpc((await createCoreService(store)), { socket_path: path, token, principal: createPrincipal("host", "hermes", engagement_id) });
  try {
    const connected = await request(path, { token, operation: "engagement.status", request: { engagement_id } });
    assert.equal(connected.result.ok, true);
    const unauthenticated = await request(path, { token: "bad", operation: "engagement.status", request: { engagement_id } });
    assert.equal(unauthenticated.error.message, "authorization_error");
    const cross = await request(path, { token, operation: "engagement.status", request: { engagement_id: uuidv7() } });
    assert.equal(cross.result.error.code, "authorization_error");
  } finally { await listener.close(); (await store.close()); await rm(dir, { recursive: true, force: true }); }
});

test("adapter processes pipelined frames, retains partial requests and keeps the connection usable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-rpc-frames-")); const store = new AuthorityStore();
  const engagement_id = uuidv7(); const token = "b".repeat(48); const path = join(dir, "core.sock");
  const listener = await listenAdapterRpc((await createCoreService(store)), { socket_path: path, token, principal: createPrincipal("host", "test-host", engagement_id) });
  const frame = (id, suppliedToken = token) => JSON.stringify({ jsonrpc: "2.0", id, method: "taric.dispatch", params: { token: suppliedToken, operation: "engagement.status", request: { engagement_id } } });
  const socket = createConnection(path);
  const received = []; let buffer = "";
  const next = (count) => new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(new Error(`expected ${count} responses, received ${received.length}`)), 5_000); const poll = () => { if (received.length >= count) { clearTimeout(deadline); socket.off("data", poll); resolve(); } }; socket.on("data", poll); poll(); });
  socket.setEncoding("utf8"); socket.on("data", (chunk) => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\n")) >= 0) { received.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); } });
  try {
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const partial = frame(3); const split = Math.floor(partial.length / 2);
    socket.write(`${frame(1)}\n${frame(2)}\n${partial.slice(0, split)}`);
    await next(2); assert.deepEqual(received.map((row) => row.id), [1, 2]); assert.equal(socket.destroyed, false);
    socket.write(`${partial.slice(split)}\n{oops\n${frame(4, "bad")}\n${frame(5)}\n`);
    await next(6);
    assert.deepEqual(received.map((row) => row.id), [1, 2, 3, null, 4, 5]);
    assert.equal(received[3].error.code, -32700); assert.equal(received[4].error.code, -32001);
    assert.equal(received[5].result.ok, true); assert.equal(socket.destroyed, false);
  } finally { socket.destroy(); await listener.close(); (await store.close()); await rm(dir, { recursive: true, force: true }); }
});

test("adapter hides unexpected dispatch failures and listener shutdown closes idle clients", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-rpc-errors-")); const path = join(dir, "core.sock"); const token = "c".repeat(48);
  const listener = await listenAdapterRpc({ dispatch: () => { throw new Error("SQL /private/path token-canary stale lease"); } }, { socket_path: path, token, principal: createPrincipal("host", "test-host", uuidv7()) });
  try {
    const response = await request(path, { token, operation: "query", request: {} });
    assert.deepEqual(response.result.error, { code: "internal_error", message: "internal error" });
    assert.doesNotMatch(JSON.stringify(response), /private|canary|SQL|stale/);
    const idle = createConnection(path); await new Promise((resolve) => idle.once("connect", resolve));
    const closed = new Promise((resolve) => idle.once("close", resolve));
    await listener.close(); await closed;
  } finally { if (listener.server.listening) await listener.close(); await rm(dir, { recursive: true, force: true }); }
});
