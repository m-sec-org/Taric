import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PostgresAuthorityStore, ContractValidationError, uuidv7 } from "../dist/index.js";

class MockPostgres {
  statements = [];
  records = new Map();
  idempotency = new Map();
  sequence = 0;
  display = 1;
  failOn;
  destinationOccupied = false;

  async query(text, values = []) {
    this.statements.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (text.includes("CREATE SCHEMA") || text.includes("CREATE TABLE") || text.includes("CREATE INDEX") || text.includes("INSERT INTO \"taric\".metadata")) return { rows: [], rowCount: 1 };
    if (text.includes("FROM \"taric\".metadata WHERE key='schema_version'")) return { rows: [{ value: "1.0.0" }], rowCount: 1 };
    if (text.includes("COALESCE((SELECT max(commit_seq)")) return { rows: [{ committed_seq: 0, projected_seq: 0, indexed_seq: 0 }], rowCount: 1 };
    if (text.includes("FROM \"taric\".idempotency WHERE key=")) {
      const prior = this.idempotency.get(values[0]);
      return { rows: prior ? [prior] : [], rowCount: prior ? 1 : 0 };
    }
    if (text.includes("FROM \"taric\".records WHERE id=")) {
      const record = this.records.get(values[0]);
      return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
    }
    if (text.includes("FROM \"taric\".records WHERE engagement_id=")) return { rows: this.destinationOccupied ? [{ exists: 1 }] : [], rowCount: this.destinationOccupied ? 1 : 0 };
    if (text.includes("nextval('") && text.includes("display_sequence")) return { rows: [{ value: this.display++ }], rowCount: 1 };
    if (text.includes("SELECT hash FROM \"taric\".events")) return { rows: [], rowCount: 0 };
    if (text.includes("UPDATE \"taric\".metadata SET value=to_jsonb((value #>> '{}')::bigint + 1)")) return { rows: [{ value: ++this.sequence }], rowCount: 1 };
    if (text.includes("INSERT INTO \"taric\".records")) {
      if (this.failOn === "record") throw new Error("injected database failure");
      const body = JSON.parse(values[6]);
      this.records.set(values[0], { version: body.version, display_id: body.display_id, body });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO \"taric\".events")) return { rows: [], rowCount: 1 };
    if (text.includes("INSERT INTO \"taric\".record_versions") || text.includes("INSERT INTO \"taric\".outbox") || text.includes("INSERT INTO \"taric\".operation_markers")) return { rows: [], rowCount: 1 };
    if (text.includes("INSERT INTO \"taric\".idempotency")) {
      this.idempotency.set(values[0], { result: JSON.parse(values[5]), operation: values[1], principal: values[2], engagement_id: values[3], request_hash: values[4] });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in mock: ${text}`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : canonical(item)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function backupFor(engagementId) {
  const record = { schema_version: "1.0.0", created_at: "2026-10-12T00:00:00.000Z", provenance: { host_id: "host-a", producer_id: "host-a", source_kind: "host" }, id: engagementId, engagement_id: engagementId, kind: "engagement", version: 1, trust_level: "L2", display_id: "TAR-000001", name: "test" };
  const payload = { format: "taric-postgresql-json", schema_version: "1.0.0", core_version: "1.0.0", engagement_id: engagementId, source_sequence: 4, read_seq: 4, committed_seq: 4, projected_seq: 4, backup_timestamp: "2026-10-12T00:00:00.000Z", provenance: { backend: "postgresql", schema: "taric" }, records: [record] };
  return { ...payload, hash: `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}` };
}

test("PostgreSQL adapter requires explicit profile and migrates only when selected", async () => {
  const client = new MockPostgres();
  assert.throws(() => new PostgresAuthorityStore(client), ContractValidationError);
  assert.equal(client.statements.length, 0);
  const store = new PostgresAuthorityStore(client, { profile: "multi_host_authority" });
  assert.equal(store.manifest().enabled, false);
  await store.migrate();
  assert.equal(store.manifest().enabled, true);
  const migration = client.statements.find((statement) => statement.includes("CREATE TABLE IF NOT EXISTS \"taric\".events"));
  assert.match(migration, /event_id text UNIQUE/);
  assert.match(migration, /display_id text UNIQUE/);
  assert.match(migration, /commit_sequence/);
  await store.close();
});

test("record event, outbox, marker, display sequence and idempotency share one transaction", async () => {
  const client = new MockPostgres();
  const store = new PostgresAuthorityStore(client, { profile: "multi_host_authority" });
  const id = uuidv7();
  const record = { id, engagement_id: uuidv7(), kind: "claim", proposition: "stable" };
  const first = await store.commit(record, "L1", "same-key", { principal: "host-a", engagement_id: record.engagement_id });
  const second = await store.commit(record, "L1", "same-key", { principal: "host-a", engagement_id: record.engagement_id });
  assert.deepEqual(second, first);
  assert.match(first.display_id, /^TAR-000001$/);
  assert.equal(first.commit_seq, 1);
  const recordInsert = client.statements.findIndex((statement) => statement.includes("INSERT INTO \"taric\".records"));
  const eventInsert = client.statements.findIndex((statement) => statement.includes("INSERT INTO \"taric\".events"));
  const outboxInsert = client.statements.findIndex((statement) => statement.includes("INSERT INTO \"taric\".outbox"));
  const markerInsert = client.statements.findIndex((statement) => statement.includes("INSERT INTO \"taric\".operation_markers"));
  assert.ok(recordInsert < eventInsert && eventInsert < outboxInsert && outboxInsert < markerInsert);
  assert.equal(client.statements.filter((statement) => statement.includes("INSERT INTO \"taric\".records")).length, 1, "idempotent replay does not write another record");
  await store.close();
});

test("database failure rolls back the PostgreSQL write transaction", async () => {
  const client = new MockPostgres();
  const store = new PostgresAuthorityStore(client, { profile: "multi_host_authority" });
  client.failOn = "record";
  await assert.rejects(store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim" }), /injected database failure/);
  assert.equal(client.statements.at(-1), "ROLLBACK");
  assert.equal(client.statements.includes("COMMIT"), false);
  await store.close();
});

test("backup metadata is operator-visible and invalid restore is rejected before destination writes", async () => {
  const client = new MockPostgres();
  const store = new PostgresAuthorityStore(client, { profile: "multi_host_authority" });
  const diagnostics = await store.diagnostics();
  assert.equal(diagnostics.backend, "postgresql");
  assert.equal(diagnostics.backup_format, "taric-postgresql-json");
  assert.equal(diagnostics.restore_mode, "atomic_verified_target");
  await assert.rejects(store.restore({ format: "taric-postgresql-json" }), /metadata is incomplete/);
  assert.equal(client.statements.some((statement) => statement.includes("INSERT INTO \"taric\".records")), false);
  await store.close();
});

test("verified restore rejects a conflicting destination without inserting records", async () => {
  const client = new MockPostgres();
  client.destinationOccupied = true;
  const store = new PostgresAuthorityStore(client, { profile: "multi_host_authority" });
  await assert.rejects(store.restore(backupFor(uuidv7())), /destination Engagement already contains records/);
  assert.equal(client.statements.some((statement) => statement.includes("INSERT INTO \"taric\".records")), false);
  await store.close();
});

