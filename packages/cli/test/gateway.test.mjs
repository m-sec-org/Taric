import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrincipal, createCoreService, AuthorityStore, uuidv7 } from "@taric/core";
import { parseGatewayConfig, gatewayResolver, startGateway } from "../dist/gateway.js";

const hostToken = "host-token-0123456789abcdef0123456789abcdef";
const reviewerToken = "reviewer-token-0123456789abcdef01234567";

test("gateway config validation rejects malformed tables", () => {
  assert.ok(parseGatewayConfig(JSON.stringify({ socket_path: "/tmp/g.sock", tokens: [{ token: hostToken, role: "host", principal_id: "h" }] })));
  for (const bad of [
    { socket_path: "", tokens: [] },
    { socket_path: "/tmp/g.sock", tokens: [{ token: "short", role: "host", principal_id: "h" }] },
    { socket_path: "/tmp/g.sock", tokens: [{ token: hostToken, role: "superuser", principal_id: "h" }] },
    { socket_path: "/tmp/g.sock", tokens: [{ token: hostToken, role: "host" }] },
    { socket_path: "/tmp/g.sock", tokens: [{ token: hostToken, role: "host", principal_id: "h" }, { token: hostToken, role: "host", principal_id: "h2" }] },
  ]) assert.throws(() => parseGatewayConfig(JSON.stringify(bad)));
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
