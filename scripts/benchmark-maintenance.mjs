import assert from "node:assert/strict";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../packages/core/dist/index.js";

const percentile = (values, ratio) => values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * ratio) - 1)] ?? 0;
const stats = (values) => ({ sample_count: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) });
const walBytes = (filename) => { try { return statSync(`${filename}-wal`).size; } catch { return 0; } };
const directory = mkdtempSync(join(tmpdir(), "taric-maintenance-benchmark-"));
const filename = join(directory, "authority.sqlite");
const contentRoot = join(directory, "content");
const engagementId = uuidv7();
const operator = createPrincipal("operator", "maintenance-operator", engagementId);
const model = createPrincipal("model", "maintenance-model", engagementId);
const host = createPrincipal("host", "maintenance-host", engagementId);
const store = new AuthorityStore(filename);
const service = await createCoreService(store, contentRoot);
const started = performance.now();
const eventLoop = monitorEventLoopDelay({ resolution: 1 });
eventLoop.enable();
const writeLatency = [];
const maintenanceLatency = [];
const heartbeatLatency = [];
try {
  await store.initializeEngagement({ name: "maintenance benchmark", scope: { allowed_targets: ["https://maintenance.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:maintenance" } });
  for (let index = 0; index < 200; index++) await store.createRecord({ engagement_id: engagementId, kind: "claim", proposition: `maintenance fixture ${index}`, status: "proposed", evidence_refs: [], limitations: [] });
  const workItemId = uuidv7();
  await store.commit({ id: workItemId, engagement_id: engagementId, kind: "work_item", title: "maintenance heartbeat fixture", status: "queued", acceptance_criteria: ["maintenance stays read-only"] }, "L2");
  const claimed = await service.dispatch("work.claim", host, { engagement_id: engagementId, work_item_id: workItemId, agent_id: "maintenance-agent", ttl_ms: 120000 });
  assert.equal(claimed.ok, true);
  const readonlyOperations = [
    ["audit.verify", {}],
    ["audit.doctor", {}],
    ["audit.reconcile", { action: "preview" }],
    ["snapshot.export", { engagement_id: engagementId }],
  ];
  const historyBeforeReadOnly = (await store.events()).length;
  for (const [operation, request] of readonlyOperations) {
    const result = await service.dispatch(operation, operator, request);
    assert.equal(result.ok, true, `${operation} should succeed`);
  }
  const historyAfterReadOnly = (await store.events()).length;
  assert.equal(historyAfterReadOnly, historyBeforeReadOnly, "read-only maintenance must not append authority history");
  const before = store.sql.metrics();
  const walBefore = walBytes(filename);
  const reads = [
    ["audit.verify", {}],
    ["audit.doctor", {}],
    ["audit.reconcile", { action: "preview" }],
    ["snapshot.export", { engagement_id: engagementId }],
  ];
  const maintenance = reads.map(async ([operation, request]) => {
    const begin = performance.now();
    const result = await service.dispatch(operation, operator, request);
    maintenanceLatency.push(performance.now() - begin);
    assert.equal(result.ok, true, `${operation} should be read-only and successful`);
    return { operation, data: result.data };
  });
  const writes = Array.from({ length: 25 }, async (_, index) => {
    const begin = performance.now();
    const record = await store.createRecord({ engagement_id: engagementId, kind: "claim", proposition: `concurrent write ${index}`, status: "proposed", evidence_refs: [], limitations: [] });
    writeLatency.push(performance.now() - begin);
    return record;
  });
  const heartbeats = Array.from({ length: 10 }, async () => {
    const begin = performance.now();
    const response = await service.dispatch("work.renew", host, { engagement_id: engagementId, work_run_id: claimed.data.run_id, generation: claimed.data.generation, ttl_ms: 120000 });
    heartbeatLatency.push(performance.now() - begin);
    assert.equal(response.ok, true, "heartbeat renewal should coexist with maintenance reads");
    return response.data;
  });
  const [maintenanceResults] = await Promise.all([Promise.all(maintenance), Promise.all(writes), Promise.all(heartbeats)]);
  const after = store.sql.metrics();
  const doctor = maintenanceResults.find((result) => result.operation === "audit.doctor")?.data;
  const verify = maintenanceResults.find((result) => result.operation === "audit.verify")?.data;
  assert.equal(verify.valid, true);
  assert.equal(doctor.watermarks.committed_seq, doctor.read_seq);
  assert.equal(doctor.watermarks.committed_seq >= doctor.watermarks.projected_seq, true);
  const denied = await service.dispatch("audit.reconcile", model, { action: "replay" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "authorization_error");
  await new Promise((resolve) => setTimeout(resolve, 20));
  eventLoop.disable();
  const result = {
    version: "maintenance-concurrency/1",
    measured_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    fixture: { engagement_id: engagementId, initial_records: 203, concurrent_writes: writes.length, concurrent_heartbeats: 10, maintenance_operations: reads.map(([operation]) => operation) },
    elapsed_ms: performance.now() - started,
    writes: { latency: stats(writeLatency) },
    maintenance: { latency: stats(maintenanceLatency), fixed_watermarks: doctor.watermarks, read_seq: doctor.read_seq, readonly_history_before: historyBeforeReadOnly, readonly_history_after: historyAfterReadOnly },
    heartbeats: { latency: stats(heartbeatLatency) },
    sql: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]])),
    wal: { before_bytes: walBefore, after_bytes: walBytes(filename) },
    event_loop_delay_ms: { sample_count: Number(eventLoop.count), mean: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : null, p95: Number.isFinite(eventLoop.percentile(95)) ? eventLoop.percentile(95) / 1e6 : null, max: Number.isFinite(eventLoop.max) ? eventLoop.max / 1e6 : null },
    authorization: { model_reconcile_replay: denied.error.code },
    conclusion: { read_only_maintenance_separated_from_repair: true, no_background_worker: true },
    limitations: ["single-host SQLite fixture", "one concurrent batch", "does not establish a production SLA"],
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = process.argv.find((value) => value.startsWith("--output="))?.slice("--output=".length);
  if (outputPath) { const destination = resolve(outputPath); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, output); }
  process.stdout.write(output);
} finally {
  eventLoop.disable();
  await service.close().catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}
