import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoreService } from "@taric/core";
import { AuthorityStore } from "@taric/core/dist/store.js";
import { cliCommands, cliSubcommands, discoverCliConfig, normalizeCliOperation, runCli } from "../dist/cli.js";

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
  assert.deepEqual(Object.keys(cliSubcommands).sort(), ["action", "audit", "context"]);
});

test("configuration discovery validates a deterministic JSON file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-cli-config-"));
  try {
    const configPath = join(dir, "config.json");
    await (await import("node:fs/promises")).writeFile(configPath, JSON.stringify({ db_path: join(dir, "authority.sqlite"), principal_role: "host" }));
    const found = discoverCliConfig({ TARIC_CONFIG: configPath }, dir, dir);
    assert.equal(found.path, configPath);
    assert.equal(found.config.principal_role, "host");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
