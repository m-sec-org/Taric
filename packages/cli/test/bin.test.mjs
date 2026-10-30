import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const cliPath = join(import.meta.dirname, "..", "dist", "bin.js");

test("taric --help exits zero with usage on stdout", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--help"], { env: { ...process.env, TARIC_DB: ":memory:" } });
  assert.match(stdout, /usage: taric/);
  assert.equal(stderr, "");
});

test("taric --help does not require a valid user configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-cli-config-"));
  try {
    const configPath = join(dir, "broken.json");
    await writeFile(configPath, "{broken");
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--help"], { env: { ...process.env, TARIC_CONFIG: configPath } });
    assert.match(stdout, /usage: taric/);
    assert.equal(stderr, "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("taric capability.status reports the shared compatibility manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-cli-bin-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "capability.status", "{}"], { env: { ...process.env, TARIC_DB: join(dir, "authority.sqlite") } });
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.compatibility_manifest.profile, "single_host_taric_plugin_v1");
    assert.equal(envelope.data.compatibility_manifest.hosts.pi.version, "1.4.0");
    assert.equal(envelope.data.compatibility_manifest.hosts.hermes.state, "supported");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("explicit multi-host authority blocks before opening the SQLite path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-multi-host-blocked-"));
  try {
    const dbPath = join(dir, "must-not-open.sqlite");
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ db_path: dbPath, authority: { profile: "multi_host_authority", postgresql: { connection_string: "postgres://authority/db" }, host_id: "host-a", lease_mode: "server_side" } }));
    let stdout = ""; let stderr = ""; let code = 0;
    try { ({ stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "capability.status", "{}"], { env: { ...process.env, TARIC_CONFIG: configPath } })); }
    catch (error) { code = error.code; stdout = error.stdout; stderr = error.stderr; }
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    const diagnostic = JSON.parse(stderr);
    assert.equal(diagnostic.data.backend, "postgresql");
    assert.equal(diagnostic.data.enabled, false);
    assert.equal(diagnostic.error.code, "postgresql_unavailable");
    assert.match(diagnostic.error.message, /unavailable/);
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(dbPath)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pseudo multi-host SQLite declaration blocks before opening SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-pseudo-multi-host-"));
  try {
    const dbPath = join(dir, "must-not-open.sqlite");
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ db_path: dbPath, deployment: { multi_host: true } }));
    let stdout = ""; let stderr = ""; let code = 0;
    try { ({ stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "capability.status", "{}"], { env: { ...process.env, TARIC_CONFIG: configPath } })); }
    catch (error) { code = error.code; stdout = error.stdout; stderr = error.stderr; }
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.equal(JSON.parse(stderr).error.code, "unsupported_deployment");
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(dbPath)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("adapter version and health examples run in subprocesses", async () => {
  const version = await execFileAsync(process.execPath, [cliPath, "adapter", "version"], { env: { ...process.env, TARIC_DB: ":memory:" } });
  assert.equal(JSON.parse(version.stdout).data.contract_version, "1.1");
  assert.equal(JSON.parse(version.stdout).data.api_contract_version, "1.3.0");
  const health = await execFileAsync(process.execPath, [cliPath, "adapter", "health"], { env: { ...process.env, TARIC_DB: ":memory:" } });
  const manifest = JSON.parse(health.stdout).data;
  assert.equal(manifest.core_connected, true);
  assert.equal(manifest.compatibility_manifest.hosts["deepseek-harness"].version, "0.2.0-rc.2");
  assert.equal(manifest.compatibility_manifest.hosts.hermes.version, "0.19.0");
});

test("Node proxy serves a real Bun client, pins the host principal, and restarts cleanly", async (t) => {
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.error?.code === "ENOENT") return t.skip("Bun is unavailable in this environment");
  assert.equal(bun.status, 0, bun.stderr);
  const dir = await mkdtemp(join(tmpdir(), "taric-proxy-bun-"));
  const socket = join(dir, "core.sock");
  const db = join(dir, "authority.sqlite");
  let engagement;
  const env = { ...process.env, TARIC_DB: db, TARIC_CONTENT_ROOT: join(dir, "content"), TARIC_CORE_SOCKET: socket, TARIC_ADAPTER_TOKEN: "d".repeat(48), TARIC_ENGAGEMENT_ID: engagement, TARIC_PRINCIPAL_ID: "fixed-host" };
  const runCli = (args) => execFileAsync(process.execPath, [cliPath, ...args], { env });
  const waitForSocket = async (child) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`proxy exited before listening (${child.exitCode})`);
      try { await (await import("node:fs/promises")).stat(socket); return; } catch { await delay(25); }
    }
    throw new Error("proxy did not create its socket");
  };
  const startProxy = async () => {
    const child = spawn(process.execPath, [cliPath, "proxy"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    await waitForSocket(child).catch(async (cause) => {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      throw new Error(`${cause.message}: ${stderr}`);
    });
    return child;
  };
  const stopProxy = async (child) => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  };
  const client = new URL("../../../scripts/adapter-rpc-bun-client.mjs", import.meta.url).pathname;
  const runBunClient = async () => execFileAsync("bun", [client, "--probe-privilege"], { env });
  try {
    const initialized = JSON.parse((await runCli(["engagement.init", JSON.stringify({ name: "bun-proxy", scope: { allowed_targets: ["example.test"], excluded_targets: [], rules_of_engagement_ref: "roe:bun-proxy" } })])).stdout);
    engagement = initialized.data.id;
    env.TARIC_ENGAGEMENT_ID = engagement;
    let proxy = await startProxy();
    try {
      const first = await runBunClient();
      assert.equal(JSON.parse(first.stdout.split("\n")[0]).data.engagement_id, engagement);
      assert.deepEqual(JSON.parse(first.stdout.split("\n")[1]).data, { operator: "denied", reviewer: "denied", writer: "denied", principal_switch: "denied" });
    } finally { await stopProxy(proxy); }
    proxy = await startProxy();
    try {
      const restarted = await runBunClient();
      assert.equal(JSON.parse(restarted.stdout.split("\n")[0]).data.engagement_id, engagement);
    } finally { await stopProxy(proxy); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("taric exits nonzero and keeps stdout empty for unsupported capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-cli-bin-"));
  try {
    let code = 0; let stdout = ""; let stderr = "";
    try {
      const result = await execFileAsync(process.execPath, [cliPath, "git.remote_push", "{}"], { env: { ...process.env, TARIC_DB: join(dir, "authority.sqlite") } });
      stdout = result.stdout; stderr = result.stderr;
    } catch (error) { code = error.code; stdout = error.stdout; stderr = error.stderr; }
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.equal(JSON.parse(stderr).error.code, "unsupported_capability");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("taric rejects an unknown command with unsupported_capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-cli-bin-"));
  try {
    let code = 0; let stderr = "";
    try { await execFileAsync(process.execPath, [cliPath, "writer.commit_machine_approved", "{}"], { env: { ...process.env, TARIC_DB: join(dir, "authority.sqlite") } }); }
    catch (error) { code = error.code; stderr = error.stderr; }
    assert.notEqual(code, 0);
    assert.equal(JSON.parse(stderr).error.code, "unsupported_capability");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("taric runs a capture, list, review and admission round trip against one authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-cli-roundtrip-"));
  try {
    const env = { ...process.env, TARIC_DB: join(dir, "authority.sqlite"), TARIC_PRINCIPAL_ROLE: "operator" };
    const run = async (op, body) => JSON.parse((await execFileAsync(process.execPath, [cliPath, op, JSON.stringify(body)], { env })).stdout);
    const initialized = await run("engagement.init", { name: "roundtrip", scope: { allowed_targets: ["example.test:443"], excluded_targets: [], rules_of_engagement_ref: "roe:roundtrip" } });
    assert.equal(initialized.ok, true);
    const engagement_id = initialized.data.id;
    const resourceProposal = await run("proposal.submit", { engagement_id, subject_type: "resource", expected_version: 0, content: { schema_version: "1.0.0", engagement_id, kind: "resource", asset_type: "endpoint", identity: { target: "example.test:443" }, revision: 1 } });
    const resourceAdmission = await run("admission.evaluate", { engagement_id, proposal_id: resourceProposal.data.id, expected_version: 0, policy_digest: `sha256:${"a".repeat(64)}` });
    const resource_ref = resourceAdmission.data.record.id;
    const captured = await run("capture.observation", { engagement_id, subject_type: "observation", expected_version: 0, content: { schema_version: "1.0.0", engagement_id, kind: "observation", resource_ref, observed_at: new Date().toISOString(), statement: "port 443 open", artifact_refs: [] } });
    assert.equal(captured.ok, true);
    assert.equal(captured.data.status, "pending");
    const listed = await run("proposal.list", { engagement_id });
    assert.equal(listed.data.proposals.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
