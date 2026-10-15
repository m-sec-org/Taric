import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    assert.equal(envelope.data.compatibility_manifest.hosts.pi.version, "1.1.0");
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
  assert.equal(JSON.parse(version.stdout).data.contract_version, "1.0");
  const health = await execFileAsync(process.execPath, [cliPath, "adapter", "health"], { env: { ...process.env, TARIC_DB: ":memory:" } });
  const manifest = JSON.parse(health.stdout).data;
  assert.equal(manifest.core_connected, true);
  assert.equal(manifest.compatibility_manifest.hosts["deepseek-harness"].version, "0.2.0-rc.2");
  assert.equal(manifest.compatibility_manifest.hosts.hermes.version, "0.19.0");
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
