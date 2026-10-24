import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { AuthorityStore, createCoreService, createPrincipal, listenAdapterRpc, resumeContextDelta, uuidv7 } from "../dist/index.js";
import { writeRpcNotification } from "../dist/adapter-rpc.js";

const claim = (engagement_id, index) => ({
  id: uuidv7(), engagement_id, kind: "claim", proposition: `burst-${index}`, status: "proposed", evidence_refs: [], limitations: ["signal fixture"],
});

async function engaged() {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const operator = createPrincipal("operator", "op-a");
  const initialized = await service.dispatch("engagement.init", operator, { name: "signals", scope: { allowed_targets: ["https://signals.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:signals" } });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  return { store, service, engagement_id: initialized.data.id };
}

const waitFor = async (predicate, timeoutMs = 4000) => {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

function fakeClock(startTime) {
  const OriginalDate = globalThis.Date;
  let now = startTime;
  globalThis.Date = class FakeDate extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  return {
    advance(milliseconds) { now += milliseconds; },
    restore() { globalThis.Date = OriginalDate; },
  };
}

test("burst commits merge into at most one signal per debounce window with the latest watermark", async () => {
  const { store, service, engagement_id } = await engaged();
  const host = createPrincipal("host", "host-a", engagement_id);
  const signals = [];
  const subscription = await service.subscribe(host, { engagement_id, topics: ["delta"], debounce_ms: 50 }, (signal) => signals.push(signal));
  try {
    for (let index = 0; index < 1000; index += 1) (await store.commit(claim(engagement_id, index), "L2"));
    assert.ok(await waitFor(() => signals.length > 0), "no delta signal arrived");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 每个去抖窗口至多一个信号；水位单调；最后信号水位 = 权威头。
    for (let index = 1; index < signals.length; index += 1) {
      assert.ok(Date.parse(signals[index].emitted_at) - Date.parse(signals[index - 1].emitted_at) >= 30, `signals too dense: ${signals.length}`);
    }
    for (const signal of signals) {
      assert.equal(signal.topic, "delta");
      assert.equal(signal.engagement_id, engagement_id);
    }
    const head = await new Promise((resolve) => { void store.maintenanceRead((watermarks) => resolve(watermarks.committed_seq)); });
    assert.equal(signals.at(-1).read_seq, head);
    // 零信息损失：以最后信号水位为锚，之后的提交由 delta 恢复路径完整补齐。
    const anchored = signals.at(-1).read_seq;
    for (let index = 0; index < 8; index += 1) (await store.commit(claim(engagement_id, `tail-${index}`), "L2"));
    const caughtUp = await resumeContextDelta(store, engagement_id, anchored);
    assert.ok(caughtUp.added.length >= 8, `resume after last signal returned ${caughtUp.added.length}`);
  } finally { subscription.unsubscribe(); await service.close(); }
});

test("model principals and foreign engagements cannot subscribe; revoked authorization silently stops delivery", async () => {
  const { store, service, engagement_id } = await engaged();
  const model = createPrincipal("model", "model-a", engagement_id);
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    const codeIs = (expected) => (error) => error.code === expected;
    await assert.rejects(service.subscribe(model, { engagement_id }, () => {}), codeIs("authorization_error"));
    await assert.rejects(service.subscribe(host, { engagement_id: uuidv7() }, () => {}), codeIs("authorization_error"));
    await assert.rejects(service.subscribe(host, { engagement_id, topics: ["unknown"] }, () => {}), codeIs("validation_error"));
    await assert.rejects(service.subscribe(host, { engagement_id, topics: ["l1_backlog"] }, () => {}), codeIs("validation_error"));
    await assert.rejects(service.subscribe(host, { engagement_id, topics: ["l1_backlog"], l1_backlog_threshold: 0 }, () => {}), codeIs("validation_error"));

    const received = [];
    const subscription = await service.subscribe(host, { engagement_id, topics: ["delta"], debounce_ms: 30 }, (signal) => received.push(signal));
    (await store.commit(claim(engagement_id, "pre"), "L2"));
    assert.ok(await waitFor(() => received.length > 0), "pre-revocation signal missing");
    const receivedAtRevocation = received.length;
    // 模拟权限失效：principal 与 Engagement 绑定不再匹配 → 投递期重鉴权失败 → 静默退订。
    host.engagement_id = uuidv7();
    for (let index = 0; index < 5; index += 1) (await store.commit(claim(engagement_id, `post-${index}`), "L2"));
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(received.length, receivedAtRevocation, "signals continued after revocation");
    subscription.unsubscribe();
    // 信号永不进入审计正文。
    const events = await store.events();
    assert.ok(events.every((event) => !/signal|notification/.test(event.event_type)), "signal-like audit events found");
    assert.ok(JSON.stringify(events).indexOf("taric.notification") === -1);
  } finally { await service.close(); }
});

test("l1 backlog signals only host-threshold crossings, not unrelated commits", async () => {
  const { store, service, engagement_id } = await engaged();
  const host = createPrincipal("host", "host-a", engagement_id);
  const signals = [];
  const subscription = await service.subscribe(host, { engagement_id, topics: ["l1_backlog"], l1_backlog_threshold: 2, debounce_ms: 20 }, (signal) => signals.push(signal));
  try {
    const first = claim(engagement_id, "l1-first");
    const second = claim(engagement_id, "l1-second");
    await store.commit(first, "L1");
    await store.commit(claim(engagement_id, "unrelated-one"), "L2");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(signals.length, 0, "below-threshold L1 backlog emitted a hint");

    await store.commit(second, "L1");
    assert.ok(await waitFor(() => signals.length === 1), "threshold crossing did not emit");
    await store.commit(claim(engagement_id, "unrelated-two"), "L2");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(signals.length, 1, "continuously true L1 topic repeated on an unrelated commit");

    const currentFirst = await store.get(first.id);
    await store.commit({ ...currentFirst, trust_level: undefined }, "L2", undefined, undefined, true, currentFirst.version);
    assert.ok(await waitFor(() => signals.length === 2), "crossing back below threshold did not emit");
    assert.deepEqual(signals.map((signal) => signal.topic), ["l1_backlog", "l1_backlog"]);
  } finally { subscription.unsubscribe(); await service.close(); }
});

test("subscription registration rechecks the caller watermark and emits a delta hint for the race", async () => {
  const { store, service, engagement_id } = await engaged();
  const host = createPrincipal("host", "host-a", engagement_id);
  const before = await store.maintenanceRead((watermarks) => watermarks.read_seq);
  const originalDataVersion = store.dataVersion.bind(store);
  let injected = false;
  store.dataVersion = async () => {
    const version = await originalDataVersion();
    if (!injected) {
      injected = true;
      await store.commit(claim(engagement_id, "registration-race"), "L2");
    }
    return version;
  };
  const signals = [];
  try {
    const subscription = await service.subscribe(host, { engagement_id, since_read_seq: before, topics: ["delta"], debounce_ms: 20 }, (signal) => signals.push(signal));
    assert.ok(await waitFor(() => signals.length === 1), "registration race was not exposed");
    assert.equal(signals[0].topic, "delta");
    assert.ok(signals[0].read_seq > before);
    subscription.unsubscribe();
  } finally {
    store.dataVersion = originalDataVersion;
    await service.close();
  }
});

test("lease threshold wakes without a database commit", async () => {
  const { store, service, engagement_id } = await engaged();
  const host = createPrincipal("host", "host-a", engagement_id);
  const item = { id: uuidv7(), engagement_id, kind: "work_item", title: "lease timer", status: "queued", acceptance_criteria: ["observe expiry"] };
  const signals = [];
  let subscription;
  let clock;
  try {
    await store.commit(item, "L2");
    const run = await store.claimWorkRun({ work_item_id: item.id, engagement_id, host_id: host.id, agent_id: "worker-a", ttl_ms: 31_000 });
    clock = fakeClock(Date.parse(run.lease_expires_at) - 31_000);
    const readSeq = await store.maintenanceRead((watermarks) => watermarks.read_seq);
    subscription = await service.subscribe(host, { engagement_id, topics: ["lease_expiry"], debounce_ms: 20 }, (signal) => signals.push(signal));
    assert.equal(signals.length, 0);

    clock.advance(2_000);
    assert.ok(await waitFor(() => signals.length === 1), "lease threshold did not wake without a commit");
    assert.equal(signals[0].topic, "lease_expiry");
    assert.equal(signals[0].read_seq, readSeq);

    clock.advance(30_000);
    assert.ok(await waitFor(() => signals.length === 2), "lease expiry edge did not wake without a commit");
    assert.deepEqual(signals.map((signal) => signal.topic), ["lease_expiry", "lease_expiry"]);
    assert.equal(await store.maintenanceRead((watermarks) => watermarks.read_seq), readSeq, "test unexpectedly committed during timer checks");
  } finally {
    subscription?.unsubscribe();
    clock?.restore();
    await service.close();
  }
});

test("RPC notification writes wait for drain and disconnect at the byte bound", async () => {
  class FakeSocket extends EventEmitter {
    writableLength = 0;
    destroyed = false;
    writes = [];
    write(line) { this.writes.push(line); this.writableLength += Buffer.byteLength(line, "utf8"); return false; }
    destroy() { this.destroyed = true; this.emit("close"); }
    drain() { this.writableLength = 0; this.emit("drain"); }
  }
  const socket = new FakeSocket();
  const signal = { topic: "delta", engagement_id: uuidv7(), read_seq: 42, emitted_at: new Date().toISOString() };
  writeRpcNotification(socket, signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.length, 1);
  assert.equal(socket.listenerCount("drain"), 1, "backpressured write did not wait for drain");
  socket.drain();
  assert.equal(socket.listenerCount("drain"), 0);

  socket.writableLength = 64 * 1024 - 1;
  writeRpcNotification(socket, signal);
  assert.equal(socket.destroyed, true, "slow consumer exceeded the byte bound without disconnect");
  assert.equal(socket.writes.length, 1, "overflow notification was added to the queue");
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

test("RPC subscription frame delivers content-free notifications; unsubscribe is per-connection; reconnect resumes losslessly", async () => {
  const { store, service, engagement_id } = await engaged();
  const token = "subscription-test-token-0123456789abcdef";
  const directory = await mkdtemp(join(tmpdir(), "taric-sub-rpc-"));
  const socketPath = join(directory, "sub.sock");
  const listener = await listenAdapterRpc(service, {
    socket_path: socketPath, token,
    principal: createPrincipal("host", "rpc-host", engagement_id),
  });
  const quiet = rpcClient(socketPath);
  try {
    // 未订阅连接：纯请求-响应，行为与帧引入之前一致。
    quiet.send({ jsonrpc: "2.0", id: 1, method: "taric.dispatch", params: { token, operation: "engagement.status", request: { engagement_id } } });
    const status = await quiet.waitForLine((line) => line.includes('"id":1'));
    assert.equal(status.result.ok, true, JSON.stringify(status));
    // 非法 token 的订阅请求被拒。
    const badToken = rpcClient(socketPath);
    badToken.send({ jsonrpc: "2.0", id: 7, method: "taric.subscribe", params: { token: "wrong-token", request: {} } });
    const rejected = await badToken.waitForLine((line) => line.includes('"id":7'));
    assert.equal(rejected.error !== undefined || rejected.result?.ok === false, true);
    badToken.socket.destroy();

    // 连接 A 订阅；连接 B 无关。
    const a = rpcClient(socketPath);
    const b = rpcClient(socketPath);
    a.send({ jsonrpc: "2.0", id: 10, method: "taric.subscribe", params: { token, request: { topics: ["delta"], debounce_ms: 40 } } });
    const subscribed = await a.waitForLine((line) => line.includes('"id":10'));
    assert.equal(subscribed.result.ok, true, JSON.stringify(subscribed));

    for (let index = 0; index < 5; index += 1) (await store.commit(claim(engagement_id, `rpc-${index}`), "L2"));
    const notification = await a.waitForLine((line) => line.includes("taric.notification"));
    assert.equal(notification.params.topic, "delta");
    assert.equal(notification.params.engagement_id, engagement_id);
    assert.ok(Number.isInteger(notification.params.read_seq));
    assert.ok(!("content" in notification.params) && !("records" in notification.params), "notification carries content");

    // B 的退订只作用于 B；A 继续接收。
    b.send({ jsonrpc: "2.0", id: 11, method: "taric.unsubscribe", params: { token } });
    await b.waitForLine((line) => line.includes('"id":11'));
    for (let index = 0; index < 3; index += 1) (await store.commit(claim(engagement_id, `after-b-${index}`), "L2"));
    await a.waitForLine((line) => line.includes("taric.notification") && Number.isInteger(Number(JSON.parse(line).params.read_seq)));
    const aLines = a.lines.map((line) => JSON.parse(line));
    const lastWatermark = Math.max(...aLines.filter((line) => line.method === "taric.notification").map((line) => line.params.read_seq));

    // 杀连接 → 断连期间提交 → 重连订阅 → 从最后水位恢复，零遗漏。
    a.socket.destroy();
    for (let index = 0; index < 4; index += 1) (await store.commit(claim(engagement_id, `offline-${index}`), "L2"));
    const resumedWhileAway = await resumeContextDelta(store, engagement_id, lastWatermark);
    assert.ok(resumedWhileAway.added.length >= 4, `resume missed changes: ${resumedWhileAway.added.length}`);
    const reconnected = rpcClient(socketPath);
    reconnected.send({ jsonrpc: "2.0", id: 12, method: "taric.subscribe", params: { token, request: { topics: ["delta"], debounce_ms: 40 } } });
    await reconnected.waitForLine((line) => line.includes('"id":12'));
    (await store.commit(claim(engagement_id, "after-reconnect"), "L2"));
    await reconnected.waitForLine((line) => line.includes("taric.notification"));
    reconnected.socket.destroy();
    quiet.socket.destroy();
  } finally {
    quiet.socket.destroy();
    await listener.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
