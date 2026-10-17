import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, listenAdapterRpc, listenArtifactBinaryRpc, uuidv7 } from "../dist/index.js";

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

test("ordinary adapter RPC rejects envelopes above the 1 MiB line bound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-rpc-envelope-")); const path = join(dir, "core.sock"); const token = "e".repeat(48);
  const listener = await listenAdapterRpc({ dispatch: async () => ({ ok: true, data: {} }) }, { socket_path: path, token, principal: createPrincipal("host", "test-host", uuidv7()) });
  try {
    const socket = createConnection(path);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
    await closed;
    assert.equal(socket.destroyed, true);
  } finally { await listener.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ordinary JSON-RPC keeps Artifact reads and serialized responses within its declared frame", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-rpc-artifact-bounds-")); const path = join(dir, "core.sock"); const token = "h".repeat(48); let received;
  const listener = await listenAdapterRpc({ dispatch: async (_operation, _principal, request) => { received = request; return { ok: true, data: { accepted: true } }; } }, { socket_path: path, token, principal: createPrincipal("host", "bounded-host", uuidv7()) });
  try {
    const read = await request(path, { token, operation: "artifact.content.read", request: { engagement_id: uuidv7(), session_id: "s", content_ref: "artifact@v1", length: 64 * 1024 * 1024 } });
    assert.equal(read.result.ok, true); assert.equal(received.max_response_bytes, 512 * 1024);
    const oversized = await request(path, { token, operation: "artifact.content.read", request: { engagement_id: uuidv7(), session_id: "s", content_ref: "artifact@v1", max_response_bytes: 512 * 1024 + 1 } });
    assert.equal(oversized.result.error.code, "validation_error");
  } finally { await listener.close(); await rm(dir, { recursive: true, force: true }); }

  const responseDir = await mkdtemp(join(tmpdir(), "taric-rpc-response-bounds-")); const responsePath = join(responseDir, "core.sock");
  const responseListener = await listenAdapterRpc({ dispatch: async () => ({ ok: true, data: { body: "x".repeat(1024 * 1024 + 1) } }) }, { socket_path: responsePath, token, principal: createPrincipal("host", "bounded-host", uuidv7()) });
  try {
    const bounded = await request(responsePath, { token, operation: "bounded.test", request: {} });
    assert.equal(bounded.result.error.code, "validation_error");
  } finally { await responseListener.close(); await rm(responseDir, { recursive: true, force: true }); }
});

async function binaryAppend(socketPath, token, request, bytes, chunkBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let received = ""; let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    const timer = setTimeout(() => { socket.destroy(); finish(reject, new Error("binary Artifact response timed out")); }, 5_000);
    socket.setEncoding("utf8");
    socket.on("error", (error) => finish(reject, error));
    socket.on("close", () => { if (!settled) finish(reject, new Error("binary Artifact socket closed before its response")); });
    socket.on("data", (chunk) => { received += chunk; if (received.includes("\n")) finish(resolve, JSON.parse(received.slice(0, received.indexOf("\n")))); });
    socket.once("connect", async () => {
      try {
        const header = Buffer.from(JSON.stringify({ token, operation: "artifact.store.append.binary", request }));
        socket.write(Buffer.concat([Buffer.from([header.length >>> 24, header.length >>> 16, header.length >>> 8, header.length]), header]));
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          const part = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
          if (!socket.write(part)) await new Promise((done) => socket.once("drain", done));
        }
        socket.end();
      } catch (error) { reject(error); }
    });
  });
}

test("authenticated Artifact binary socket streams bounded bytes and rejects bad hashes without publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-artifact-binary-rpc-")); const contentRoot = join(dir, "content"); const store = new AuthorityStore();
  const engagement_id = uuidv7(); const session_id = "binary-session"; const token = "f".repeat(48); const principal = createPrincipal("host", "binary-host", engagement_id);
  const service = await createCoreService(store, contentRoot); const path = join(dir, "artifact.sock");
  const listener = await listenArtifactBinaryRpc(service, { socket_path: path, token, principal });
  try {
    assert.equal((await service.dispatch("artifact.session.bind", principal, { engagement_id, session_id, root: join(contentRoot, session_id), mode: "host-session" })).ok, true);
    const bytes = Buffer.alloc(384 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const begun = await service.dispatch("artifact.store.begin", principal, { engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", expected_bytes: bytes.length, expected_hash: digest });
    const requestData = { engagement_id, session_id, upload_id: begun.data.upload_id, ordinal: 0, byte_length: bytes.length, chunk_hash: digest };
    const appended = await binaryAppend(path, token, requestData, bytes, 4096);
    assert.equal(appended.ok, true); assert.equal(appended.data.next_ordinal, 1);
    const committed = await service.dispatch("artifact.store.commit", principal, { engagement_id, session_id, upload_id: begun.data.upload_id, total_bytes: bytes.length, chunk_count: 1, content_hash: digest });
    assert.equal(committed.ok, true);
    const reader = createPrincipal("host", "binary-reader", engagement_id, ["content_read"]);
    const read = await service.dispatch("artifact.content.read", reader, { engagement_id, session_id, content_ref: committed.data.content_ref, max_response_bytes: bytes.length });
    assert.deepEqual(Buffer.from(read.data.data, "base64"), bytes);

    const bad = await service.dispatch("artifact.store.begin", principal, { engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream" });
    const rejected = await binaryAppend(path, token, { engagement_id, session_id, upload_id: bad.data.upload_id, ordinal: 0, byte_length: bytes.length, chunk_hash: `sha256:${"0".repeat(64)}` }, bytes);
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, "conflict");
    const listed = await service.dispatch("artifact.content.list", principal, { engagement_id, session_id, page_size: 10 });
    assert.equal(listed.data.items.length, 1);
  } finally { await listener.close(); await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Artifact binary listener bounds active upload connections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-artifact-binary-capacity-")); const store = new AuthorityStore();
  const engagement_id = uuidv7(); const token = "g".repeat(48); const principal = createPrincipal("host", "capacity-host", engagement_id);
  const listener = await listenArtifactBinaryRpc({ artifactStoreAppendBinaryStream: async () => ({ ok: true, data: {} }) }, { socket_path: join(dir, "artifact.sock"), token, principal });
  const idle = [createConnection(join(dir, "artifact.sock")), createConnection(join(dir, "artifact.sock"))];
  try {
    await Promise.all(idle.map((socket) => new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); })));
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(join(dir, "artifact.sock")); let data = ""; socket.setEncoding("utf8");
      socket.on("error", reject); socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) resolve(JSON.parse(data.slice(0, data.indexOf("\n")))); });
    });
    assert.equal(response.error.code, "unavailable_host");
  } finally { for (const socket of idle) socket.destroy(); await listener.close(); await store.close(); await rm(dir, { recursive: true, force: true }); }
});
