import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthorityStore, ContractValidationError, createCoreService, createCoreServiceForPath, createPrincipal, discoverRuntimeConfig, requireRuntimeAuthority, resolveRuntimeAuthority, openRuntimeService, buildRuntimeActivationEvidence, AUTHORITY_RUNTIME_CONFORMANCE_VERSION, AUTHORITY_RUNTIME_SCENARIOS, uuidv7 } from "../dist/index.js";

test("runtime default is persistent and reopening preserves a committed record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-startup-"));
  try {
    const options = { env: {}, config: {}, home: directory };
    const first = requireRuntimeAuthority(options);
    assert.equal(first.dbPath, join(directory, ".taric", "authority.sqlite"));
    assert.equal(first.contentRoot, join(directory, ".taric", "content")); assert.equal(first.explicitMemory, false);
    const store = new AuthorityStore(first.dbPath); const engagement_id = uuidv7();
    const record = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "persistent" })); (await store.close());
    const second = requireRuntimeAuthority(options); const reopened = new AuthorityStore(second.dbPath);
    assert.equal((await reopened.get(record.id)).proposition, "persistent"); (await reopened.close());
    assert.equal(first.diagnostics.runtime_state, "enabled");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Core shared config discovery resolves path, content and principal without disclosing paths in errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-startup-config-"));
  try {
    const configPath = join(directory, "config-canary.json"); const dbPath = join(directory, "authority-canary.sqlite"); const content_root = join(directory, "content-canary");
    writeFileSync(configPath, JSON.stringify({ db_path: dbPath, content_root, principal_id: "same-id", principal_role: "writer", engagement_id: uuidv7() }));
    const env = { TARIC_CONFIG: configPath }; const discovered = discoverRuntimeConfig(env, directory, directory);
    const resolved = resolveRuntimeAuthority({ env, cwd: directory, home: directory });
    assert.equal(resolved.dbPath, discovered.config.db_path); assert.equal(resolved.contentRoot, content_root); assert.equal(resolved.principal.role, "writer");
    writeFileSync(configPath, "{oops");
    assert.throws(() => discoverRuntimeConfig(env, directory, directory), (error) => error.code === "configuration_invalid" && !error.message.includes("canary") && !error.message.includes(directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("explicit runtime config is strict, authoritative, and reports a safe digest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-startup-explicit-"));
  try {
    const explicitPath = join(directory, "daemon.json");
    const workspacePath = join(directory, ".taric", "config.json");
    const explicitDb = join(directory, "explicit.sqlite");
    const ambientDb = join(directory, "ambient.sqlite");
    mkdirSync(join(directory, ".taric"), { recursive: true });
    writeFileSync(workspacePath, JSON.stringify({ db_path: ambientDb, principal_id: "ambient" }));
    writeFileSync(explicitPath, JSON.stringify({ db_path: explicitDb, content_root: join(directory, "explicit-content"), principal_id: "daemon" }));
    const env = { TARIC_CONFIG: workspacePath, TARIC_DB: ambientDb, TARIC_PRINCIPAL_ID: "ambient-env" };
    const discovered = discoverRuntimeConfig(env, directory, directory, explicitPath);
    assert.equal(discovered.provenance.source, "explicit");
    assert.match(discovered.provenance.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(discovered.path, explicitPath);
    const resolved = resolveRuntimeAuthority({ env, cwd: directory, home: directory, runtimeConfigPath: explicitPath });
    assert.equal(resolved.dbPath, explicitDb);
    assert.equal(resolved.contentRoot, join(directory, "explicit-content"));
    assert.equal(resolved.principal.id, "daemon");
    assert.equal(resolved.runtimeConfigProvenance.source, "explicit");
    assert.equal(resolved.precedence.db_path, "config");
    assert.equal(resolved.precedence.principal_id, "config");
    assert.equal(resolved.precedence.content_root_mode, "configured");
    assert.equal(Object.isFrozen(resolved), true);
    assert.equal(Object.isFrozen(resolved.authority), true);
    assert.equal(Object.isFrozen(resolved.principal), true);
    assert.equal(Object.isFrozen(resolved.principal.capabilities), true);
    const service = await openRuntimeService({ env, cwd: directory, home: directory, runtimeConfigPath: explicitPath });
    await service.close();
    assert.equal(existsSync(explicitDb), true);
    assert.equal(existsSync(ambientDb), false);
    assert.throws(() => discoverRuntimeConfig(env, directory, directory, join(directory, "missing.json")), (error) => error.code === "configuration_invalid" && !error.message.includes("missing.json"));
    writeFileSync(explicitPath, "{broken");
    assert.throws(() => discoverRuntimeConfig(env, directory, directory, explicitPath), (error) => error.code === "configuration_invalid" && !error.message.includes(explicitPath));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("ambient runtime config provenance follows environment, workspace, home, then default", () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-startup-provenance-"));
  try {
    const envPath = join(directory, "env.json");
    const workspace = join(directory, "workspace");
    const home = join(directory, "home");
    mkdirSync(join(workspace, ".taric"), { recursive: true });
    mkdirSync(join(home, ".taric"), { recursive: true });
    writeFileSync(envPath, JSON.stringify({ principal_id: "env" }));
    writeFileSync(join(workspace, ".taric", "config.json"), JSON.stringify({ principal_id: "workspace" }));
    writeFileSync(join(home, ".taric", "config.json"), JSON.stringify({ principal_id: "home" }));
    assert.equal(discoverRuntimeConfig({ TARIC_CONFIG: envPath }, workspace, home).provenance.source, "environment");
    assert.equal(discoverRuntimeConfig({}, workspace, home).provenance.source, "workspace");
    rmSync(join(workspace, ".taric", "config.json"));
    assert.equal(discoverRuntimeConfig({}, workspace, home).provenance.source, "home");
    rmSync(join(home, ".taric", "config.json"));
    const fallback = discoverRuntimeConfig({}, workspace, home);
    assert.equal(fallback.provenance.source, "default");
    assert.match(fallback.provenance.digest, /^sha256:[a-f0-9]{64}$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("multi-host startup cannot open SQLite and explicit memory stays explicit", () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-startup-blocked-"));
  try {
    const database = join(directory, "blocked.sqlite");
    const env = { TARIC_DB: database, TARIC_AUTHORITY_PROFILE: "multi_host_authority", TARIC_DATABASE_URL: "postgres://authority/db", TARIC_HOST_ID: "host", TARIC_LEASE_MODE: "server_side" };
    assert.throws(() => requireRuntimeAuthority({ env, config: {}, home: directory }), (error) => error.code === "postgresql_unavailable");
    assert.equal(existsSync(database), false);
    const memory = resolveRuntimeAuthority({ env: { TARIC_DB: ":memory:", TARIC_CONTENT_ROOT: join(directory, "memory-content") }, config: {}, home: directory });
    assert.equal(memory.explicitMemory, true); assert.equal(memory.dbPath, ":memory:");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("stable typed errors and generic unknown errors survive the Core boundary", async () => {
  const store = new AuthorityStore(); const service = (await createCoreService(store)); const engagement_id = uuidv7(); const principal = createPrincipal("model", "model", engagement_id);
  try {
    store.recordsPage = () => { throw new Error("stale lease SQL /private/authority.sqlite secret-canary"); };
    const hidden = (await service.dispatch("query", principal, { engagement_id }));
    assert.deepEqual(hidden.error, { code: "internal_error", message: "internal error", follow_up: undefined });
    store.recordsPage = () => { throw new ContractValidationError("stale_version", "pinned version is stale"); };
    const declared = (await service.dispatch("query", principal, { engagement_id }));
    assert.equal(declared.error.code, "stale_version"); assert.equal(declared.error.message, "pinned version is stale");
    store.recordsPage = () => { const error = new Error("private unknown-code message"); error.code = "stale_version"; throw error; };
    assert.equal((await service.dispatch("query", principal, { engagement_id })).error.code, "internal_error", "untyped arbitrary exceptions cannot self-declare a public error");
  } finally { (await store.close()); }
});

test("multi-host runtime rejects absent, failed and mismatched saved evidence before SQLite or content creation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-runtime-evidence-"));
  const database = join(directory, "never-created.sqlite"); const content = join(directory, "never-created-content");
  const evidencePath = join(directory, "activation.json");
  const env = { TARIC_AUTHORITY_PROFILE: "multi_host_authority", TARIC_DATABASE_URL: "postgresql://private-invalid-host:1/authority", TARIC_HOST_ID: "host", TARIC_LEASE_MODE: "server_side", TARIC_DB: database, TARIC_CONTENT_ROOT: content };
  const report = { version: AUTHORITY_RUNTIME_CONFORMANCE_VERSION, passed: true, missing_methods: [], failures: [], scenarios: AUTHORITY_RUNTIME_SCENARIOS.map((id) => ({ id, passed: true, evidence: [`unit-gate-mechanism:${id}`] })) };
  try {
    await assert.rejects(openRuntimeService({ env, config: {}, home: directory }), (error) => error.code === "postgresql_unavailable");
    const valid = buildRuntimeActivationEvidence(report);
    assert.throws(() => buildRuntimeActivationEvidence({ ...report, passed: false }), /passing runtime conformance/);
    for (const patch of [{ implementation_digest: "sha256:old-build" }, { schema_version: "99.0.0" }, { policy_digest: "sha256:old-policy" }, { runtime_conformance: { ...report, passed: false, failures: ["failed checkpoint"] } }]) {
      writeFileSync(evidencePath, JSON.stringify({ ...valid, ...patch }));
      await assert.rejects(openRuntimeService({ env: { ...env, TARIC_RUNTIME_CONFORMANCE: evidencePath }, config: {}, home: directory }), (error) => error.code === "backend_conformance_failed" && !error.message.includes(directory));
      assert.equal(existsSync(database), false); assert.equal(existsSync(content), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
