import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_PI_HOST,
  createCoreService,
  createDeepSeekHarnessAdapter,
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

test("Pi extension registers real lifecycle callbacks through the authenticated Core client", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
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
  assert.equal(extension.handlers.has("agent_before_settle"), false);
  const context = await extension.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "inspect", systemPrompt: "system" });
  assert.equal(context.message.customType, "taric-context");
  assert.equal(context.message.display, false);
  assert.ok(JSON.parse(context.message.content).context_snapshot_id);
  const transformed = await extension.handlers.get("context")({ type: "context", messages: [] });
  assert.equal(transformed.messages.length, 1);
  assert.equal(transformed.messages[0].customType, "taric-context");

  // 同一实例重复注册（等价于 /reload 幂等）不产生第二次注册。
  const reload = await pi(extension);
  assert.equal(reload.callbacks.length, 0);
  assert.equal(reload.reload_idempotent, true);
  store.close();
});

test("Pi lifecycle callbacks reject cross-engagement and forged host attribution", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
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
  store.close();
});

test("Pi extension requires a host principal bound to an engagement", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const extension = fakePiExtensionApi();
  const pi = createPiAdapter(service, createPrincipal("model", "model-a", uuidv7()));
  await assert.rejects(() => pi.register(extension), /authorization_error/);
  assert.equal(extension.handlers.size, 0);
  store.close();
});

test("DeepSeek adapter has no Pi lifecycle surface", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const dsh = createDeepSeekHarnessAdapter(service, createPrincipal("host", "dsh", uuidv7()), "1.0");
  const extension = fakePiExtensionApi();
  await assert.rejects(() => dsh.register(extension), /unsupported_capability/);
  assert.equal(extension.handlers.size, 0);
  store.close();
});
