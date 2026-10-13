import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoreService } from "@taric/core";
import { createPrincipal, uuidv7 } from "@taric/core";
import { AuthorityStore } from "@taric/core/dist/store.js";
import { cliCommands, cliSubcommands, discoverCliConfig, normalizeCliOperation, resolveCliStartup, runCli } from "../dist/cli.js";

test("CLI help lists deterministic Phase 1 commands", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const help = await runCli(["--help"], service, { id: "operator", role: "operator" });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /usage: taric <operation> \[json\]/);
  assert.match(help.stdout, /context build\|query/);
  for (const command of ["engagement.init", "proposal.submit", "capability.status"]) assert.ok(cliCommands.includes(command));
  store.close();
});

test("CLI rejects malformed JSON and unknown grouped verbs without dispatch", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const bad = await runCli(["proposal.submit", "{oops"], service, { id: "operator", role: "operator" });
  assert.equal(bad.exitCode, 2);
  assert.equal(bad.stdout, "");
  assert.equal(JSON.parse(bad.stderr).error.code, "validation_error");

  const unknownVerb = await runCli(["context", "explode", "{}"], service, { id: "operator", role: "operator" });
  assert.equal(unknownVerb.exitCode, 1);
  assert.equal(JSON.parse(unknownVerb.stderr).error.code, "unsupported_capability");
  store.close();
});

test("CLI preserves structured unsupported capability diagnostics on stderr", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const result = await runCli(["storage.postgresql", "{}"], service, { id: "operator", role: "operator" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "unsupported_capability");
  assert.ok(envelope.error.follow_up);
  store.close();
});

test("CLI operator principal cannot self-declare a different engagement permission", async () => {
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const denied = await runCli(["proposal.list", JSON.stringify({ engagement_id: "engagement-b" })], service, { id: "operator", role: "operator", engagement_id: "engagement-a" });
  assert.equal(denied.exitCode, 1);
  assert.equal(JSON.parse(denied.stderr).error.code, "authorization_error");
  store.close();
});

test("normalizeCliOperation only resolves documented verbs", () => {
  assert.equal(normalizeCliOperation(["context", "query"]), "context.query");
  assert.equal(normalizeCliOperation(["action", "host-result"]), "action.host-result");
  assert.equal(normalizeCliOperation(["audit", "doctor"]), "audit.doctor");
  assert.equal(normalizeCliOperation(["audit", "delete-everything"]), "audit.invalid");
  assert.deepEqual(Object.keys(cliSubcommands).sort(), ["action", "adapter", "audit", "context"]);
});

test("Artifact CLI commands forward explicit content reads through Core only", async () => {
  assert.equal(normalizeCliOperation(["artifact.content.read"]), "artifact.content.read");
  assert.ok(cliCommands.includes("artifact.session.bind"));
  assert.ok(cliCommands.includes("artifact.store.append"));
  let received;
  const mock = { dispatch(operation, principal, request) { received = { operation, principal, request }; return { ok: true, data: { accepted: true } }; } };
  const result = await runCli(["artifact.session.output", JSON.stringify({ engagement_id: "e", session_id: "s" }), "--include-content"], mock, { id: "host", role: "host", engagement_id: "e", capabilities: ["content_read"] });
  assert.equal(result.exitCode, 0);
  assert.equal(received.operation, "artifact.session.output");
  assert.equal(received.request.include_content, true);
  assert.ok(received.principal.capabilities.includes("content_read"));
});

test("Artifact CLI round-trips content through Core and requires explicit read capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-cli-artifact-"));
  const engagement_id = uuidv7();
  const session_id = "cli-session";
  const contentRoot = join(dir, "content");
  const store = new AuthorityStore();
  const service = createCoreService(store, contentRoot);
  const host = { id: "cli-host", role: "host", engagement_id };
  const bytes = Buffer.from([0, 255, 10, 13, 42]);
  const { createHash } = await import("node:crypto");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const call = async (operation, input, extra = []) => runCli([operation, JSON.stringify(input), ...extra], service, host);
  try {
    const binding = await call("artifact.session.bind", { engagement_id, session_id, root: join(contentRoot, session_id) });
    assert.equal(binding.exitCode, 0);
    const begun = JSON.parse((await call("artifact.store.begin", { engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", expected_bytes: bytes.length, expected_hash: digest })).stdout).data;
    assert.equal(begun.content_status, "pending");
    assert.equal((await call("artifact.store.append", { engagement_id, session_id, upload_id: begun.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: digest })).exitCode, 0);
    const committed = JSON.parse((await call("artifact.store.commit", { engagement_id, session_id, upload_id: begun.upload_id, total_bytes: bytes.length, content_hash: digest })).stdout).data;
    const denied = await call("artifact.content.read", { engagement_id, session_id, content_ref: committed.content_ref });
    assert.equal(denied.exitCode, 1);
    assert.equal(JSON.parse(denied.stderr).error.code, "authorization_error");
    const read = await runCli(["artifact.content.read", JSON.stringify({ engagement_id, session_id, content_ref: committed.content_ref })], service, { ...host, capabilities: ["content_read"] });
    assert.equal(read.exitCode, 0);
    assert.deepEqual(Buffer.from(JSON.parse(read.stdout).data.data, "base64"), bytes);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("configuration discovery validates a deterministic JSON file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-cli-config-"));
  try {
    const configPath = join(dir, "config.json");
    await (await import("node:fs/promises")).writeFile(configPath, JSON.stringify({ db_path: join(dir, "authority.sqlite"), content_root: join(dir, "content"), principal_role: "host" }));
    const found = discoverCliConfig({ TARIC_CONFIG: configPath }, dir, dir);
    assert.equal(found.path, configPath);
    assert.equal(found.config.principal_role, "host");
    assert.equal(found.config.content_root, join(dir, "content"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI startup resolves default SQLite and blocks explicit or pseudo multi-host deployment", () => {
  const defaults = resolveCliStartup({}, {}, "/tmp/taric-home");
  assert.equal(defaults.diagnostics.ok, true);
  assert.equal(defaults.diagnostics.backend, "sqlite");
  assert.equal(defaults.dbPath, "/tmp/taric-home/.taric/authority.sqlite");

  const shared = resolveCliStartup({ authority: { profile: "multi_host_authority", postgresql: { connection_string: "postgres://authority/db" }, host_id: "host-a", lease_mode: "server_side" } }, {}, "/tmp/taric-home");
  assert.equal(shared.diagnostics.ok, false);
  assert.equal(shared.diagnostics.backend, "postgresql");
  assert.match(shared.diagnostics.message, /unavailable/);

  for (const deployment of [
    { multi_host: true },
    { shared_sqlite_path: true },
    { nfs_lock: true },
    { sqlite_replica_count: 2 },
    { shared_git_clone: true },
  ]) {
    const blocked = resolveCliStartup({ deployment }, {}, "/tmp/taric-home");
    assert.equal(blocked.diagnostics.ok, false, JSON.stringify(deployment));
    assert.equal(blocked.diagnostics.code, "unsupported_deployment", JSON.stringify(deployment));
  }
});

test("adapter management only changes its own config and unsupported hooks stay unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-adapter-config-"));
  const prior = process.env.TARIC_ADAPTER_CONFIG;
  process.env.TARIC_ADAPTER_CONFIG = join(dir, "adapters.json");
  try {
    const store = new AuthorityStore(); const service = createCoreService(store);
    const operator = { id: "operator", role: "operator" };
    const installed = await runCli(["adapter", "install", JSON.stringify({ host: "hermes" })], service, operator);
    assert.equal(installed.exitCode, 0); assert.equal(JSON.parse(installed.stdout).data.installed, true);
    const configPath = JSON.parse(installed.stdout).data.config_path;
    const config = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
    assert.equal(config.adapters.hermes.enabled, true);
    const removed = await runCli(["adapter", "remove", JSON.stringify({ host: "hermes" })], service, operator);
    assert.equal(removed.exitCode, 0); assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8")).adapters, {});
    store.close();
  } finally { if (prior === undefined) delete process.env.TARIC_ADAPTER_CONFIG; else process.env.TARIC_ADAPTER_CONFIG = prior; await rm(dir, { recursive: true, force: true }); }
});
