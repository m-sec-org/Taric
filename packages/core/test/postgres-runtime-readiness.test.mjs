import test from "node:test";
import assert from "node:assert/strict";
import { PostgresAuthorityStore, POSTGRES_MIGRATIONS, AUTHORITY_RUNTIME_SCENARIOS, AUTHORITY_RUNTIME_CONFORMANCE_VERSION, uuidv7 } from "../dist/index.js";

/** Read-only catalog fixture derived from the actual shared SQL migrations. */
function runtimeColumns() {
  const columns = [];
  for (const migration of POSTGRES_MIGRATIONS) {
    for (const match of migration.sql.matchAll(/CREATE TABLE IF NOT EXISTS (?:taric\.)?([a-z_]+)\s*\(([^;]+)\);/g)) {
      const table_name = match[1];
      for (const field of match[2].matchAll(/(?:^|,)\s*([a-z_]+)\s+(TEXT|INTEGER|BIGINT|BIGSERIAL)\b/gi)) {
        columns.push({ table_name, column_name: field[1], data_type: field[2].toUpperCase() === "TEXT" ? "text" : "bigint" });
      }
    }
  }
  return columns;
}

const passingReport = () => ({
  version: AUTHORITY_RUNTIME_CONFORMANCE_VERSION, passed: true, missing_methods: [], failures: [],
  scenarios: AUTHORITY_RUNTIME_SCENARIOS.map((id) => ({ id, passed: true, evidence: [`test-gate-mechanism:${id}`] })),
});

class ReadOnlyProbe {
  statements = [];
  columns = runtimeColumns();
  schemaVersion = "1.0.0";
  storageFormat = "authority-sql/2";
  authorityId = uuidv7();
  invalidLeaseCount = 0;
  unavailable = false;
  acquired = 0;
  released = 0;

  async connect() {
    this.acquired++;
    return { query: this.query.bind(this), release: () => { this.released++; } };
  }

  async query(text, values = []) {
    this.statements.push({ text, values });
    if (text === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    assert.match(text.trim(), /^SELECT\b/, "runtime readiness cannot execute DDL or writes");
    if (this.unavailable) throw new Error("database password=__PRIVATE__ /srv/private/authority connection failed");
    if (text.includes("information_schema.columns")) return { rows: this.columns };
    if (text.includes("key IN ('schema_version'")) return { rows: [
      { key: "schema_version", value: this.schemaVersion }, { key: "storage_format", value: this.storageFormat }, { key: "authority_id", value: this.authorityId },
    ] };
    if (text.includes("AS committed_seq")) return { rows: [{ committed_seq: "9", projected_seq: "7", indexed_seq: "6" }] };
    if (text.includes("AS invalid")) return { rows: [{ invalid: this.invalidLeaseCount }] };
    throw new Error("unexpected readiness SQL");
  }
}

test("healthy full PostgreSQL persistence remains disabled without executable runtime evidence", async () => {
  const probe = new ReadOnlyProbe();
  const store = new PostgresAuthorityStore(probe, { profile: "multi_host_authority", schema: "isolated_authority" });
  const report = await store.runtimeReadiness();
  assert.equal(report.code, "backend_conformance_failed");
  assert.equal(report.implementation_state, "available");
  assert.equal(report.runtime_state, "disabled");
  assert.equal(report.evidence_state, "failed");
  assert.equal(report.conformance.passed, false);
  assert.equal(report.health.available, true);
  assert.equal(report.health.schema_valid, true);
  assert.equal(report.health.fencing, true);
  assert.equal(report.health.read_seq, 9);
  assert.deepEqual(report.health.watermarks, { committed_seq: 9, projected_seq: 7, indexed_seq: 6 });
  assert.ok(report.domains.every((entry) => entry.persistence_shape === "available" && entry.runtime_evidence === "missing"));
  assert.ok(report.domains.every((entry) => entry.missing_methods.length === 0 && entry.missing_tables.length === 0 && entry.missing_columns.length === 0));
  assert.equal(report.blocker, "runtime_conformance_evidence_required");
  assert.equal(probe.acquired, 1); assert.equal(probe.released, 1);
  assert.equal(probe.statements[0].text, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(probe.statements.at(-1).text, "COMMIT");
  assert.deepEqual(probe.statements.find(({ text }) => text.includes("information_schema.columns")).values, ["isolated_authority"]);
  assert.equal(store.manifest().primitive_state, "uninitialized", "readiness does not migrate the backend");
});

test("passing evidence is accepted only when current schema, methods and lease health also pass", async () => {
  const probe = new ReadOnlyProbe();
  const store = new PostgresAuthorityStore(probe, { profile: "multi_host_authority" });
  const report = passingReport();
  const enabled = await store.runtimeReadiness(report);
  assert.equal(enabled.runtime_state, "enabled"); assert.equal(store.manifest().enabled, true);
  probe.schemaVersion = "obsolete";
  assert.equal((await store.runtimeReadiness(report)).runtime_state, "disabled");
  probe.schemaVersion = "1.0.0"; probe.storageFormat = "obsolete";
  assert.equal((await store.runtimeReadiness(report)).health.schema_valid, false);
  probe.storageFormat = "authority-sql/2"; probe.invalidLeaseCount = 1;
  assert.equal((await store.runtimeReadiness(report)).health.fencing, false);
  probe.invalidLeaseCount = 0; probe.authorityId = "invalid";
  assert.equal((await store.runtimeReadiness(report)).runtime_state, "disabled");
  probe.authorityId = uuidv7();
  store.commitCheckpoint = undefined;
  const incomplete = await store.runtimeReadiness(report);
  assert.equal(incomplete.runtime_state, "disabled");
  assert.ok(incomplete.domains.find((entry) => entry.id === "checkpoint").missing_methods.includes("commitCheckpoint"));
});

test("primitive or incomplete PostgreSQL shape cannot use a passing report to activate", async () => {
  const probe = new ReadOnlyProbe();
  probe.columns = probe.columns.filter((row) => !["proposals", "proposal_versions", "reviews", "artifact_catalog", "checkpoints", "action_intents"].includes(row.table_name));
  const store = new PostgresAuthorityStore(probe, { profile: "multi_host_authority" });
  const report = await store.runtimeReadiness(passingReport());
  assert.equal(report.runtime_state, "disabled");
  assert.equal(report.conformance.passed, false);
  assert.ok(report.domains.find((entry) => entry.id === "proposal").missing_tables.includes("proposals"));
  assert.ok(report.domains.find((entry) => entry.id === "artifact").missing_tables.includes("artifact_catalog"));
  probe.columns = runtimeColumns().filter((row) => row.table_name !== "attempts" || row.column_name !== "generation");
  const fenced = await store.runtimeReadiness(passingReport());
  assert.equal(fenced.health.fencing, false);
  assert.ok(fenced.domains.find((entry) => entry.id === "fencing").missing_columns.includes("attempts.generation"));
});

test("empty or unavailable PostgreSQL produces read-only sanitized failed evidence", async () => {
  const empty = new ReadOnlyProbe(); empty.columns = [];
  const emptyReport = await new PostgresAuthorityStore(empty, { profile: "multi_host_authority" }).runtimeReadiness();
  assert.equal(emptyReport.health.available, true); assert.equal(emptyReport.health.schema_valid, false);
  assert.equal(emptyReport.health.read_seq, undefined); assert.equal(emptyReport.runtime_state, "disabled");
  assert.equal(empty.statements.length, 3, "empty authority is inspected without creating metadata or tables");
  const unavailable = new ReadOnlyProbe(); unavailable.unavailable = true;
  const failed = await new PostgresAuthorityStore(unavailable, { profile: "multi_host_authority" }).runtimeReadiness(passingReport());
  assert.equal(failed.code, "postgresql_unavailable");
  assert.deepEqual(failed.health, { available: false, schema_valid: false, fencing: false });
  assert.equal(unavailable.statements.at(-1).text, "ROLLBACK"); assert.equal(unavailable.released, 1);
  assert.doesNotMatch(JSON.stringify(failed), /__PRIVATE__|password|srv\/private|connection failed/);
  assert.equal(failed.runtime_state, "disabled");
});

test("failed or incomplete runtime evidence stays disabled on a healthy database", async () => {
  const probe = new ReadOnlyProbe();
  const store = new PostgresAuthorityStore(probe, { profile: "multi_host_authority" });
  for (const report of [
    { ...passingReport(), passed: false, failures: ["checkpoint mismatch"] },
    { ...passingReport(), scenarios: passingReport().scenarios.slice(1) },
    { ...passingReport(), scenarios: passingReport().scenarios.map((entry) => entry.id === "lease" ? { ...entry, passed: false } : entry) },
  ]) assert.equal((await store.runtimeReadiness(report)).runtime_state, "disabled");
});
