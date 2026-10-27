import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { API_CONTRACT_VERSION, AUTHORITY_STORAGE_CONTRACT_VERSION, TARIC_COMPATIBILITY_MANIFEST } from "../dist/index.js";
import { schemaMetadata } from "../dist/identity.js";
import { operationContracts, SCHEMA_VERSION } from "@taric/schemas";

const root = resolve(new URL("../../..", import.meta.url).pathname);

test("published compatibility matrix covers current contracts, package closure, drivers, and certified hosts", () => {
  const matrix = JSON.parse(readFileSync(join(root, "compatibility-matrix.json"), "utf8"));
  assert.equal(matrix.schema_version, SCHEMA_VERSION);
  assert.equal(matrix.api_contract_version, API_CONTRACT_VERSION);
  assert.equal(matrix.storage_contract_version, AUTHORITY_STORAGE_CONTRACT_VERSION);
  assert.equal(schemaMetadata().core_version, "1.0.1");
  assert.deepEqual(matrix.operations.map(({ operation }) => operation), operationContracts.map(({ operation }) => operation));
  assert.ok(matrix.operations.every(({ request_schema, response_schema, errors }) => request_schema && response_schema && Array.isArray(errors)));
  assert.equal(matrix.runtime_dependency_closure["@taric/core"].runtime_dependencies["@taric/schemas"], "1.0.1");
  assert.ok(matrix.drivers.some(({ name, runtime, exports }) => name === "@taric/driver-bun-sqlite" && runtime === "bun" && exports.includes(".")));
  assert.deepEqual(Object.keys(matrix.certified_hosts), Object.keys(TARIC_COMPATIBILITY_MANIFEST.hosts));
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
