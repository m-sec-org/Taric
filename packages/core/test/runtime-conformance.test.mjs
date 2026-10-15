import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, PostgresAuthorityStore, AUTHORITY_RUNTIME_SCENARIOS, createAuthorityRuntimeScenarios, runAuthorityRuntimeConformance, createSharedAuthorityRuntime, createCoreService, createPrincipal } from "../dist/index.js";

async function sqliteFixture(directory, label) {
  const filename = join(directory, `${label}.sqlite`);
  let store = new AuthorityStore(filename);
  let closed = false;
  return {
    get store() { return store; },
    async restart(current) {
      await current.close();
      store = new AuthorityStore(filename);
      closed = false;
      return store;
    },
    async withAuditFailure(eventType, operation) {
      assert.match(eventType, /^[a-z_.]+$/);
      const connection = new DatabaseSync(filename);
      try {
        connection.exec(`CREATE TRIGGER conformance_event_failure BEFORE INSERT ON events WHEN NEW.event_type='${eventType}' BEGIN SELECT RAISE(ABORT, 'conformance event failure'); END`);
        await operation();
      } finally {
        connection.exec("DROP TRIGGER IF EXISTS conformance_event_failure");
        connection.close();
      }
    },
    async close() { if (!closed) { closed = true; await store.close(); } },
  };
}

function scenariosFor(source, root, restoreFactory) {
  const checks = createAuthorityRuntimeScenarios(source.store, root, restoreFactory, {
    isolated: true, restart: source.restart, withAuditFailure: source.withAuditFailure,
  });
  assert.deepEqual(Object.keys(checks), AUTHORITY_RUNTIME_SCENARIOS);
  return checks;
}

async function runScenariosSequentially(checks) {
  const evidence = {};
  for (const id of AUTHORITY_RUNTIME_SCENARIOS) {
    evidence[id] = await checks[id]();
    assert.ok(evidence[id].length > 0);
  }
  return evidence;
}

test("SQLite passes all twelve real Core runtime conformance domains", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "taric-runtime-sqlite-"));
  const source = await sqliteFixture(directory, "source");
  let destination;
  try {
    const checks = scenariosFor(source, join(directory, "content"), async () => {
      destination = await sqliteFixture(directory, "destination");
      return destination;
    });
    const evidence = await runScenariosSequentially(checks);
    const report = await runAuthorityRuntimeConformance(source.store, Object.fromEntries(
      AUTHORITY_RUNTIME_SCENARIOS.map((id) => [id, () => evidence[id] ?? []]),
    ));
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.scenarios.length, 12);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime scenario construction requires an explicitly isolated fixture", () => {
  assert.throws(() => createAuthorityRuntimeScenarios({}, "/tmp/unused", async () => ({}), { isolated: false }), /explicitly isolated fixture/);
  assert.throws(() => createAuthorityRuntimeScenarios({}, "/tmp/unused", async () => ({}), { isolated: true }), /real persistence restart/);
  assert.throws(() => createAuthorityRuntimeScenarios({}, "/tmp/unused", async () => ({}), { isolated: true, restart: async () => ({}) }), /database failure injection/);
});

const pgModule = await import("pg").catch(() => null);
const databaseUrl = process.env.TARIC_TEST_DATABASE_URL;

test("live PostgreSQL passes the same twelve real Core runtime conformance domains", async (t) => {
  if (!pgModule || !databaseUrl) return t.skip("set TARIC_TEST_DATABASE_URL and install pg to run live full-runtime conformance");
  const directory = await mkdtemp(join(tmpdir(), "taric-runtime-postgresql-"));
  const suffix = randomBytes(6).toString("hex");
  const schema = `taric_runtime_${suffix}`;
  const destinationSchema = `taric_runtime_restore_${suffix}`;
  const administration = new pgModule.Pool({ connectionString: databaseUrl, max: 2 });
  const fixtures = [];
  const pgFixture = async (targetSchema) => {
    let pool = new pgModule.Pool({ connectionString: databaseUrl, max: 12 });
    let store = new PostgresAuthorityStore(pool, { profile: "multi_host_authority", schema: targetSchema });
    let closed = false;
    await store.migrate();
    const result = {
      get store() { return store; },
      async restart(current) {
        await current.close();
        await pool.end();
        pool = new pgModule.Pool({ connectionString: databaseUrl, max: 12 });
        store = new PostgresAuthorityStore(pool, { profile: "multi_host_authority", schema: targetSchema, migrate: false });
        closed = false;
        return store;
      },
      async withAuditFailure(eventType, operation) {
        assert.match(eventType, /^[a-z_.]+$/);
        await administration.query(`CREATE FUNCTION "${targetSchema}".conformance_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='${eventType}' THEN RAISE EXCEPTION 'conformance event failure'; END IF; RETURN NEW; END $$`);
        await administration.query(`CREATE TRIGGER conformance_event_failure BEFORE INSERT ON "${targetSchema}".events FOR EACH ROW EXECUTE FUNCTION "${targetSchema}".conformance_event_failure()`);
        try { await operation(); }
        finally {
          await administration.query(`DROP TRIGGER IF EXISTS conformance_event_failure ON "${targetSchema}".events`);
          await administration.query(`DROP FUNCTION IF EXISTS "${targetSchema}".conformance_event_failure()`);
        }
      },
      async close() { if (!closed) { closed = true; await store.close(); await pool.end(); } },
    };
    fixtures.push(result);
    return result;
  };
  try {
    const source = await pgFixture(schema);
    const checks = scenariosFor(source, join(directory, "content"), async () => (await pgFixture(destinationSchema)));
    const evidence = await runScenariosSequentially(checks);
    const report = await runAuthorityRuntimeConformance(source.store, Object.fromEntries(
      AUTHORITY_RUNTIME_SCENARIOS.map((id) => [id, () => evidence[id] ?? []]),
    ));
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.scenarios.length, 12);
    // A report is accepted only with read-only schema, sequence and lease health.
    const restarted = await source.restart(source.store);
    const readiness = await restarted.runtimeReadiness(report);
    assert.equal(readiness.health.available, true);
    assert.equal(readiness.health.fencing, true);
    assert.equal(readiness.runtime_state, "enabled", JSON.stringify(readiness));
    const guarded = await createSharedAuthorityRuntime({ backend: restarted, conformance: report,
      async health() {
        const current = await restarted.runtimeReadiness(report);
        return { available: current.runtime_state === "enabled" && current.code === "ready" && current.health.available && current.health.schema_valid, fencing: current.health.fencing, schema_version: "1.0.0" };
      },
      createService: () => createCoreService(restarted, join(directory, "content")),
    });
    assert.equal(guarded.runtime_state, "enabled");
    const initialized = await restarted.initializeEngagement({ name: "isolated health loss", scope: { allowed_targets: ["https://health.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:health-fixture" } });
    const item = await restarted.createRecord({ engagement_id: initialized.id, kind: "work_item", title: "health fence", status: "queued", acceptance_criteria: ["current owner only"] }, "L2");
    const run = await restarted.claimWorkRun({ engagement_id: initialized.id, work_item_id: item.id, host_id: "health-host", agent_id: "health-agent", ttl_ms: 300_000 });
    const before = await restarted.events();
    await administration.query(`UPDATE "${schema}".attempts SET generation=generation+1 WHERE attempt_id=$1`, [run.attempt_ref]);
    try {
      const denied = await guarded.service.dispatch("engagement.init", createPrincipal("operator", "health-operator"), { name: "must not write" });
      assert.equal(denied.error.code, "unavailable_host");
      assert.deepEqual(await restarted.events(), before, "real live fencing loss blocks Core writes without fallback mutation");
      assert.equal((await restarted.runtimeReadiness(report)).runtime_state, "disabled");
    } finally {
      await administration.query(`UPDATE "${schema}".attempts SET generation=generation-1 WHERE attempt_id=$1`, [run.attempt_ref]);
    }
    assert.equal((await restarted.runtimeReadiness(report)).runtime_state, "enabled");
    const stable = await restarted.events();
    await administration.query(`UPDATE "${schema}".metadata SET value='obsolete' WHERE key='schema_version'`);
    try {
      const brokenSchema = await restarted.runtimeReadiness(report);
      assert.equal(brokenSchema.health.schema_valid, false);
      assert.equal(brokenSchema.runtime_state, "disabled");
      const denied = await guarded.service.dispatch("engagement.init", createPrincipal("operator", "schema-operator"), { name: "must not write with stale schema" });
      assert.equal(denied.error.code, "unavailable_host");
      assert.deepEqual(await restarted.events(), stable, "actual schema health loss blocks writes without fallback or mutation");
    } finally {
      await administration.query(`UPDATE "${schema}".metadata SET value='1.0.0' WHERE key='schema_version'`);
    }
    assert.equal((await restarted.runtimeReadiness(report)).runtime_state, "enabled");
    await administration.query(`ALTER TABLE "${schema}".artifact_catalog RENAME TO conformance_unavailable_artifact_catalog`);
    try {
      const missingTable = await restarted.runtimeReadiness(report);
      assert.equal(missingTable.runtime_state, "disabled");
      assert.ok(missingTable.domains.find((domain) => domain.id === "artifact").missing_tables.includes("artifact_catalog"));
      const denied = await guarded.service.dispatch("engagement.init", createPrincipal("operator", "missing-table-operator"), { name: "must not write with missing runtime table" });
      assert.equal(denied.error.code, "unavailable_host");
      assert.deepEqual(await restarted.events(), stable, "missing required table disables runtime before any Core mutation");
    } finally {
      await administration.query(`ALTER TABLE "${schema}".conformance_unavailable_artifact_catalog RENAME TO artifact_catalog`);
    }
    assert.equal((await restarted.runtimeReadiness(report)).runtime_state, "enabled");
  } finally {
    for (const fixture of fixtures) await fixture.close();
    await administration.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administration.query(`DROP SCHEMA IF EXISTS "${destinationSchema}" CASCADE`);
    await administration.end();
    await rm(directory, { recursive: true, force: true });
  }
});
