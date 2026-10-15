import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { AuthorityStore, uuidv7 } from "../dist/index.js";
import { SqliteAuthorityDriver, PostgresAuthorityDriver } from "../dist/sql-driver.js";

async function withSqlite(operation) {
  const directory = await mkdtemp(join(tmpdir(), "taric-unit-of-work-"));
  const filename = join(directory, "authority.sqlite");
  const driver = new SqliteAuthorityDriver(filename); const store = new AuthorityStore(driver);
  try { await driver.ready; await chmod(filename, 0o600); await operation({ driver, store, mutate: async (sql, values) => { const connection = new DatabaseSync(filename); try { connection.prepare(sql).run(...values); } finally { connection.close(); } } }); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}
async function withPostgres(operation) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.TARIC_TEST_DATABASE_URL, max: 4 });
  const schema = `taric_unit_${randomBytes(7).toString("hex")}`;
  const driver = new PostgresAuthorityDriver(pool, schema); const store = new AuthorityStore(driver);
  try { await driver.ready; await operation({ driver, store, mutate: (sql, values) => pool.query(sql.replaceAll("events", `"${schema}".events`), values) }); }
  finally { await store.close(); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
}
const backends = [["SQLite", withSqlite], ["PostgreSQL", withPostgres]];
for (const [name, fixture] of backends) {
  const live = name === "PostgreSQL" && !process.env.TARIC_TEST_DATABASE_URL;
  test(`${name} corrupt audit blocks writes without extending the chain`, { skip: live ? "TARIC_TEST_DATABASE_URL is required" : false }, async () => {
    await fixture(async ({ store, mutate }) => {
      const engagement_id = uuidv7();
      await store.createRecord({ engagement_id, kind: "claim", proposition: "before corruption" }, "L1");
      await mutate(name === "SQLite" ? "UPDATE events SET hash=? WHERE commit_seq=1" : "UPDATE events SET hash=$1 WHERE commit_seq=1", [`sha256:${"0".repeat(64)}`]);
      assert.equal((await store.verifyAudit()).valid, false);
      const before = await store.events();
      await assert.rejects(store.createRecord({ engagement_id, kind: "claim", proposition: "must not commit" }, "L1"), (error) => error.code === "conflict");
      assert.deepEqual(await store.events(), before);
      assert.equal((await store.list(engagement_id, { includeCandidates: true })).length, 1);
    });
  });
  test(`${name} nested read siblings share a pinned scope without savepoint races`, { skip: live ? "TARIC_TEST_DATABASE_URL is required" : false }, async () => {
    await fixture(async ({ store }) => {
      assert.deepEqual(await store.maintenanceRead(() => Promise.all([
        store.maintenanceRead(() => 1),
        store.maintenanceRead(async () => { await delay(20); return 2; }),
        store.verifyAudit(),
      ])), [1, 2, { valid: true, errors: [], read_seq: 0, watermarks: { committed_seq: 0, projected_seq: 0 } }]);
    });
  });
  test(`${name} nested writer siblings serialize and roll back only their own scope`, { skip: live ? "TARIC_TEST_DATABASE_URL is required" : false }, async () => {
    await fixture(async ({ driver, store }) => {
      const observed = [];
      await driver.transaction("write", async () => {
        const results = await Promise.allSettled([
          driver.transaction("write", async () => {
            observed.push("failed:start");
            await driver.run("INSERT INTO metadata(key,value) VALUES(?,?)", "rollback-sibling", "1");
            await delay(20);
            observed.push("failed:end");
            throw new Error("expected rollback");
          }),
          driver.transaction("write", async () => {
            observed.push("success:start");
            assert.equal(await driver.get("SELECT value FROM metadata WHERE key=?", "rollback-sibling"), undefined);
            await driver.transaction("write", () => driver.run("INSERT INTO metadata(key,value) VALUES(?,?)", "nested-success", "1"));
            observed.push("success:end");
          }),
        ]);
        assert.equal(results[0].status, "rejected"); assert.equal(results[1].status, "fulfilled");
      });
      assert.deepEqual(observed, ["failed:start", "failed:end", "success:start", "success:end"]);
      assert.equal(await driver.get("SELECT value FROM metadata WHERE key=?", "rollback-sibling"), undefined);
      assert.equal((await driver.get("SELECT value FROM metadata WHERE key=?", "nested-success")).value, "1");
      assert.equal((await store.verifyAudit()).valid, true);
      await assert.rejects(store.artifactMutation(async () => {
        await Promise.all([
          store.createRecord({ engagement_id: uuidv7(), kind: "claim", proposition: "a" }, "L1"),
          store.createRecord({ engagement_id: uuidv7(), kind: "claim", proposition: "b" }, "L1"),
        ]);
        throw new Error("outer rollback");
      }), /outer rollback/);
      assert.equal((await store.events()).length, 0);
    });
  });
  test(`${name} a rejected writer group drains siblings before rolling its parent back`, { skip: live ? "TARIC_TEST_DATABASE_URL is required" : false }, async () => {
    await fixture(async ({ driver, store }) => {
      const observed = [];
      await assert.rejects(driver.transaction("write", () => Promise.all([
        driver.transaction("write", async () => {
          observed.push("failed");
          throw new Error("expected first failure");
        }),
        driver.transaction("write", async () => {
          await delay(20);
          await driver.run("INSERT INTO metadata(key,value) VALUES(?,?)", "late-sibling", "1");
          observed.push("drained");
        }),
      ])), /expected first failure/);
      assert.deepEqual(observed, ["failed", "drained"]);
      assert.equal(await driver.get("SELECT value FROM metadata WHERE key=?", "late-sibling"), undefined);
      await store.createRecord({ engagement_id: uuidv7(), kind: "claim", proposition: "new transaction remains usable" }, "L1");
      assert.equal((await store.verifyAudit()).valid, true);
    });
  });
  test(`${name} host errors require the active run owner, Engagement, Attempt and unexpired generation`, { skip: live ? "TARIC_TEST_DATABASE_URL is required" : false }, async () => {
    await fixture(async ({ driver, store }) => {
      const engagement_id = uuidv7();
      const work = await store.createRecord({ engagement_id, kind: "work_item", title: "host error fence", status: "queued", acceptance_criteria: ["only active owner may report"] }, "L1");
      const run = await store.claimWorkRun({ work_item_id: work.id, engagement_id, host_id: "current-host", agent_id: "agent", ttl_ms: 60_000 });
      const input = { engagement_id, host_id: "current-host", work_run_id: run.run_id, generation: run.generation, error_ref: "error:current" };
      const accepted = await store.recordHostError(input);
      assert.equal(accepted.work_run_id, run.run_id);
      const unchanged = async (operation, code) => {
        const before = await store.events();
        await assert.rejects(operation(), (error) => error.code === code);
        assert.deepEqual(await store.events(), before);
      };
      await unchanged(() => store.recordHostError({ ...input, engagement_id: uuidv7() }), "authorization_error");
      await unchanged(() => store.recordHostError({ ...input, work_run_id: uuidv7() }), "authorization_error");
      await unchanged(() => store.recordHostError({ ...input, host_id: "other-host" }), "stale_version");
      await unchanged(() => store.recordHostError({ ...input, generation: undefined }), "stale_version");
      await unchanged(() => store.recordHostError({ ...input, generation: Number(run.generation) + 1 }), "stale_version");
      await driver.run("UPDATE attempts SET owner_host=? WHERE attempt_id=?", "other-host", run.attempt_ref);
      await unchanged(() => store.recordHostError(input), "stale_version");
      await driver.run("UPDATE attempts SET owner_host=? WHERE attempt_id=?", "current-host", run.attempt_ref);
      await driver.run("UPDATE attempts SET lease_expires_at=? WHERE attempt_id=?", "2000-01-01T00:00:00.000Z", run.attempt_ref);
      await unchanged(() => store.recordHostError(input), "stale_version");
      await driver.run("UPDATE work_runs SET lease_expires_at=? WHERE run_id=?", "2000-01-01T00:00:00.000Z", run.run_id);
      await unchanged(() => store.recordHostError(input), "stale_version");
      const reclaimed = await store.reclaimWorkRun(run.run_id, "replacement-host", "replacement-agent", 60_000);
      await unchanged(() => store.recordHostError(input), "stale_version");
      const replacement = { ...input, host_id: "replacement-host", generation: reclaimed.generation };
      await store.recordHostError(replacement);
      await store.transitionWorkRun(run.run_id, reclaimed.generation, "replacement-host", "failed");
      await unchanged(() => store.recordHostError(replacement), "stale_version");
      const withoutRun = await store.recordHostError({ engagement_id, host_id: "detached-host", error_ref: "error:without-run" });
      assert.equal(withoutRun.host_id, "detached-host");
      assert.equal((await store.verifyAudit()).valid, true);
    });
  });
}

test("SQLite detects audit tampering through its own connection after a cached write", async () => {
  await withSqlite(async ({ driver, store }) => {
    const engagement_id = uuidv7();
    await store.createRecord({ engagement_id, kind: "claim", proposition: "first" }, "L1");
    await store.createRecord({ engagement_id, kind: "claim", proposition: "second" }, "L1");
    await driver.run("UPDATE events SET hash=? WHERE commit_seq=1", `sha256:${"f".repeat(64)}`);
    const before = await store.events();
    await assert.rejects(store.createRecord({ engagement_id, kind: "claim", proposition: "must fail closed" }, "L1"), (error) => error.code === "conflict");
    assert.deepEqual(await store.events(), before);
    assert.equal((await store.verifyAudit()).valid, false);
  });
});
