import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ADAPTER_CONTRACT_VERSION as CORE_ADAPTER_CONTRACT_VERSION, API_CONTRACT_VERSION, AUTHORITY_STORAGE_CONTRACT_VERSION, TARIC_COMPATIBILITY_MANIFEST } from "../dist/index.js";
import { schemaMetadata } from "../dist/identity.js";
import { ADAPTER_CONTRACT_VERSION, operationContracts, SCHEMA_VERSION } from "@taric/schemas";

const root = resolve(new URL("../../..", import.meta.url).pathname);

test("published compatibility matrix covers current contracts, package closure, drivers, and certified hosts", () => {
  const matrix = JSON.parse(readFileSync(join(root, "compatibility-matrix.json"), "utf8"));
  assert.equal(matrix.schema_version, SCHEMA_VERSION);
  assert.equal(matrix.api_contract_version, API_CONTRACT_VERSION);
  assert.equal(matrix.adapter_contract_version, ADAPTER_CONTRACT_VERSION);
  assert.equal(CORE_ADAPTER_CONTRACT_VERSION, ADAPTER_CONTRACT_VERSION);
  assert.equal(matrix.storage_contract_version, AUTHORITY_STORAGE_CONTRACT_VERSION);
  assert.equal(schemaMetadata().core_version, "1.1.0");
  assert.deepEqual(matrix.operations.map(({ operation }) => operation), operationContracts.map(({ operation }) => operation));
  assert.ok(matrix.operations.every(({ request_schema, response_schema, errors }) => request_schema && response_schema && Array.isArray(errors)));
  assert.equal(matrix.runtime_dependency_closure["@taric/core"].runtime_dependencies["@taric/schemas"], "1.1.0");
  assert.ok(matrix.drivers.some(({ name, runtime, exports }) => name === "@taric/driver-bun-sqlite" && runtime === "bun" && exports.includes(".")));
  assert.deepEqual(Object.keys(matrix.certified_hosts), Object.keys(TARIC_COMPATIBILITY_MANIFEST.hosts));
  assert.equal(matrix.certified_hosts.pi.version, "1.5.0");
  assert.equal(matrix.certified_hosts.pi.commit, "f9a26365568127461c47a07a37dcb42c140a3ac5");
  const credentialBoundary = TARIC_COMPATIBILITY_MANIFEST.non_goals.find(({ id }) => id === "credential_management");
  assert.match(credentialBoundary.detail, /opaque Artifact/);
  assert.match(credentialBoundary.detail, /gateway/);
});

test("Pi 1.5 certification report pins the exact host and schema and passes required live checks", () => {
  const report = JSON.parse(readFileSync(join(root, "docs/benchmarks/pi-1.5.0-live.json"), "utf8"));
  assert.equal(report.host.package, "@earendil-works/pi-coding-agent");
  assert.equal(report.host.version, "1.5.0");
  assert.equal(report.host.commit, "f9a26365568127461c47a07a37dcb42c140a3ac5");
  assert.equal(report.evidence.upstream_tag, "v1.5.0");
  assert.equal(report.evidence.upstream_commit, report.host.commit);
  assert.deepEqual(report.schema, { package: "@earendil-works/pi-schema", version: "1.5.0" });
  assert.equal(report.release_review.extension_api, "ExtensionAPI.on/registerTool");
  assert.match(report.release_review.tool_validation, /pi-schema/);
  for (const id of ["real_pi_rpc_process_starts", "taric_extension_loaded_by_real_pi_extension_api", "pi_1_5_schema_coercion_and_diagnostics", "real_pi_rpc_command_surface_available", "current_taric_adapter_matches_live_pi_version"]) {
    assert.equal(report.checks.find((check) => check.id === id)?.passed, true, `${id} must pass in the live report`);
  }
  const extensionCheck = report.checks.find((check) => check.id === "taric_extension_loaded_by_real_pi_extension_api");
  assert.ok(extensionCheck.hooks.includes("registerTool:taric_proposal"));
  assert.ok(extensionCheck.hooks.includes("agent_before_settle"));
  assert.ok(report.limitations.length > 0);
  assert.equal("package_root" in report.evidence, false);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/|\/tmp\/taric|\/home\/|\/private\//);
});

test("compatibility matrix check rejects an omitted operation", () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-matrix-check-"));
  const output = join(dir, "matrix.json");
  try {
    const generated = spawnSync(process.execPath, ["scripts/emit-compatibility-matrix.mjs", "--output", output], { cwd: root, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const matrix = JSON.parse(readFileSync(output, "utf8"));
    matrix.operations.pop();
    writeFileSync(output, `${JSON.stringify(matrix, null, 2)}\n`);
    const check = spawnSync(process.execPath, ["scripts/emit-compatibility-matrix.mjs", "--check", "--output", output], { cwd: root, encoding: "utf8" });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /compatibility matrix is stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
