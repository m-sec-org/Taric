import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuthorityStore,
  ContractValidationError,
  createCoreService,
  createPrincipal,
  normalizeContractValidationDetails,
  validateContract,
  TARIC_SCHEMA_VERSION,
  AUTHORITY_SQL_SCHEMA_VERSION,
} from "../dist/index.js";

test("contract diagnostics are bounded and do not expose submitted values", () => {
  assert.throws(() => validateContract("observation", {
    schema_version: TARIC_SCHEMA_VERSION,
    id: "not-an-id",
    engagement_id: "not-an-engagement",
    statement: "password=super-secret-value",
    password: "super-secret-value",
  }), (error) => {
    assert.ok(error instanceof ContractValidationError);
    assert.equal(error.details.kind, "contract");
    assert.equal(error.details.contract_name, "observation");
    assert.ok(error.details.violations.length > 0);
    assert.ok(error.details.violations.length <= 16);
    assert.doesNotMatch(JSON.stringify(error.details), /super-secret-value/);
    assert.doesNotMatch(JSON.stringify(error.details), /password=super-secret-value/);
    return true;
  });

  const oversized = normalizeContractValidationDetails("observation", Array.from({ length: 100 }, (_, index) => ({
    instancePath: `/field${index}`,
    keyword: "pattern",
    params: { pattern: "x".repeat(10_000), data: "do-not-include" },
    message: "x".repeat(10_000),
  })));
  assert.equal(oversized.violations.length, 16);
  assert.ok(oversized.violations.every((item) => item.message.length <= 256));
  assert.ok(oversized.violations.every((item) => JSON.stringify(item).length < 1_000));
  assert.doesNotMatch(JSON.stringify(oversized), /do-not-include/);
});

test("Core request validation carries normalized details through the API envelope", async () => {
  const service = await createCoreService(new AuthorityStore(":memory:"));
  try {
    const response = await service.dispatch("artifact.store.begin", createPrincipal("operator", "operator-local"), {
      engagement_id: "not-an-id",
      session_id: "session",
      payload_kind: "opaque",
      media_type: "text/plain",
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "validation_error");
    assert.equal(response.error.details.kind, "contract");
    assert.equal(response.error.details.contract_name, "artifactStoreBegin");
    assert.ok(response.error.details.violations.length > 0);
  } finally {
    await service.close();
  }
});

test("SQLite compatibility failure identifies expected and observed markers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-diagnostics-"));
  const filename = join(directory, "authority.sqlite");
  const driverModule = await import("../dist/sql-driver.js");
  try {
    const driver = new driverModule.SqliteAuthorityDriver(filename);
    await driver.ready;
    await driver.run("UPDATE metadata SET value=? WHERE key='storage_format'", "legacy-storage");
    await driver.close();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(filename);
    database.prepare("UPDATE metadata SET value=? WHERE key='storage_format'").run("legacy-storage");
    database.close();
    const incompatible = new driverModule.SqliteAuthorityDriver(filename);
    await assert.rejects(incompatible.ready, (error) => {
      assert.equal(error.code, "unsupported_schema_version");
      assert.equal(error.details.kind, "compatibility");
      assert.equal(error.details.backend, "sqlite");
      assert.equal(error.details.expected.storage_format, AUTHORITY_SQL_SCHEMA_VERSION);
      assert.equal(error.details.observed.storage_format, "legacy-storage");
      return true;
    });
    await incompatible.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
