import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { Pool } from "pg";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  PostgresAuthorityStore, createAuthorityRuntimeScenarios, runAuthorityRuntimeConformance,
  buildRuntimeActivationEvidence, buildSharedAuthorityReleaseEvidence, policyDigest,
} from "../packages/core/dist/index.js";

const databaseUrl = process.env.TARIC_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TARIC_TEST_DATABASE_URL is required for live runtime verification");
const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("--output <report.json> is required");
const output = resolve(process.argv[outputIndex + 1]);
const directory = await mkdtemp(join(tmpdir(), "taric-postgresql-conformance-"));
const suffix = randomBytes(6).toString("hex");
const schemas = [`taric_verify_${suffix}`, `taric_verify_restore_${suffix}`];
const administration = new Pool({ connectionString: databaseUrl, max: 2 });
const fixtures = [];
const postgresContainer = process.env.TARIC_TEST_POSTGRES_CONTAINER;
const runContainer = (args, input) => new Promise((accept, reject) => {
  const process_ = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  const stdout = []; let size = 0;
  process_.stdout.on("data", (chunk) => { size += chunk.length; if (size > 128 * 1024 ** 2) process_.kill(); else stdout.push(chunk); });
  // Raw database errors can include paths and connection details. Only the exit
  // outcome enters the saved report; real Core assertions provide diagnostics.
  process_.stderr.resume();
  process_.on("error", reject);
  process_.on("close", (code) => code === 0 ? accept(Buffer.concat(stdout)) : reject(new Error("isolated PostgreSQL backup command failed")));
  process_.stdin.end(input);
});
const verifyDatabaseBackup = async (sourceSchema) => {
  if (!postgresContainer) return { verified: false, state: "not_requested", reason: "set TARIC_TEST_POSTGRES_CONTAINER to verify pg_dump/pg_restore in a disposable target database" };
  assert.match(postgresContainer, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1)); const user = decodeURIComponent(url.username);
  const targetDatabase = `taric_backup_verify_${suffix}`;
  const command = ["exec", "-i", "-e", `PGPASSWORD=${decodeURIComponent(url.password)}`, postgresContainer];
  const connection = ["--host=127.0.0.1", "--port=5432", `--username=${user}`];
  const archive = await runContainer([...command, "pg_dump", ...connection, `--dbname=${database}`, `--schema=${sourceSchema}`, "--format=custom", "--no-owner", "--no-privileges"]);
  await administration.query(`CREATE DATABASE "${targetDatabase}"`);
  let targetPool;
  try {
    await runContainer([...command, "pg_restore", ...connection, `--dbname=${targetDatabase}`, "--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges"], archive);
    url.pathname = `/${targetDatabase}`; targetPool = new Pool({ connectionString: url.toString(), max: 2 });
    const tables = (await administration.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name", [sourceSchema])).rows;
    const evidence = [];
    for (const { table_name: table } of tables) {
      assert.match(table, /^[a-z_]+$/);
      const query = `SELECT row_to_json(t)::text AS row FROM "${sourceSchema}"."${table}" t ORDER BY row_to_json(t)::text`;
      const sourceRows = (await administration.query(query)).rows.map(({ row }) => row);
      const targetRows = (await targetPool.query(query)).rows.map(({ row }) => row);
      assert.deepEqual(targetRows, sourceRows, `database restore differs in ${table}`);
      evidence.push({ table, rows: sourceRows.length, digest: `sha256:${createHash("sha256").update(JSON.stringify(sourceRows)).digest("hex")}` });
    }
    const restored = new PostgresAuthorityStore(targetPool, { profile: "multi_host_authority", schema: sourceSchema, migrate: false });
    await restored.ready;
    const audit = await restored.verifyAudit(); assert.equal(audit.valid, true);
    const doctor = await restored.doctor(); assert.equal(doctor.authority.valid, true);
    await restored.close();
    return { verified: true, kind: "logical_database_dump", scope: "authority_schema", format: "pg_dump_custom", restore: "pg_restore_single_transaction", archive_bytes: archive.length,
      archive_digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      source_sequence: audit.read_seq, recovered_sequence: audit.read_seq, audit_verified: true, authority_verified: true,
      tables: evidence, lease_policy: "isolated restored target remains offline; source writers must be fenced and leases reissued before switching traffic", payload_bytes_included: false };
  } finally {
    await targetPool?.end();
    await administration.query(`DROP DATABASE "${targetDatabase}"`);
  }
};
const fixtureFor = async (schema) => {
  let pool = new Pool({ connectionString: databaseUrl, max: 12 });
  let current = new PostgresAuthorityStore(pool, { profile: "multi_host_authority", schema });
  await current.migrate();
  let closed = false;
  const fixture = {
    get store() { return current; },
    async restart(store) {
      await store.close(); await pool.end();
      pool = new Pool({ connectionString: databaseUrl, max: 12 });
      current = new PostgresAuthorityStore(pool, { profile: "multi_host_authority", schema, migrate: false });
      await current.migrate();
      return current;
    },
    async withAuditFailure(eventType, operation) {
      assert.match(eventType, /^[a-z_.]+$/);
      await administration.query(`CREATE FUNCTION "${schema}".conformance_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='${eventType}' THEN RAISE EXCEPTION 'isolated conformance failure'; END IF; RETURN NEW; END $$`);
      await administration.query(`CREATE TRIGGER conformance_failure BEFORE INSERT ON "${schema}".events FOR EACH ROW EXECUTE FUNCTION "${schema}".conformance_failure()`);
      try { await operation(); }
      finally {
        await administration.query(`DROP TRIGGER IF EXISTS conformance_failure ON "${schema}".events`);
        await administration.query(`DROP FUNCTION IF EXISTS "${schema}".conformance_failure()`);
      }
    },
    async close() { if (closed) return; closed = true; await current.close(); await pool.end(); },
  };
  fixtures.push(fixture);
  return fixture;
};

try {
  const source = await fixtureFor(schemas[0]);
  const scenarios = createAuthorityRuntimeScenarios(source.store, join(directory, "content"), () => fixtureFor(schemas[1]), {
    isolated: true, restart: source.restart, withAuditFailure: source.withAuditFailure,
  });
  const report = await runAuthorityRuntimeConformance(source.store, scenarios);
  for (const scenario of report.scenarios) process.stderr.write(`postgres-runtime: ${scenario.id} ${scenario.passed ? "passed" : "failed"}\n`);
  const readiness = await source.store.runtimeReadiness(report);
  const activation = report.passed && readiness.runtime_state === "enabled" ? buildRuntimeActivationEvidence(report) : null;
  const version = await administration.query("SELECT version() AS version");
  // Additional release metadata comes from an actual independent restore.
  let backupEvidence;
  if (report.passed) {
    const backupEngagement = await source.store.initializeEngagement({ name: "release-backup", scope: { allowed_targets: ["https://conformance.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:release-backup" } });
    const record = await source.store.createRecord({ kind: "claim", engagement_id: backupEngagement.id, proposition: "versioned release restore", status: "proposed", evidence_refs: [], limitations: [] }, "L1");
    const revised = await source.store.compareAndSet(record.id, record.version, { proposition: "versioned release restore revision" });
    const snapshot = await source.store.exportSnapshot(backupEngagement.id);
    const recoverySchema = `taric_verify_release_${suffix}`; schemas.push(recoverySchema);
    const destination = await fixtureFor(recoverySchema);
    const restored = await destination.store.importSnapshot(snapshot);
    // Restore creates pending derived operations. Complete that documented
    // maintenance step before recording the destination's unresolved errors.
    while ((await destination.store.consumeOutbox(1000)).length > 0) { /* drain */ }
    backupEvidence = {
      verified: restored.integrity_verified === true, schema_version: snapshot.schema_version,
      source_sequence: snapshot.read_seq, recovered_sequence: restored.recovered_sequence,
      restored_source_sequence: (await destination.store.events()).find((event) => event.event_type === "snapshot.import" && event.payload.snapshot_hash === snapshot.hash)?.payload.source_sequence,
      backup_timestamp: new Date().toISOString(), integrity: snapshot.hash, engagement_id: snapshot.engagement_id,
      provenance_verified: (await destination.store.verifyAudit()).valid,
      revisions_verified: (await destination.store.get(revised.id))?.version === revised.version,
      unresolved_errors: (await destination.store.doctor()).errors,
    };
  }
  const ids = { "storage-conformance": "audit_outbox", "backup-restore": "backup_restore", "lease-fencing": "fencing", "reader-pin": "pinned_read", "failure-recovery": "artifact" };
  const release = buildSharedAuthorityReleaseEvidence({
    profile: "multi_host_authority", backend: "postgresql",
    authority_service: { configured: true, available: readiness.health.available, shared: true, count: 1 },
    runtime_conformance: report, conformance: { passed: report.passed, suite_version: report.version, evidence: report.scenarios.flatMap((scenario) => scenario.evidence) },
    backup: backupEvidence, policy_digest: policyDigest(),
    gates: Object.entries(ids).map(([id, scenarioId]) => { const scenario = report.scenarios.find((item) => item.id === scenarioId); return { id, passed: scenario?.passed === true, evidence: scenario?.evidence ?? [] }; }),
  });
  const database_backup = report.passed ? await verifyDatabaseBackup(schemas[0]) : { verified: false, state: "blocked_by_conformance" };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ ...(activation ?? {}), version: activation?.version ?? "taric-runtime-activation/1", backend: "postgresql", generated_at: new Date().toISOString(), postgres_version: version.rows[0].version, runtime_conformance: report, readiness, shared_authority: release, database_backup }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, passed: report.passed, runtime_state: readiness.runtime_state, release_state: release.status, scenarios: report.scenarios.length })}\n`);
  if (!report.passed || readiness.runtime_state !== "enabled" || !release.enabled || postgresContainer && !database_backup.verified) process.exitCode = 1;
} finally {
  for (const fixture of fixtures) await fixture.close().catch(() => undefined);
  for (const schema of schemas) await administration.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await administration.end();
  await rm(directory, { recursive: true, force: true });
}
