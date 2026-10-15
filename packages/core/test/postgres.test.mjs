import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, PostgresAuthorityStore, ContractValidationError, POSTGRES_MIGRATIONS, AUTHORITY_BACKEND_METHODS, uuidv7 } from "../dist/index.js";

test("PostgreSQL uses the shared complete Core method surface without startup queries", async () => {
  let queries = 0;
  const queryable = { async query() { queries++; throw new Error("unexpected startup mutation"); } };
  const store = new PostgresAuthorityStore(queryable, { profile: "multi_host_authority", schema: "isolated_contract" });
  assert.ok(store instanceof AuthorityStore, "SQL adapters share the same governance implementation");
  for (const method of AUTHORITY_BACKEND_METHODS) assert.equal(typeof store[method], "function", method);
  assert.equal(queries, 0);
  assert.equal(store.manifest().runtime_state, "disabled");
  assert.equal(store.manifest().primitive_state, "uninitialized");
  await store.close();
  assert.equal(queries, 0);
});

test("invalid PostgreSQL profile and schema fail before any database access", () => {
  const queryable = { async query() { throw new Error("must not query"); } };
  assert.throws(() => new PostgresAuthorityStore(queryable, { profile: "single_host_sqlite" }), ContractValidationError);
  assert.throws(() => new PostgresAuthorityStore(queryable, { profile: "multi_host_authority", schema: 'target"; DROP SCHEMA public' }), ContractValidationError);
});

test("selected PostgreSQL migration failure rolls back and never advertises readiness", async () => {
  const statements = [];
  const store = new PostgresAuthorityStore({ async query(sql) {
    statements.push(sql);
    if (sql.includes("information_schema.columns")) return { rows: [] };
    if (sql.includes("CREATE TABLE IF NOT EXISTS records")) throw new Error("injected migration failure");
    return { rows: [] };
  } }, { profile: "multi_host_authority", schema: "isolated_rollback" });
  await assert.rejects(store.migrate(), /injected migration failure/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(store.manifest().primitive_state, "uninitialized");
  assert.equal(store.manifest().runtime_state, "disabled");
  await store.close();
});

test("shared SQL migrations declare every runtime persistence domain", () => {
  const sql = POSTGRES_MIGRATIONS.map((migration) => migration.sql).join("\n");
  for (const table of ["proposals", "proposal_versions", "reviews", "object_refs", "checkpoints", "action_intents", "artifact_sessions", "artifact_catalog", "artifact_chunks", "artifact_publications", "artifact_idempotency", "work_runs", "attempts", "events", "outbox", "record_versions", "reader_pins"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.doesNotMatch(sql, /AUTOINCREMENT|jsonb/);
  assert.match(sql, /display_id.*UNIQUE|UNIQUE INDEX.*records_display_id_unique/);
  assert.match(sql, /storage_format/);
});

test("invalid shared backup is rejected before PostgreSQL initialization or mutation", async () => {
  const source = new AuthorityStore();
  let queries = 0;
  const destination = new PostgresAuthorityStore({ async query() { queries++; throw new Error("must not initialize for invalid input"); } }, { profile: "multi_host_authority" });
  try {
    const engagement = await source.initializeEngagement({ name: "valid backup source", scope: { allowed_targets: ["https://restore.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:restore-fixture" } });
    const backup = await source.exportSnapshot(engagement.id);
    await assert.rejects(destination.restore({ ...backup, hash: `sha256:${"0".repeat(64)}` }), (error) => error.code === "validation_error");
    await assert.rejects(destination.restore({ ...backup, schema_version: "99.0.0" }), (error) => error.code === "unsupported_schema_version");
    assert.equal(queries, 0);
    assert.equal(destination.manifest().runtime_state, "disabled");
  } finally { await source.close(); await destination.close(); }
});

test("closing a PostgreSQL adapter preserves its operator-owned pool", async () => {
  let ended = false;
  const store = new PostgresAuthorityStore({ async query() { return { rows: [] }; }, async end() { ended = true; } }, { profile: "multi_host_authority" });
  await store.close();
  assert.equal(ended, false);
});

