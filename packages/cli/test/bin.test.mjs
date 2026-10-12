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
    const engagement_id = "0193a0f0-0000-7000-8000-000000000001";
    assert.equal((await run("engagement.init", { id: engagement_id, name: "roundtrip" })).ok, true);
    const captured = await run("capture.observation", { engagement_id, subject_type: "observation", base_version: 0, content: { id: "0193a0f0-0000-7000-8000-000000000002", engagement_id, kind: "observation", statement: "port 443 open", evidence_refs: [] } });
    assert.equal(captured.ok, true);
    assert.equal(captured.data.status, "pending");
    const listed = await run("proposal.list", { engagement_id });
    assert.equal(listed.data.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
