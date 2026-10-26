import test from "node:test";
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { connect as connectTls } from "node:tls";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrincipal, createCoreService, AuthorityStore, uuidv7 } from "@taric/core";
import { parseGatewayConfig, gatewayResolver, startGateway } from "../dist/gateway.js";

const hostToken = "host-token-0123456789abcdef0123456789abcdef";
const rotatedHostToken = "host-token-rotated-0123456789abcdef0123456789";
const reviewerToken = "reviewer-token-0123456789abcdef01234567";

test("gateway config validation rejects malformed tables", () => {
  assert.ok(parseGatewayConfig(JSON.stringify({ socket_path: "/tmp/g.sock", tokens: [{ token: hostToken, role: "host", principal_id: "h" }] })));
  for (const bad of [
    { socket_path: "", tokens: [] },
    { socket_path: "/tmp/g.sock", tokens: [{ token: "short", role: "host", principal_id: "h" }] },
    { socket_path: "/tmp/g.sock", tokens: [{ token: hostToken, role: "superuser", principal_id: "h" }] },
    { socket_path: "/tmp/g.sock", tokens: [{ token: hostToken, role: "host" }] },
    { socket_path: "/tmp/g.sock", tokens: [{ token: hostToken, role: "host", principal_id: "h" }, { token: hostToken, role: "host", principal_id: "h2" }] },
    { tls_tcp: { host: "127.0.0.1", port: 1234 }, tokens: [{ token: hostToken, role: "host", principal_id: "h" }] },
    { https: { host: "127.0.0.1", port: 1234 }, tls: { key_file: "key.pem" }, tokens: [{ token: hostToken, role: "host", principal_id: "h" }] },
    { https: { host: "127.0.0.1", port: 1234, path: "/rpc?bad" }, tls: { key_file: "key.pem", cert_file: "cert.pem" }, tokens: [{ token: hostToken, role: "host", principal_id: "h" }] },
  ]) assert.throws(() => parseGatewayConfig(JSON.stringify(bad)));
  assert.throws(() => parseGatewayConfig(JSON.stringify({ tls_tcp: { host: "127.0.0.1", port: 1234 }, tokens: [{ token: hostToken, role: "host", principal_id: "h" }] })));
});

test("gateway resolver maps table tokens exactly and fails closed on mismatch", () => {
  const resolver = gatewayResolver([
    { token: hostToken, role: "host", principal_id: "host-gw", engagement_id: "e1" },
    { token: reviewerToken, role: "reviewer", principal_id: "reviewer-gw", engagement_id: "e1" },
  ]);
  const host = resolver({ role: "host", principal_id: "host-gw", engagement_id: "e1" }, hostToken);
  assert.equal(host.role, "host");
  assert.equal(host.engagement_id, "e1");
  assert.throws(() => resolver({ role: "operator", principal_id: "host-gw" }, hostToken), /does not match/);
  assert.throws(() => resolver({ role: "host", principal_id: "host-gw" }, "unknown-token-0123456789abcdef012345678"), /unknown gateway token/);
});

function rpcClient(socketPath) {
  const socket = connect(socketPath);
  socket.setEncoding("utf8");
  const lines = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  const waitForLine = async (match, timeoutMs = 4000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = lines.find(match);
      if (found !== undefined) return JSON.parse(found);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`line not received; got: ${lines.join(" || ")}`);
  };
  return { socket, send: (frame) => socket.write(`${JSON.stringify(frame)}\n`), waitForLine };
}

test("taric gateway serves configured tokens over one listener end to end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-gw-cli-"));
  const dbPath = join(directory, "authority.sqlite");
  const contentRoot = join(directory, "content");
  const store = new AuthorityStore(dbPath);
  const service = await createCoreService(store, contentRoot);
  const operator = createPrincipal("operator", "op-a");
  const initialized = await service.dispatch("engagement.init", operator, { name: "gw-cli", scope: { allowed_targets: ["https://gw.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:gw" } });
  const engagement_id = initialized.data.id;
  const configPath = join(directory, "gateway.json");
  await writeFile(configPath, JSON.stringify({
    socket_path: join(directory, "gw.sock"),
    tokens: [
      { token: hostToken, role: "host", principal_id: "host-gw", engagement_id },
      { token: reviewerToken, role: "reviewer", principal_id: "reviewer-gw", engagement_id },
    ],
  }));
  await writeFile(join(directory, "config.json"), JSON.stringify({ db_path: dbPath, content_root: contentRoot, engagement_id }));
  const gateway = await startGateway(configPath, { TARIC_CONFIG: join(directory, "config.json") });
  try {
    const hostClient = rpcClient(join(directory, "gw.sock"));
    hostClient.send({ jsonrpc: "2.0", id: 1, method: "taric.identify", params: { token: hostToken, declare: { role: "host", principal_id: "host-gw", engagement_id } } });
    const identified = await hostClient.waitForLine((line) => line.includes('"id":1'));
    assert.equal(identified.result.ok, true, JSON.stringify(identified));
    hostClient.send({ jsonrpc: "2.0", id: 2, method: "taric.dispatch", params: { token: hostToken, operation: "engagement.status", request: { engagement_id } } });
    const status = await hostClient.waitForLine((line) => line.includes('"id":2'));
    assert.equal(status.result.ok, true, JSON.stringify(status));
    // 伪造声明：host token 声明 reviewer 身份。
    const forged = rpcClient(join(directory, "gw.sock"));
    forged.send({ jsonrpc: "2.0", id: 3, method: "taric.identify", params: { token: hostToken, declare: { role: "reviewer", principal_id: "reviewer-gw", engagement_id } } });
    const rejected = await forged.waitForLine((line) => line.includes('"id":3'));
    assert.match(rejected.error.message, /authorization/);
    hostClient.socket.destroy();
    forged.socket.destroy();
  } finally {
    await gateway.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitForRpcLine(socket, id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(reject, new Error(`TLS RPC response ${id} timed out`)), timeoutMs);
    const finish = (callback, value) => { clearTimeout(timer); socket.off("data", onData); socket.off("error", onError); callback(value); };
    const onError = (error) => finish(reject, error);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      if (frame.id === id) finish(resolve, frame);
    };
    socket.on("data", onData); socket.once("error", onError);
  });
}

function waitForRpcNotification(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(reject, new Error("TLS RPC notification timed out")), timeoutMs);
    const finish = (callback, value) => { clearTimeout(timer); socket.off("data", onData); socket.off("error", onError); callback(value); };
    const onError = (error) => finish(reject, error);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      if (frame.method === "taric.notification") finish(resolve, frame);
    };
    socket.on("data", onData); socket.once("error", onError);
  });
}

test("gateway fails before opening Core when TLS material cannot be read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-gw-bad-tls-"));
  const configPath = join(directory, "gateway.json");
  await writeFile(configPath, JSON.stringify({
    tls_tcp: { host: "127.0.0.1", port: await freePort() },
    tls: { key_file: "missing-key.pem", cert_file: "missing-cert.pem" },
    tokens: [{ token: hostToken, role: "host", principal_id: "host-gw" }],
  }));
  try { await assert.rejects(startGateway(configPath, {}), /ENOENT/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("gateway removes earlier listeners when a later listener cannot bind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-gw-partial-bind-"));
  const occupied = createServer();
  await new Promise((resolve, reject) => { occupied.once("error", reject); occupied.listen({ host: "127.0.0.1", port: 0 }, resolve); });
  const fixtureDir = join(fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url)));
  await writeFile(join(directory, "key.pem"), await readFile(join(fixtureDir, "gateway-test-key.pem")));
  await writeFile(join(directory, "cert.pem"), await readFile(join(fixtureDir, "gateway-test-cert.pem")));
  const socketPath = join(directory, "gw.sock");
  const configPath = join(directory, "gateway.json");
  const runtimeConfig = join(directory, "runtime.json");
  await writeFile(runtimeConfig, JSON.stringify({ db_path: join(directory, "authority.sqlite"), content_root: join(directory, "content") }));
  await writeFile(configPath, JSON.stringify({
    socket_path: socketPath,
    tls_tcp: { host: "127.0.0.1", port: occupied.address().port },
    tls: { key_file: "key.pem", cert_file: "cert.pem" },
    tokens: [{ token: hostToken, role: "host", principal_id: "host-gw" }],
  }));
  try {
    await assert.rejects(startGateway(configPath, { TARIC_CONFIG: runtimeConfig }), /EADDRINUSE/);
    await assert.rejects(access(socketPath), { code: "ENOENT" });
  } finally {
    await new Promise((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

function httpsJsonRpc(port, token, body, { method = "POST", path = "/rpc", contentType = "application/json", authorized = true } = {}) {
  const fixtureDir = join(fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url)));
  const ca = readFile(join(fixtureDir, "gateway-test-cert.pem"));
  return ca.then((certificate) => new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port, path, method, ca: certificate, headers: { ...(authorized ? { authorization: `Bearer ${token}` } : {}), "content-type": contentType, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => { const text = Buffer.concat(chunks).toString(); let payload; try { payload = JSON.parse(text); } catch { payload = text; } resolve({ status: response.statusCode, headers: response.headers, payload }); });
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  }));
}

test("gateway exposes authenticated TLS TCP and HTTPS without changing Core identity or authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-gw-network-"));
  const dbPath = join(directory, "authority.sqlite");
  const contentRoot = join(directory, "content");
  const store = new AuthorityStore(dbPath);
  const service = await createCoreService(store, contentRoot);
  const initialized = await service.dispatch("engagement.init", createPrincipal("operator", "op-network"), { name: "gw-network", scope: { allowed_targets: ["https://network.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:network" } });
  const engagementId = initialized.data.id;
  const key = await readFile(join(fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url)), "gateway-test-key.pem"));
  const cert = await readFile(join(fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url)), "gateway-test-cert.pem"));
  await writeFile(join(directory, "key.pem"), key, { mode: 0o600 });
  await writeFile(join(directory, "cert.pem"), cert);
  const tcpPort = await freePort();
  const httpsPort = await freePort();
  const configPath = join(directory, "gateway.json");
  await writeFile(configPath, JSON.stringify({
    socket_path: join(directory, "gw.sock"),
    tls_tcp: { host: "127.0.0.1", port: tcpPort },
    https: { host: "127.0.0.1", port: httpsPort },
    tls: { key_file: "key.pem", cert_file: "cert.pem" },
    tokens: [{ token: hostToken, role: "host", principal_id: "host-network", engagement_id: engagementId }],
  }));
  const runtimeConfig = join(directory, "config.json");
  await writeFile(runtimeConfig, JSON.stringify({ db_path: dbPath, content_root: contentRoot, engagement_id: engagementId }));
  let gateway = await startGateway(configPath, { TARIC_CONFIG: runtimeConfig });
  const ca = cert;
  try {
    const tcp = connectTls({ host: "127.0.0.1", port: tcpPort, ca, servername: "localhost" });
    await new Promise((resolve, reject) => { tcp.once("secureConnect", resolve); tcp.once("error", reject); });
    tcp.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "taric.identify", params: { token: hostToken, declare: { role: "host", principal_id: "host-network", engagement_id: engagementId } } })}\n`);
    assert.equal((await waitForRpcLine(tcp, 1)).result.ok, true);
    tcp.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "taric.dispatch", params: { token: hostToken, operation: "engagement.status", request: { engagement_id: engagementId } } })}\n`);
    assert.equal((await waitForRpcLine(tcp, 2)).result.ok, true);
    tcp.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "taric.dispatch", params: { token: reviewerToken, operation: "engagement.status", request: { engagement_id: engagementId } } })}\n`);
    assert.match((await waitForRpcLine(tcp, 3)).error.message, /credential changed/);
    tcp.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "taric.subscribe", params: { token: hostToken, request: { topics: ["delta"], debounce_ms: 20 } } })}\n`);
    assert.equal((await waitForRpcLine(tcp, 4)).result.ok, true);
    const notification = waitForRpcNotification(tcp);
    await store.commit({ id: uuidv7(), engagement_id: engagementId, kind: "claim", proposition: "tls-notification", status: "proposed", evidence_refs: [], limitations: ["gateway fixture"] }, "L2");
    const delivered = await notification;
    assert.equal(delivered.params.engagement_id, engagementId);
    tcp.destroy();
    await store.commit({ id: uuidv7(), engagement_id: engagementId, kind: "claim", proposition: "tls-reconnect", status: "proposed", evidence_refs: [], limitations: ["gateway fixture"] }, "L2");
    const reconnected = connectTls({ host: "127.0.0.1", port: tcpPort, ca, servername: "localhost" });
    await new Promise((resolve, reject) => { reconnected.once("secureConnect", resolve); reconnected.once("error", reject); });
    reconnected.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "taric.identify", params: { token: hostToken, declare: { role: "host", principal_id: "host-network", engagement_id: engagementId } } })}\n`);
    assert.equal((await waitForRpcLine(reconnected, 5)).result.ok, true);
    reconnected.write(`${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "taric.subscribe", params: { token: hostToken, request: { topics: ["delta"], since_read_seq: delivered.params.read_seq, debounce_ms: 20 } } })}\n`);
    assert.equal((await waitForRpcLine(reconnected, 6)).result.ok, true);
    const resumed = await waitForRpcNotification(reconnected);
    assert.ok(resumed.params.read_seq > delivered.params.read_seq, "reconnected TCP subscriber receives a signal newer than its saved watermark");
    reconnected.destroy();
    const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 10, method: "taric.dispatch", params: { operation: "engagement.status", request: { engagement_id: engagementId } } });
    const status = await httpsJsonRpc(httpsPort, hostToken, requestBody);
    assert.equal(status.status, 200); assert.equal(status.payload.result.ok, true);
    const noAuth = await httpsJsonRpc(httpsPort, hostToken, requestBody, { authorized: false });
    assert.equal(noAuth.status, 401); assert.equal(noAuth.payload.error.data.code, "authorization_error");
    const forgedRole = await httpsJsonRpc(httpsPort, hostToken, JSON.stringify({ jsonrpc: "2.0", id: 11, method: "taric.dispatch", params: { operation: "engagement.init", request: { name: "forged", scope: { allowed_targets: [], excluded_targets: [], rules_of_engagement_ref: "roe" } } } }));
    assert.equal(forgedRole.status, 200); assert.equal(forgedRole.payload.result.error.code, "authorization_error");
    const crossEngagement = await httpsJsonRpc(httpsPort, hostToken, JSON.stringify({ jsonrpc: "2.0", id: 12, method: "taric.dispatch", params: { operation: "engagement.status", request: { engagement_id: uuidv7() } } }));
    assert.equal(crossEngagement.payload.result.error.code, "authorization_error");
    const pathIngest = await httpsJsonRpc(httpsPort, hostToken, JSON.stringify({ jsonrpc: "2.0", id: 13, method: "taric.dispatch", params: { operation: "artifact.ingest_file", request: { engagement_id: engagementId, session_id: "remote", path: "/etc/passwd" } } }));
    assert.equal(pathIngest.payload.result.error.code, "unsupported_capability");
    const call = async (id, operation, request) => (await httpsJsonRpc(httpsPort, hostToken, JSON.stringify({ jsonrpc: "2.0", id, method: "taric.dispatch", params: { operation, request } }))).payload.result;
    const sessionId = "remote-api-session";
    assert.equal((await call(30, "artifact.session.bind", { engagement_id: engagementId, session_id: sessionId, root: "/etc", mode: "host-session" })).ok, true);
    const bytes = Buffer.from([0, 1, 255, 128, 42, 13, 10]);
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const begun = await call(31, "artifact.store.begin", { engagement_id: engagementId, session_id: sessionId, payload_kind: "binary", media_type: "application/octet-stream", expected_bytes: bytes.length, expected_hash: contentHash });
    assert.equal(begun.ok, true);
    const appended = await call(32, "artifact.store.append", { engagement_id: engagementId, session_id: sessionId, upload_id: begun.data.upload_id, ordinal: 0, data: bytes.toString("base64"), encoding: "base64", chunk_hash: contentHash });
    assert.equal(appended.ok, true);
    const committed = await call(33, "artifact.store.commit", { engagement_id: engagementId, session_id: sessionId, upload_id: begun.data.upload_id, total_bytes: bytes.length, chunk_count: 1, content_hash: contentHash });
    assert.equal(committed.ok, true);
    const read = await service.dispatch("artifact.content.read", createPrincipal("host", "network-reader", engagementId, ["content_read"]), { engagement_id: engagementId, session_id: sessionId, content_ref: committed.data.content_ref, max_response_bytes: 512 * 1024 });
    assert.deepEqual(Buffer.from(read.data.data, "base64"), bytes);
    const subscribe = await httpsJsonRpc(httpsPort, hostToken, JSON.stringify({ jsonrpc: "2.0", id: 14, method: "taric.subscribe", params: {} }));
    assert.equal(subscribe.payload.result.error.code, "unsupported_capability");
    assert.equal((await httpsJsonRpc(httpsPort, hostToken, "[{}]")).status, 400);
    assert.equal((await httpsJsonRpc(httpsPort, hostToken, JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(129), method: "taric.dispatch", params: { operation: "engagement.status", request: { engagement_id: engagementId } } }))).status, 400);
    assert.equal((await httpsJsonRpc(httpsPort, hostToken, "not-json")).payload.error.code, -32700);
    assert.equal((await httpsJsonRpc(httpsPort, hostToken, requestBody, { contentType: "text/plain" })).status, 415);
    assert.equal((await httpsJsonRpc(httpsPort, hostToken, requestBody, { path: "/other" })).status, 404);
    const oversized = JSON.stringify({ jsonrpc: "2.0", id: 15, method: "taric.dispatch", params: { operation: "engagement.status", request: { engagement_id: engagementId, padding: "x".repeat(1024 * 1024) } } });
    assert.equal((await httpsJsonRpc(httpsPort, hostToken, oversized)).status, 413);

    const plain = connect(tcpPort, "127.0.0.1");
    let plaintextResponse = ""; plain.on("data", (chunk) => { plaintextResponse += chunk.toString(); });
    plain.write(`${JSON.stringify({ jsonrpc: "2.0", id: 20, method: "taric.dispatch", params: { operation: "engagement.status", request: { engagement_id: engagementId } } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.doesNotMatch(plaintextResponse, /"jsonrpc"\s*:\s*"2\.0"/);
    plain.destroy();
    await gateway.close();
    await writeFile(configPath, JSON.stringify({
      socket_path: join(directory, "gw.sock"),
      tls_tcp: { host: "127.0.0.1", port: tcpPort },
      https: { host: "127.0.0.1", port: httpsPort },
      tls: { key_file: "key.pem", cert_file: "cert.pem" },
      tokens: [{ token: rotatedHostToken, role: "host", principal_id: "host-network", engagement_id: engagementId }],
    }));
    gateway = await startGateway(configPath, { TARIC_CONFIG: runtimeConfig });
    assert.equal((await httpsJsonRpc(httpsPort, hostToken, requestBody)).status, 401, "old credential is rejected after restart");
    assert.equal((await httpsJsonRpc(httpsPort, rotatedHostToken, requestBody)).payload.result.ok, true, "new credential works after restart");
  } finally {
    await gateway.close(); await service.close(); await store.close(); await rm(directory, { recursive: true, force: true });
  }
});
