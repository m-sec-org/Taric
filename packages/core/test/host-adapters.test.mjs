import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_PI_HOST,
  createCoreService,
  createDeepSeekHarnessAdapter,
  deepSeekHooks,
  createPiAdapter,
  createPiExtension,
  createPrincipal,
  uuidv7,
} from "../dist/index.js";
import { AuthorityStore } from "../dist/store.js";

/** 最小 Pi ExtensionAPI 契约测试替身：只要求 on(event, handler)。 */
function fakePiExtensionApi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
  };
}

function richPiExtensionApi() {
  const handlers = new Map();
  const tools = new Map();
  return {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    async emit(event, payload) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload));
      return results;
    },
  };
}

test("Pi extension registers real lifecycle callbacks through the authenticated Core client", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const hostPrincipal = createPrincipal("host", "pi-host", engagement_id);
  const pi = createPiExtension(service, hostPrincipal);
  const extension = fakePiExtensionApi();
  const loaded = await pi(extension);
  assert.equal(loaded.loaded, true);
  assert.deepEqual(loaded.callbacks, ["session_start", "context"]);
  assert.equal(loaded.adapter.host_version, SUPPORTED_PI_HOST.version);
  assert.equal(loaded.adapter.host_commit, SUPPORTED_PI_HOST.host_commit);
  assert.equal(typeof extension.handlers.get("session_start"), "function");
  assert.equal(typeof extension.handlers.get("before_agent_start"), "function");
  assert.equal(typeof extension.handlers.get("agent_before_settle"), "function");
  // Pi v1.2.0 起 before_agent_start 按 messageType 区分："user" 携带 prompt，
  // "custom"（pi.sendMessage triggerTurn）携带 message 且无 prompt。
  // 两种触发都必须注入同一 Taric Context Pack；handler 不读 prompt。
  const userStart = await extension.handlers.get("before_agent_start")({ type: "before_agent_start", messageType: "user", prompt: "inspect", systemPrompt: "system" });
  assert.equal(userStart.message.customType, "taric-context");
  assert.equal(userStart.message.display, false);
  assert.ok(JSON.parse(userStart.message.content).context_snapshot_id);
  const customStart = await extension.handlers.get("before_agent_start")({ type: "before_agent_start", messageType: "custom", message: { role: "user", customType: "follow_up", content: "continue" } });
  assert.equal(customStart.message.customType, "taric-context");
  assert.ok(JSON.parse(customStart.message.content).context_snapshot_id);
  const transformed = await extension.handlers.get("context")({ type: "context", messages: [] });
  assert.equal(transformed.messages.length, 1);
  assert.equal(transformed.messages[0].customType, "taric-context");

  // 同一实例重复注册（等价于 /reload 幂等）不产生第二次注册。
  const reload = await pi(extension);
  assert.equal(reload.callbacks.length, 0);
  assert.equal(reload.reload_idempotent, true);
  (await store.close());
});

test("Pi lifecycle callbacks reject cross-engagement and forged host attribution", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const other_engagement = uuidv7();
  const pi = createPiAdapter(service, createPrincipal("host", "pi-host", engagement_id));
  const extension = fakePiExtensionApi();
  await pi.register(extension);

  const forged = await extension.handlers.get("context")({ context: { engagement_id, host_id: "hermes" } });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, "authorization_error");

  const cross = await extension.handlers.get("context")({ context: { engagement_id: other_engagement, host_id: "pi" } });
  assert.equal(cross.ok, false);
  assert.equal(cross.error.code, "authorization_error");
  (await store.close());
});

test("Pi 1.4 hooks use explicit host bindings for proposal, checkpoint, and action result paths", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const work_item_id = uuidv7();
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["evidence"] }, "L2"));
  const host = createPrincipal("host", "pi-host", engagement_id);
  const run = (await store.claimWorkRun({ work_item_id, engagement_id, host_id: host.id, agent_id: "agent-a" }));
  const action_id = uuidv7();
  (await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", target: "/admin", method: "bash", host_id: host.id }));
  (await store.recordActionIntent({ action_id, run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "authorized", host_decision_ref: "decision:1", host_id: host.id }));
  const pi = createPiAdapter(service, host);
  const extension = richPiExtensionApi();
  const loaded = await pi.register(extension, {
    work_run_id: run.run_id,
    generation: run.generation,
    agent_id: "agent-a",
    checkpoint: () => ({
      work_item_ref: work_item_id,
      work_run_ref: run.run_id,
      attempt_ref: run.attempt_ref,
      generation: run.generation,
      target_version: run.target_version,
      work_item_version: run.work_item_version,
      scope_version: run.scope_version,
      owner: run.owner,
      lease_expires_at: run.lease_expires_at,
      source_read_seq: run.read_seq,
      completed_steps: ["inventory"],
      next_steps: ["verify"],
      observation_refs: [],
      evidence_refs: [],
      negative_results: [],
      unresolved_work: [],
      host_decision_refs: ["decision:1"],
      external_action_state: "none",
      budget: { actions: 1 },
      draft_refs: [],
      handoff_refs: [],
      action_refs: [action_id],
      tool_result_refs: [],
      context_manifest: { context_snapshot_id: uuidv7(), read_seq: run.read_seq, builder_version: "pi-test" },
    }),
    resultForTool: () => ({ action_id, mode: "host_hitl", status: "executed", result_ref: "result:1", host_decision_ref: "decision:1" }),
  });
  assert.deepEqual(loaded.callbacks, ["session_start", "context"]);
  assert.ok(loaded.hooks.includes("agent_before_settle"));
  assert.ok(loaded.hooks.includes("tool_result"));
  assert.ok(loaded.hooks.includes("registerTool:taric_proposal"));
  assert.ok(loaded.available_capabilities.includes("proposal_submission"));
  assert.ok(loaded.available_capabilities.includes("checkpoint"));
  assert.ok(loaded.available_capabilities.includes("host_result"));
  assert.equal(typeof extension.tools.get("taric_proposal")?.execute, "function");

  const proposal = await extension.tools.get("taric_proposal").execute("call-1", {
    subject_type: "claim",
    expected_version: 0,
    content: { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "host callback", status: "proposed", evidence_refs: [], limitations: [] },
  });
  assert.equal(proposal.details.ok, true);
  const checkpoint = (await extension.emit("agent_before_settle", { type: "agent_before_settle", outcome: "completed" })).at(-1);
  assert.equal(checkpoint.ok, true);
  assert.equal((await store.getWorkRun(run.run_id)).checkpoint_id !== undefined, true);
  const result = (await extension.emit("tool_result", { type: "tool_result", toolName: "bash", toolCallId: "tool-1", isError: false })).at(-1);
  assert.equal(result.ok, true);
  assert.equal((await store.getActionIntent(action_id)).status, "executed");
  (await store.close());
});

test("resume packet reports conservative premise checks and stale checkpoint attempt", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const work_item_id = uuidv7();
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["evidence"] }, "L2"));
  // 300ms 租约 + 350ms 强制过期：语义不变（checkpoint 在有效期内、reclaim 在过期后），
  // 但给负载下的调度抖动留余量（原 50ms 在并发套件中偶发过期）。
  const first = (await store.claimWorkRun({ work_item_id, engagement_id, host_id: "pi-a", agent_id: "agent-a", ttl_ms: 300 }));
  const checkpoint = {
    work_item_ref: work_item_id,
    work_run_ref: first.run_id,
    attempt_ref: first.attempt_ref,
    generation: first.generation,
    target_version: first.target_version,
    work_item_version: first.work_item_version,
    scope_version: first.scope_version,
    owner: first.owner,
    lease_expires_at: first.lease_expires_at,
    source_read_seq: first.read_seq,
    completed_steps: [],
    next_steps: ["verify"],
    observation_refs: [],
    evidence_refs: [],
    negative_results: [],
    unresolved_work: [],
    host_decision_refs: [],
    external_action_state: "none",
    budget: { actions: 0 },
    draft_refs: [],
    handoff_refs: [],
    action_refs: [],
    tool_result_refs: [],
    context_manifest: { context_snapshot_id: uuidv7(), read_seq: first.read_seq, builder_version: "test" },
  };
  (await store.commitCheckpoint(first.run_id, first.generation, "pi-a", checkpoint));
  await new Promise((resolve) => setTimeout(resolve, 350));
  const second = (await store.reclaimWorkRun(first.run_id, "pi-b", "agent-b"));
  const packet = (await store.resumePacket(second.run_id, "pi-b"));
  assert.equal(packet.checkpoint_read_seq, first.read_seq);
  assert.equal(packet.premise_checks.attempt, false);
  assert.equal(packet.blocked, true);
  assert.equal(packet.replan_required, true);
  assert.equal(packet.resume_advice, "replan_required");
  (await store.close());
});

test("Pi extension requires a host principal bound to an engagement", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const extension = fakePiExtensionApi();
  const pi = createPiAdapter(service, createPrincipal("model", "model-a", uuidv7()));
  await assert.rejects(async () => (await pi.register(extension)), /authorization_error/);
  assert.equal(extension.handlers.size, 0);
  (await store.close());
});

test("DeepSeek adapter has no Pi lifecycle surface", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const dsh = createDeepSeekHarnessAdapter(service, createPrincipal("host", "dsh", uuidv7()), "1.0");
  const extension = fakePiExtensionApi();
  await assert.rejects(async () => (await dsh.register(extension)), /unsupported_capability/);
  assert.equal(extension.handlers.size, 0);
  (await store.close());
});

test("DeepSeek Cordis adapter binds authenticated callbacks and memoizes duplicate events", async () => {
  const store = new AuthorityStore(); const service = (await createCoreService(store)); const engagement_id = uuidv7();
  const adapter = createDeepSeekHarnessAdapter(service, createPrincipal("host", "dsh-host", engagement_id));
  const listeners = new Map(); const ctx = { on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); } };
  const loaded = await adapter.register(ctx, { engagement_id });
  assert.deepEqual(loaded.hooks, [...deepSeekHooks]);
  assert.equal((await listeners.get("session/created")({ id: "session-1" })).ok, true);
  const sessionEvent = { id: "same", type: "turn/start" };
  const first = listeners.get("session/event")({ id: "session-1" }, sessionEvent);
  const duplicate = listeners.get("session/event")({ id: "session-1" }, sessionEvent);
  assert.equal(first, duplicate);
  assert.deepEqual(await first, { observed: true, type: "turn/start" });
  adapter.unload(); assert.equal(listeners.size, 0); (await store.close());
});

test("same-major uncertified Pi version runs the read-only safe subset without authority writes", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const work_item_id = uuidv7();
  (await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "verify", status: "queued", acceptance_criteria: ["evidence"] }, "L2"));
  const host = createPrincipal("host", "pi-host", engagement_id);
  const run = (await store.claimWorkRun({ work_item_id, engagement_id, host_id: host.id, agent_id: "agent-a" }));
  // 未认证的同 major 版本：register 允许，能力收敛到只读安全子集。
  const pi = createPiAdapter(service, host, "1.5.0");
  assert.equal(pi.descriptor.certification_state, "not_certified");
  const extension = richPiExtensionApi();
  const loaded = await pi.register(extension, {
    work_run_id: run.run_id,
    generation: run.generation,
    agent_id: "agent-a",
    checkpoint: () => ({ work_item_ref: work_item_id, completed_steps: [], next_steps: [], observation_refs: [], evidence_refs: [], negative_results: [], unresolved_work: [], host_decision_refs: [], external_action_state: "none", budget: { actions: 1 }, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [], context_manifest: { context_snapshot_id: uuidv7(), read_seq: run.read_seq, builder_version: "pi-test" } }),
    resultForTool: () => ({ action_id: uuidv7(), mode: "host_hitl", status: "executed", result_ref: "result:1" }),
  });
  assert.deepEqual(loaded.available_capabilities, ["session_lifecycle", "context_injection"]);
  assert.ok(!extension.tools.has("taric_proposal"), "proposal tool must not register for an uncertified version");
  const status = pi.status();
  assert.equal(status.certification_state, "not_certified");
  assert.equal(status.supported, false);
  assert.equal(status.evidence_state, "pending");
  assert.deepEqual(status.capabilities, ["session_lifecycle", "context_injection"]);
  assert.equal(status.capability_status.proposal_submission.reason, "capability requires a certified host version");
  // 只读上下文注入仍工作；权威写入 hook（checkpoint/tool_result 错误上报）静默 no-op。
  const injected = await extension.handlers.get("before_agent_start")[0]({ type: "before_agent_start", messageType: "user", prompt: "inspect" });
  assert.ok(JSON.parse(injected.message.content).context_snapshot_id);
  const beforeSettle = await extension.emit("agent_before_settle", { outcome: "ok" });
  assert.deepEqual(beforeSettle, [undefined]);
  const toolFailure = await extension.emit("tool_result", { toolCallId: "t1", toolName: "bash", isError: true });
  assert.deepEqual(toolFailure, [undefined]);
  const events = await store.events();
  assert.ok(events.every((event) => event.event_type !== "host.error"), "uncertified versions must not write error reports");
  // 更远版本：register 直接拒绝。
  const far = createPiAdapter(service, createPrincipal("host", "pi-host-2", engagement_id), "0.74.2");
  await assert.rejects(async () => far.register(richPiExtensionApi()), /unsupported_capability/);
  assert.equal(far.status().certification_state, "unsupported");
  (await store.close());
});
