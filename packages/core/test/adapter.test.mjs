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
  createCustomAdapterDescriptor,
  createPiAdapter,
  createPiDescriptor,
  createPrincipal,
  isSupportedPiVersion,
  piVersionCertificationState,
  supportedPiCapabilities,
  CERTIFIED_PI_VERSIONS,
  SUPPORTED_PI_HOST,
  TARIC_COMPATIBILITY_MANIFEST,
  uuidv7,
  validateAdapter,
} from "../dist/index.js";
import { AuthorityStore } from "../dist/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const base = { contract_version: "1.0", api_contract_version: API_CONTRACT_VERSION, capabilities: [], supported: false };

test("adapter contract rejects unsupported versions, capabilities and API mismatch", () => {
  assert.equal(validateAdapter({ host_id: "pi", version: "1.4.0", ...base, contract_version: "9.0" }).accepted, false);
  assert.equal(validateAdapter({ host_id: "pi", version: "1.4.0", ...base, api_contract_version: "9.0.0" }).accepted, false);
  assert.equal(validateAdapter({ host_id: "pi", version: "1.4.0", ...base, capabilities: ["unknown"] }).accepted, false);
  assert.equal(validateAdapter({ host_id: "pi", version: "1.4.0", ...base, supported: true, capabilities: ["proposal_submission"] }).accepted, true);
  assert.equal(validateAdapter({ host_id: "pi", version: "1.4.0", ...base, supported: false }).reason, "unsupported_capability");
});

test("custom adapter identities are format-validated metadata and do not grant native capability", async () => {
  const descriptor = createCustomAdapterDescriptor({
    adapter_id: "acme/red-team",
    framework_package: "@acme/agent",
    distribution: "red-team",
    version: "2.4.1-fork.1",
    commit: "fork-2026",
    declared_capabilities: ["writer", "reviewer"],
  });
  assert.equal(descriptor.host_id, "acme/red-team");
  assert.equal(descriptor.framework_package, "@acme/agent");
  assert.equal(descriptor.distribution, "red-team");
  assert.equal(descriptor.version, "2.4.1-fork.1");
  assert.equal(descriptor.commit, "fork-2026");
  assert.deepEqual(descriptor.capabilities, []);
  assert.equal(descriptor.supported, false);
  assert.deepEqual(descriptor.declared_capabilities, ["writer", "reviewer"]);
  assert.equal(validateAdapter(descriptor).accepted, false);
  assert.equal(descriptor.framework_package, "@acme/agent");
  assert.throws(() => createCustomAdapterDescriptor({ adapter_id: "../privileged", framework_package: "pkg", distribution: "dist", version: "1" }), /invalid adapter id/);

  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const client = new TaricAdapterClient(descriptor, service, createPrincipal("model", "model-a", engagement_id));
  assert.equal((await client.call("engagement.status", { engagement_id })).ok, true);
  const privileged = await client.call("checkpoint.commit", { engagement_id, work_run_id: uuidv7(), host_id: "model-a", generation: 1, checkpoint: {} });
  assert.equal(privileged.ok, false);
  assert.equal(privileged.error.code, "authorization_error");
  await store.close();
});

test("adapter client never exposes the store and keeps engagement attribution", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const adapter = createPiAdapter(service, createPrincipal("model", "model-a", engagement_id));
  assert.equal("db" in store, false);
  assert.equal(store.db, undefined);
  assert.equal("store" in adapter, false);
  assert.equal("db" in adapter, false);
  assert.equal(adapter.descriptor.host_commit, "4a08025");
  assert.deepEqual(adapter.status().capabilities, []);
  assert.equal(adapter.status().service_connected, false);
  assert.equal(adapter.status().capability_status.session_lifecycle.reason, "adapter instance has not registered runtime hooks or tools");
  assert.deepEqual(adapter.status().missing_capabilities, ["session_lifecycle", "context_injection", "proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result", "cancel", "reload"]);

  const accepted = await adapter.call("proposal.submit", {
    engagement_id,
    subject_type: "claim",
    expected_version: 0,
    content: { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "x", trust_level: "L2" },
  });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.error.code, "validation_error");
  assert.equal(adapter.status().service_connected, true, "service_connected means the service returned a response, not that the host is healthy");

  const denied = await adapter.call("checkpoint.commit", { engagement_id, work_run_id: uuidv7(), host_id: "pi", generation: 1, checkpoint: {} });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "authorization_error");
  (await store.close());
});

test("DeepSeek and Hermes adapters expose only the locked native integration evidence", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
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
  (await store.close());
});

test("native adapters dispatch only through the authenticated Core client", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const principal = createPrincipal("host", "host-a", uuidv7());
  const adapters = [createDeepSeekHarnessAdapter(service, principal), createHermesAdapter(service, principal)];
  for (const adapter of adapters) {
    const response = await adapter.call("engagement.status", { engagement_id: principal.engagement_id });
    assert.equal(response.ok, true);
  }
  assert.equal((await store.events()).length, 0);
  (await store.close());
});

test("authenticated adapter Artifact calls use Core authorization and content contracts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-adapter-artifact-"));
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const session_id = "adapter-session";
  const contentRoot = join(dir, "content");
  const service = (await createCoreService(store, contentRoot));
  const host = createDeepSeekHarnessAdapter(service, createPrincipal("host", "host-a", engagement_id));
  const reader = createHermesAdapter(service, createPrincipal("host", "reader-a", engagement_id, ["content_read"]));
  const bytes = Buffer.from("adapter artifact bytes");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  try {
    assert.equal((await host.call("artifact.session.bind", { engagement_id, session_id, root: join(contentRoot, session_id), mode: "host-session" })).ok, true);
    const begun = await host.call("artifact.store.begin", { engagement_id, session_id, payload_kind: "text", media_type: "text/plain", expected_bytes: bytes.length, expected_hash: digest });
    assert.equal(begun.ok, true);
    assert.equal((await host.call("artifact.store.append", { engagement_id, session_id, upload_id: begun.data.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: digest })).ok, true);
    const committed = await host.call("artifact.store.commit", { engagement_id, session_id, upload_id: begun.data.upload_id, total_bytes: bytes.length, content_hash: digest });
    assert.equal(committed.ok, true);
    const denied = await host.call("artifact.content.read", { engagement_id, session_id, content_ref: committed.data.content_ref });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "authorization_error");
    const read = await reader.call("artifact.content.read", { engagement_id, session_id, content_ref: committed.data.content_ref });
    assert.equal(read.ok, true);
    assert.deepEqual(Buffer.from(read.data.data, "base64"), bytes);
  } finally {
    (await store.close());
    rmSync(dir, { recursive: true, force: true });
  }
});

test("certification-aware version gate: set membership with explicit degradation", () => {
  assert.equal(isSupportedPiVersion("1.4.0"), true);
  assert.equal(isSupportedPiVersion("1.1.0"), false);
  // 集合成员资格，不做区间推断：相邻补丁版本不因邻近认证项而自动支持。
  assert.equal(isSupportedPiVersion("1.4.1"), false);
  assert.equal(piVersionCertificationState("1.4.0"), "certified");
  // 同 major 未认证：只读安全子集 + not_certified，永不 supported。
  const sameMajor = createPiDescriptor("1.5.0");
  assert.equal(sameMajor.supported, false);
  assert.equal(sameMajor.certification_state, "not_certified");
  assert.deepEqual(sameMajor.capabilities, ["session_lifecycle", "context_injection"]);
  assert.deepEqual(sameMajor.certification_evidence, []);
  // 更远版本：最小诊断集 + unsupported，不再是零能力无解释。
  const far = createPiDescriptor("0.74.2");
  assert.equal(far.supported, false);
  assert.equal(far.certification_state, "unsupported");
  assert.deepEqual(far.capabilities, ["session_lifecycle"]);
});

test("compatibility manifest stays in lockstep with the certified Pi set", () => {
  const hosts = TARIC_COMPATIBILITY_MANIFEST.hosts.pi;
  assert.equal(hosts.version, SUPPORTED_PI_HOST.version);
  assert.equal(hosts.commit, SUPPORTED_PI_HOST.host_commit);
  assert.deepEqual(hosts.certified_versions, CERTIFIED_PI_VERSIONS.map((entry) => entry.version));
  const certified = createPiDescriptor(SUPPORTED_PI_HOST.version);
  assert.deepEqual(certified.capabilities, [...supportedPiCapabilities]);
});

test("Pi capability status keeps technical availability separate from pending quality evidence", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const adapter = createPiAdapter(service, createPrincipal("host", "pi-host", engagement_id));
  const initial = adapter.status();
  assert.deepEqual(initial.capabilities, []);
  assert.equal(initial.service_connected, false);
  assert.equal(initial.quality_release_state, "pending");
  assert.equal(initial.capability_status.session_lifecycle.runtime_state, "disabled");
  const extension = { on() { return () => {}; } };
  const loaded = await adapter.register(extension);
  assert.equal(loaded.available_capabilities.includes("session_lifecycle"), true);
  assert.equal(loaded.available_capabilities.includes("checkpoint"), false);
  assert.equal(adapter.status().capabilities.includes("session_lifecycle"), true);
  assert.equal(adapter.status().service_connected, false);
  assert.equal(adapter.status().capability_status.checkpoint.runtime_state, "disabled");
  assert.equal(adapter.status().quality_release_state, "pending");
  await store.close();
});

test("Pi checkpoint and host result callbacks remain disabled without a valid run binding", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  const adapter = createPiAdapter(service, createPrincipal("host", "pi-host", engagement_id));
  const extension = { on() { return () => {}; }, registerTool() {} };
  const loaded = await adapter.register(extension, {
    checkpoint: () => ({ ok: true }),
    resultForTool: () => ({ action_id: uuidv7(), mode: "host_hitl", status: "executed" }),
  });
  assert.equal(loaded.available_capabilities.includes("checkpoint"), false);
  assert.equal(loaded.available_capabilities.includes("host_result"), false);
  assert.equal(adapter.status().capability_status.checkpoint.reason.includes("run binding"), true);
  await store.close();
});

test("stale, skipped, and mock adapter evidence cannot enable native capabilities", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = uuidv7();
  for (const evidence of [
    { version: "1.0.9", state: "verified" },
    { version: "1.4.0", state: "skipped" },
    { version: "1.4.0", state: "mock" },
  ]) {
    const adapter = createPiAdapter(service, createPrincipal("host", `pi-${evidence.state}`, engagement_id));
    adapter.descriptor.certification_evidence = [{
      framework_package: "@earendil-works/pi-coding-agent",
      distribution: "pi",
      version: evidence.version,
      commit: "4a08025",
      state: evidence.state,
      ref: "fixture-only",
    }];
    assert.deepEqual(adapter.status().capabilities, []);
    assert.equal(adapter.status().runtime_state, "disabled");
  }
  await store.close();
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
