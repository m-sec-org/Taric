import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityStore } from "../dist/index.js";

test("authority driver reports statement, row, queue, and SQL deltas", async () => {
  const store = new AuthorityStore(":memory:");
  try {
    await store.ready;
    const before = store.sql.metrics();
    assert.equal((await store.sql.get("SELECT 1 AS value")).value, 1);
    assert.equal((await store.sql.all("SELECT 2 AS value UNION ALL SELECT 3 AS value")).length, 2);
    await store.sql.run("INSERT INTO metadata(key,value) VALUES(?,?)", "benchmark-metrics-test", "1");
    const after = store.sql.metrics();
    assert.equal(after.statements - before.statements, 3);
    assert.equal(after.rows_returned - before.rows_returned, 3);
    assert.equal(after.rows_affected - before.rows_affected, 1);
    assert.ok(after.queue_wait_ms - before.queue_wait_ms >= 0);
    assert.ok(after.sql_elapsed_ms - before.sql_elapsed_ms >= 0);
  } finally {
    await store.close();
  }
});

test("opt-in snapshot stage diagnostics preserve the snapshot result", async () => {
  const store = new AuthorityStore(":memory:");
  const engagement_id = "01a00000-0000-7000-8000-000000000001";
  try {
    await store.createRecord({ engagement_id, kind: "claim", proposition: "benchmark fixture", status: "proposed", evidence_refs: [], limitations: [] });
    const regular = await store.snapshot(engagement_id, { includeCandidates: true });
    const stages = [];
    const measured = await store.snapshot(engagement_id, { includeCandidates: true, asOf: regular.read_seq, readTime: regular.read_time, diagnostics: (stage, elapsed_ms) => stages.push({ stage, elapsed_ms }) });
    assert.deepEqual(measured, regular);
    assert.deepEqual(stages.map(({ stage }) => stage), ["snapshot_hydration", "snapshot_filter", "snapshot_sort"]);
    assert.ok(stages.every(({ elapsed_ms }) => Number.isFinite(elapsed_ms) && elapsed_ms >= 0));
  } finally {
    await store.close();
  }
});
