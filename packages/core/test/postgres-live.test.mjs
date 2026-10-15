import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { uuidv7, PostgresAuthorityStore } from "../dist/index.js";

const pgModule = await import("pg").catch(() => null);
const databaseUrl = process.env.TARIC_TEST_DATABASE_URL;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("PostgreSQL live shared-authority conformance", async (t) => {
  if (!pgModule || !databaseUrl) return t.skip("set TARIC_TEST_DATABASE_URL and install pg to run live PostgreSQL conformance");

  const pool = new pgModule.Pool({ connectionString: databaseUrl, max: 24 });
  const suffix = randomBytes(5).toString("hex");
  const sourceSchema = `taric_live_${suffix}`;
  const restoreSchema = `taric_restore_${suffix}`;
  const source = new PostgresAuthorityStore(pool, { profile: "multi_host_authority", schema: sourceSchema });
  const restored = new PostgresAuthorityStore(pool, { profile: "multi_host_authority", schema: restoreSchema });
  const hosts = Array.from({ length: 10 }, () => new PostgresAuthorityStore(pool, { profile: "multi_host_authority", schema: sourceSchema, migrate: false }));

  try {
    await source.migrate();
    await restored.migrate();

    const workers = Array.from({ length: 100 }, (_, index) => ({
      id: uuidv7(),
      engagement_id: uuidv7(),
      kind: "claim",
      proposition: `concurrent-${index}`,
    }));
    const committed = await Promise.all(workers.map(async (record, index) => (await hosts[index % hosts.length].commit(record, "L2", `worker-${index}`, { operation: "conformance.commit", principal: `host-${index % 4}`, engagement_id: record.engagement_id }))));
    assert.equal(new Set(committed.map((record) => record.display_id)).size, 100, "display IDs are globally unique");
    assert.equal(new Set(committed.map((record) => record.commit_seq)).size, 100, "event sequences are globally unique");
    assert.deepEqual(committed.map((record) => record.commit_seq).sort((a, b) => a - b), Array.from({ length: 100 }, (_, index) => index + 1));
    assert.equal((await source.events()).length, 100);
    assert.equal((await source.verifyAudit()).valid, true);
    const outboxBatches = await Promise.all(hosts.slice(0, 5).map(async (store) => (await store.consumeOutbox(40))));
    assert.equal(outboxBatches.flat().length, 100);
    assert.equal((await source.doctor()).valid, true);

    const casRecord = await source.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "cas" }, "L2");
    const casAttempts = await Promise.allSettled([
      hosts[0].compareAndSet(casRecord.id, casRecord.version, { proposition: "cas-updated-a" }, "L2"),
      hosts[1].compareAndSet(casRecord.id, casRecord.version, { proposition: "cas-updated-b" }, "L2"),
    ]);
    assert.equal(casAttempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(casAttempts.filter((result) => result.status === "rejected" && result.reason.code === "conflict").length, 1);
    const idempotent = { id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "idempotent" };
    const idempotentResults = await Promise.all([
      hosts[0].commit(idempotent, "L2", "idempotency-key", { principal: "host-a", engagement_id: idempotent.engagement_id }),
      hosts[1].commit(idempotent, "L2", "idempotency-key", { principal: "host-a", engagement_id: idempotent.engagement_id }),
    ]);
    assert.deepEqual(idempotentResults[1], idempotentResults[0]);

    const leaseEngagement = uuidv7();
    const workItem = await source.createRecord({ engagement_id: leaseEngagement, kind: "work_item", title: "live lease fixture", status: "queued", acceptance_criteria: ["one owner"] }, "L2");
    const lease = await source.claimWorkRun({ work_item_id: workItem.id, engagement_id: leaseEngagement, host_id: "host-a", agent_id: "agent-a", ttl_ms: 80 });
    await wait(140);
    const reclaimed = await source.reclaimWorkRun(lease.run_id, "host-b", "agent-b", 60_000);
    assert.equal(reclaimed.generation, lease.generation + 1);
    await assert.rejects(source.renewWorkRun(lease.run_id, lease.generation, "host-a"), /expired or fenced/);
    const renewed = await source.renewWorkRun(lease.run_id, reclaimed.generation, "host-b", 60_000);
    assert.equal(renewed.generation, reclaimed.generation);
    assert.equal((await source.assertLease(lease.run_id, reclaimed.generation, "host-b")).owner.host_id, "host-b");

    const snapshotEngagement = uuidv7();
    await source.commit({ id: snapshotEngagement, engagement_id: snapshotEngagement, kind: "engagement", name: "snapshot" }, "L2");
    const beforePin = await source.commit({ id: uuidv7(), engagement_id: snapshotEngagement, kind: "claim", proposition: "old" }, "L2");
    const pin = await source.pinSnapshot(snapshotEngagement, { includeCandidates: true, ttlMs: 60_000 });
    await source.commit({ id: uuidv7(), engagement_id: snapshotEngagement, kind: "claim", proposition: "new" }, "L2");
    const pinned = await source.snapshot(snapshotEngagement, { snapshotId: pin.snapshot_id, includeCandidates: true });
    assert.equal(pinned.read_seq, pin.read_seq);
    assert.ok(pinned.records.some((record) => record.id === beforePin.id));
    assert.equal(pinned.records.some((record) => record.proposition === "new"), false, "pinned readers do not observe later commits");
    await Promise.all(hosts.slice(0, 5).map(async (store) => (await store.consumeOutbox(40))));
    await source.updateIndexedWatermark((await source.health()).committed_seq);
    assert.equal((await source.health()).indexed_seq, (await source.health()).committed_seq);

    const backupEngagement = (await source.initializeEngagement({ name: "backup", scope: { allowed_targets: ["https://conformance.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:backup-fixture" } })).id;
    await source.createRecord({ engagement_id: backupEngagement, kind: "claim", proposition: "restored", status: "proposed", evidence_refs: [], limitations: [] }, "L2");
    const backup = await source.backup(backupEngagement);
    assert.equal(backup.format, "taric-native-json");
    assert.equal(backup.schema_version, "1.0.0");
    assert.match(backup.hash, /^sha256:[0-9a-f]{64}$/);
    const restoredResult = await restored.restore(backup);
    assert.equal(restoredResult.integrity_verified, true);
    assert.equal(restoredResult.engagement_id, backupEngagement);
    const restoredSnapshot = await restored.snapshot(backupEngagement, { includeCandidates: true });
    assert.deepEqual(restoredSnapshot.records.map((record) => record.id).sort(), backup.records.map((record) => record.id).sort());
    assert.equal((await restored.verifyAudit()).valid, true);

    // Re-open the authority through a new pool after the original pool is closed.
    await pool.end();
    const restartedPool = new pgModule.Pool({ connectionString: databaseUrl, max: 8 });
    const restarted = new PostgresAuthorityStore(restartedPool, { profile: "multi_host_authority", schema: sourceSchema, migrate: false });
    assert.equal((await restarted.health()).backend, "postgresql");
    assert.equal((await restarted.verifyAudit()).valid, true);
    await restartedPool.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
    await restartedPool.query(`DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE`);
    await restartedPool.end();
  } finally {
    // The normal path closes and drops schemas above; this fallback handles
    // assertion failures before the explicit restart check.
    try { await pool.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`); } catch { /* pool may already be closed */ }
    try { await pool.query(`DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE`); } catch { /* pool may already be closed */ }
    try { await pool.end(); } catch { /* preserve the test failure */ }
  }
});
