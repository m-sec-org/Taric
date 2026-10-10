import test from "node:test";
import assert from "node:assert/strict";
import {
  API_CONTRACT_VERSION,
  TaricAdapterClient,
  createCoreService,
  createDeepSeekHarnessAdapter,
  createHermesAdapter,
  createPiAdapter,
  createPiDescriptor,
  createPrincipal,
  isSupportedPiVersion,
  uuidv7,
  validateAdapter,
} from "../dist/index.js";
import { AuthorityStore } from "../dist/store.js";

const base = { contract_version: "1.0", api_contract_version: API_CONTRACT_VERSION, capabilities: [], supported: false };

test("adapter contract rejects unsupported versions, capabilities and API mismatch", () => {
  assert.equal(validateAdapter({ host_id: "pi", version: "1.1.0", ...base, contract_version: "9.0" }).accepted, false);
  assert.equal(validateAdapter({ host_id: "pi", version: "1.1.0", ...base, api_contract_version: "9.0.0" }).accepted, false);
  assert.equal(validateAdapter({ host_id: "pi", version: "1.1.0", ...base, capabilities: ["unknown"] }).accepted, false);
  assert.equal(validateAdapter({ host_id: "pi", version: "1.1.0", ...base, supported: true, capabilities: ["proposal_submission"] }).accepted, true);
  assert.equal(validateAdapter({ host_id: "pi", version: "1.1.0", ...base, supported: false }).reason, "unsupported_capability");
});

test("adapter client never exposes the store and keeps engagement attribution", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const engagement_id = uuidv7();
  const adapter = createPiAdapter(service, createPrincipal("model", "model-a", engagement_id));
  assert.equal("db" in store, false);
  assert.equal(store.db, undefined);
  assert.equal("store" in adapter, false);
  assert.equal("db" in adapter, false);
  assert.equal(adapter.descriptor.host_commit, "7c10bd4");
  assert.deepEqual(adapter.status().capabilities, ["session_lifecycle", "context_injection"]);
  assert.deepEqual(adapter.status().missing_capabilities, ["proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result"]);

  const accepted = await adapter.call("proposal.submit", {
    engagement_id,
    subject_type: "claim",
    base_version: 0,
    content: { id: uuidv7(), engagement_id, kind: "claim", proposition: "x", trust_level: "L2" },
  });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.error.code, "validation_error");

  const denied = await adapter.call("checkpoint.commit", { engagement_id, work_run_id: uuidv7(), host_id: "pi", generation: 1, checkpoint: {} });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "authorization_error");
  store.close();
});

test("DeepSeek and Hermes adapters report unsupported capabilities instead of simulating support", () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const principal = createPrincipal("host", "host-a");
  const deepseek = createDeepSeekHarnessAdapter(service, principal, "1.0");
  const hermes = createHermesAdapter(service, principal, "1.0");
  for (const adapter of [deepseek, hermes]) {
    assert.equal(adapter.descriptor.supported, false);
    assert.deepEqual(adapter.descriptor.capabilities, []);
    assert.equal(adapter.status().missing_capabilities.length > 0, true);
    assert.equal(validateAdapter(adapter.descriptor).reason, "unsupported_capability");
  }
  assert.match(deepseek.status().unsupported_capabilities.join(","), /deepseek_native_adapter/);
  assert.match(hermes.status().unsupported_capabilities.join(","), /hermes_native_adapter/);
  store.close();
});

test("unsupported native adapters reject calls before touching Core", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const principal = createPrincipal("host", "host-a");
  const adapters = [createDeepSeekHarnessAdapter(service, principal, "1.0"), createHermesAdapter(service, principal, "1.0")];
  for (const adapter of adapters) {
    const response = await adapter.call("engagement.status", {});
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unsupported_capability");
  }
  assert.equal(store.events().length, 0);
  store.close();
});

test("untested Pi versions are unsupported", () => {
  assert.equal(isSupportedPiVersion("1.1.0"), true);
  assert.equal(isSupportedPiVersion("0.74.2"), false);
  const descriptor = createPiDescriptor("0.74.2");
  assert.equal(descriptor.supported, false);
  assert.deepEqual(descriptor.capabilities, []);
});
