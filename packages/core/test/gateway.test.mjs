import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, listenAdapterRpc, uuidv7 } from "../dist/index.js";

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
  const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
  const waitForLine = async (match, timeoutMs = 4000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = lines.find(match);
      if (found !== undefined) return JSON.parse(found);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`expected RPC line not received; got: ${lines.join(" || ")}`);
  };
  return { socket, lines, send, waitForLine };
}

test("one gateway listener serves host and reviewer tokens concurrently with frozen identities", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const operator = createPrincipal("operator", "op-a");
  const initialized = await service.dispatch("engagement.init", operator, { name: "gateway", scope: { allowed_targets: ["https://gw.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:gw" } });
  const engagement_id = initialized.data.id;

  const directory = await mkdtemp(join(tmpdir(), "taric-gw-"));
  const socketPath = join(directory, "gw.sock");
  const hostToken = "host-token-0123456789abcdef0123456789abcdef";
  const reviewerToken = "reviewer-token-0123456789abcdef01234567";
  const reviewer = createPrincipal("reviewer", "reviewer-gw", engagement_id, [], { capability: "human" });
  const table = new Map([
    [hostToken, createPrincipal("host", "host-gw", engagement_id)],
    [reviewerToken, reviewer],
  ]);
  const listener = await listenAdapterRpc(service, {
    socket_path: socketPath,
    token: "listener-frame-token-0123456789abcdef",
    resolvePrincipal: (declared, token) => {
      const entry = table.get(token);
      if (!entry) throw new Error("unknown token");
      if (declared.role !== entry.role || declared.principal_id !== entry.id || (declared.engagement_id ?? undefined) !== (entry.engagement_id ?? undefined)) throw new Error("mismatch");
      return entry;
    },
  });
  try {
    // 未识别先 dispatch：拒绝。
    const eager = rpcClient(socketPath);
    eager.send({ jsonrpc: "2.0", id: 1, method: "taric.dispatch", params: { token: hostToken, operation: "engagement.status", request: { engagement_id } } });
    const rejectedEarly = await eager.waitForLine((line) => line.includes('"id":1'));
    assert.match(rejectedEarly.error.message, /identify before dispatch/);
    eager.socket.destroy();

    // host 身份识别 + 读状态成功。
    const hostClient = rpcClient(socketPath);
    hostClient.send({ jsonrpc: "2.0", id: 2, method: "taric.identify", params: { token: hostToken, declare: { role: "host", principal_id: "host-gw", engagement_id } } });
    const identifiedHost = await hostClient.waitForLine((line) => line.includes('"id":2'));
    assert.equal(identifiedHost.result.ok, true, JSON.stringify(identifiedHost));
    hostClient.send({ jsonrpc: "2.0", id: 3, method: "taric.dispatch", params: { token: hostToken, operation: "engagement.status", request: { engagement_id } } });
    const hostStatus = await hostClient.waitForLine((line) => line.includes('"id":3'));
    assert.equal(hostStatus.result.ok, true, JSON.stringify(hostStatus));

    // 身份冻结：二次 identify 拒绝。
    hostClient.send({ jsonrpc: "2.0", id: 4, method: "taric.identify", params: { token: hostToken, declare: { role: "host", principal_id: "host-gw", engagement_id } } });
    const refrozen = await hostClient.waitForLine((line) => line.includes('"id":4'));
    assert.match(refrozen.error.message, /frozen/);

    // reviewer 身份：host 角色调不了 review.submit；reviewer token 可以。
    const model = createPrincipal("model", "model-gw", engagement_id);
    const proposed = await service.dispatch("proposal.submit", model, {
      engagement_id, subject_type: "claim", expected_version: 0,
      content: { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "gw claim", status: "proposed", evidence_refs: [], limitations: ["gw fixture"], provenance: { host_id: "pi", producer_id: "model-gw", source_kind: "model" } },
    });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    const policyDigest = (await import("../dist/index.js")).policyDigest();

    hostClient.send({ jsonrpc: "2.0", id: 5, method: "taric.dispatch", params: { token: hostToken, operation: "review.submit", request: { engagement_id, proposal_id: proposed.data.id, reviewer_id: "host-gw", reviewer_kind: "reviewer", input_hash: proposed.data.content_hash, verdict: "pass", policy_digest: policyDigest, limitations: ["must be rejected: wrong role"] } } });
    const hostReview = await hostClient.waitForLine((line) => line.includes('"id":5'));
    assert.equal(hostReview.result.ok, false);
    assert.equal(hostReview.result.error.code, "authorization_error");

    const reviewerClient = rpcClient(socketPath);
    reviewerClient.send({ jsonrpc: "2.0", id: 6, method: "taric.identify", params: { token: reviewerToken, declare: { role: "reviewer", principal_id: "reviewer-gw", engagement_id } } });
    await reviewerClient.waitForLine((line) => line.includes('"id":6'));
    reviewerClient.send({ jsonrpc: "2.0", id: 7, method: "taric.dispatch", params: { token: reviewerToken, operation: "review.submit", request: { engagement_id, proposal_id: proposed.data.id, reviewer_id: "reviewer-gw", reviewer_kind: "reviewer", input_hash: proposed.data.content_hash, verdict: "pass", policy_digest: policyDigest, limitations: ["gateway reviewer fixture"] } } });
    const reviewAccepted = await reviewerClient.waitForLine((line) => line.includes('"id":7'));
    assert.equal(reviewAccepted.result.ok, true, JSON.stringify(reviewAccepted));

    // 伪造声明：token 表外的角色/身份组合全部拒绝且不注册身份。
    const forged = rpcClient(socketPath);
    forged.send({ jsonrpc: "2.0", id: 8, method: "taric.identify", params: { token: "unknown-token-0123456789abcdef0123456789abc", declare: { role: "operator", principal_id: "op-forged" } } });
    const forgedIdentify = await forged.waitForLine((line) => line.includes('"id":8'));
    assert.match(forgedIdentify.error.message, /authorization/);
    forged.send({ jsonrpc: "2.0", id: 9, method: "taric.dispatch", params: { token: hostToken, operation: "engagement.status", request: { engagement_id } } });
    const forgedDispatch = await forged.waitForLine((line) => line.includes('"id":9'));
    assert.match(forgedDispatch.error.message, /identify before dispatch/);

    hostClient.socket.destroy();
    reviewerClient.socket.destroy();
    forged.socket.destroy();
  } finally {
    await listener.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolver-less listeners stay single-principal and reject identity frames", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const operator = createPrincipal("operator", "op-a");
  const initialized = await service.dispatch("engagement.init", operator, { name: "single", scope: { allowed_targets: ["https://s.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:s" } });
  const engagement_id = initialized.data.id;
  const directory = await mkdtemp(join(tmpdir(), "taric-gw-single-"));
  const socketPath = join(directory, "single.sock");
  const listener = await listenAdapterRpc(service, {
    socket_path: socketPath,
    token: "single-token-0123456789abcdef0123456789abcd",
    principal: createPrincipal("host", "single-host", engagement_id),
  });
  try {
    const client = rpcClient(socketPath);
    // identify 帧在单 principal listener 上被拒绝。
    client.send({ jsonrpc: "2.0", id: 1, method: "taric.identify", params: { token: "single-token-0123456789abcdef0123456789abcd", declare: { role: "operator", principal_id: "op-x" } } });
    const identifyRejected = await client.waitForLine((line) => line.includes('"id":1'));
    assert.match(identifyRejected.error.message, /does not accept identity frames/);
    // 既有 dispatch 行为不变。
    client.send({ jsonrpc: "2.0", id: 2, method: "taric.dispatch", params: { token: "single-token-0123456789abcdef0123456789abcd", operation: "engagement.status", request: { engagement_id } } });
    const status = await client.waitForLine((line) => line.includes('"id":2'));
    assert.equal(status.result.ok, true, JSON.stringify(status));
    client.socket.destroy();
  } finally {
    await listener.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
