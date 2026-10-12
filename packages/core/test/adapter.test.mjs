import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  API_CONTRACT_VERSION,
  TaricAdapterClient,
  createCoreService,
  createDeepSeekHarnessAdapter,
  createDeepSeekDescriptor,
  createHermesAdapter,
  createHermesDescriptor,
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
  assert.deepEqual(adapter.status().missing_capabilities, ["proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result", "cancel", "reload"]);

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

test("DeepSeek and Hermes adapters expose only the locked native integration evidence", () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const principal = createPrincipal("host", "host-a", uuidv7());
  const deepseek = createDeepSeekHarnessAdapter(service, principal);
  const hermes = createHermesAdapter(service, principal);
  for (const adapter of [deepseek, hermes]) {
    assert.equal(adapter.descriptor.supported, true);
    assert.ok(adapter.descriptor.capabilities.length > 0);
    assert.equal(validateAdapter(adapter.descriptor).accepted, true);
  }
  assert.equal(deepseek.status().unsupported_capabilities.length, 0);
  assert.equal(hermes.status().unsupported_capabilities.length, 0);
  store.close();
});

test("native adapters dispatch only through the authenticated Core client", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const principal = createPrincipal("host", "host-a", uuidv7());
  const adapters = [createDeepSeekHarnessAdapter(service, principal), createHermesAdapter(service, principal)];
  for (const adapter of adapters) {
    const response = await adapter.call("engagement.status", { engagement_id: principal.engagement_id });
    assert.equal(response.ok, true);
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

test("unknown native host versions are unsupported and advertise only actual fallback", () => {
  for (const descriptor of [createDeepSeekDescriptor("0.2.0-rc.3", "unknown"), createHermesDescriptor("0.20.0", "unknown")]) {
    assert.equal(descriptor.supported, false);
    assert.deepEqual(descriptor.capabilities, []);
    assert.deepEqual(descriptor.fallback, ["mcp.context.query", "mcp.resource.query", "mcp.proposal.submit", "cli"]);
  }
});

test("pinned native adapter versions and capability manifest match fixture evidence", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/native-adapters.json", import.meta.url), "utf8"));
  const descriptors = [createDeepSeekDescriptor(), createHermesDescriptor()];
  for (const expected of fixture.known) {
    const descriptor = descriptors.find((item) => item.host_id === expected.host_id);
    assert.equal(descriptor.version, expected.version);
    assert.equal(descriptor.host_commit, expected.commit);
    assert.deepEqual(descriptor.capabilities, expected.capabilities);
  }
  for (const expected of fixture.unknown) {
    const descriptor = expected.host_id === "hermes"
      ? createHermesDescriptor(expected.version, expected.commit)
      : createDeepSeekDescriptor(expected.version, expected.commit);
    assert.equal(descriptor.supported, false);
    assert.deepEqual(descriptor.capabilities, []);
  }
});
