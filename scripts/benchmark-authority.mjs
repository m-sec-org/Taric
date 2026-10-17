import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch, cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { AuthorityStore, buildContextPack, uuidv7 } from "../packages/core/dist/index.js";

const argument = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
const peakRss = () => process.resourceUsage().maxRSS * 1024;
const sqlMetrics = (store) => store.sql.metrics();
const metricDelta = (before, after) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
const walBytes = (filename) => existsSync(`${filename}-wal`) ? statSync(`${filename}-wal`).size : 0;
function distribution(values) { return { sample_count: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) }; }
async function measure(operation) {
  global.gc?.();
  const before = process.memoryUsage();
  const started = performance.now();
  const data = await operation();
  const elapsed_ms = performance.now() - started;
  return { data, elapsed_ms, rss_before_bytes: before.rss, rss_after_bytes: process.memoryUsage().rss, peak_process_rss_bytes: peakRss() };
}
async function measurePhase(store, filename, operation) {
  const beforeMetrics = sqlMetrics(store);
  const wal_before_bytes = walBytes(filename);
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const measured = await measure(operation);
  await new Promise((resolve) => setTimeout(resolve, 5));
  loop.disable();
  const afterMetrics = sqlMetrics(store);
  const delta = metricDelta(beforeMetrics, afterMetrics);
  const eventLoopSamples = Number(loop.count);
  return {
    ...measured,
    timing: distribution([measured.elapsed_ms]),
    sql: delta,
    application_processing_ms: Math.max(0, measured.elapsed_ms - delta.sql_elapsed_ms - delta.queue_wait_ms),
    wal_before_bytes,
    wal_after_bytes: walBytes(filename),
    event_loop_delay_ms: { sample_count: eventLoopSamples, mean: eventLoopSamples && Number.isFinite(loop.mean) ? loop.mean / 1e6 : null, p95: eventLoopSamples && Number.isFinite(loop.percentile(95)) ? loop.percentile(95) / 1e6 : null, max: eventLoopSamples && Number.isFinite(loop.max) ? loop.max / 1e6 : null }
  };
}
function serializationMetrics(value) {
  const started = performance.now();
  const encoded = JSON.stringify(value);
  return { elapsed_ms: performance.now() - started, bytes: Buffer.byteLength(encoded) };
}
const phase = argument("phase", undefined);
if (phase) {
  const filename = argument("authority", "");
  const size = Number(argument("size", "0"));
  const store = new AuthorityStore(filename);
  try {
    if (phase === "seed") {
      const engagement_id = uuidv7();
      const scope_id = uuidv7();
      const created_at = new Date().toISOString();
      const provenance = { host_id: "benchmark", producer_id: "benchmark", source_kind: "host" };
      const records = [
        { id: engagement_id, schema_version: "1.0.0", engagement_id, created_at, provenance, kind: "engagement", name: "authority-scale-v1", status: "active", scope_ref: scope_id, trust_level: "L2", version: 1 },
        { id: scope_id, schema_version: "1.0.0", engagement_id, created_at, provenance, kind: "scope", allowed_targets: ["https://benchmark.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:authorized", trust_level: "L2", version: 1 },
        ...Array.from({ length: size }, (_, index) => ({ id: uuidv7(), schema_version: "1.0.0", engagement_id, created_at, provenance, kind: "claim", proposition: `authority-scale-v1 claim ${index}`, status: "proposed", evidence_refs: [], limitations: [], trust_level: "L1", version: 1 }))
      ].map((record, index) => ({ ...record, display_id: `TAR-${String(index + 1).padStart(6, "0")}` }));
      const payload = { schema_version: "1.0.0", core_version: "1.0.0", engagement_id, read_seq: records.length, committed_seq: records.length, projected_seq: 0, format: "taric-native-json", records };
      const fixture_import = await measurePhase(store, filename, () => store.importSnapshot({ ...payload, hash: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}` }));
      const fixture_import_summary = { read_seq: fixture_import.data.recovered_sequence, record_count: fixture_import.data.imported_records, method: "validated_snapshot_import" };
      const historyRevisions = 25;
      let churned = await store.get(records[2].id);
      for (let index = 0; index < historyRevisions; index++) {
        const { commit_seq: _commit_seq, ...record } = churned;
        churned = await store.commit({ ...record, proposition: `authority-scale-v1 high-churn revision ${index}` }, "L1", undefined, undefined, true, Number(churned.version));
      }
      const secondaryEngagementCount = 3;
      const secondaryRecordCount = 20;
      const secondaryEngagements = [];
      for (let engagementIndex = 0; engagementIndex < secondaryEngagementCount; engagementIndex++) {
        const other = await store.initializeEngagement({ name: `authority-scale-v1-secondary-${engagementIndex}`, scope: { allowed_targets: ["https://secondary.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:authorized-secondary" } });
        for (let recordIndex = 0; recordIndex < secondaryRecordCount; recordIndex++) await store.createRecord({ engagement_id: other.id, kind: "claim", proposition: `secondary engagement ${engagementIndex} claim ${recordIndex}`, status: "proposed", evidence_refs: [], limitations: [] });
        secondaryEngagements.push({ engagement_id: other.id, record_count: secondaryRecordCount + 2 });
      }
      const latency = [];
      const samples = 100;
      const duration = await measurePhase(store, filename, async () => {
        for (let index = 0; index < samples; index++) {
          const started = performance.now();
          await store.createRecord({ engagement_id, kind: "claim", proposition: `authority-scale-v1 claim ${index}`, status: "proposed", evidence_refs: [], limitations: [] });
          latency.push(performance.now() - started);
        }
      });
      const admission = [];
      const proposalDuration = await measurePhase(store, filename, async () => {
        for (let index = 0; index < samples; index++) {
          const started = performance.now();
          const proposal = await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: { schema_version: "1.0.0", kind: "claim", engagement_id, created_at: new Date().toISOString(), provenance: { host_id: "benchmark", producer_id: "benchmark", source_kind: "model" }, proposition: `admission-scale-v1 claim ${index}`, status: "proposed", evidence_refs: [], limitations: [] } });
          assert.equal((await store.admitProposal(proposal.id, "sha256:" + "0".repeat(64), { expectedBaseVersion: 0 })).ok, true);
          admission.push(performance.now() - started);
        }
      });
      const sequence = await store.maintenanceRead(async (watermarks) => watermarks.read_seq);
      const { data: _data, ...seedMetrics } = duration;
      const { data: _imported, ...fixtureImportMetrics } = fixture_import;
      const { data: _proposals, ...proposalMetrics } = proposalDuration;
      process.stdout.write(JSON.stringify({ engagement_id, read_seq: sequence, fixture_count: size, engagement_count: 1 + secondaryEngagementCount, secondary_engagements: secondaryEngagements, high_churn_record_id: records[2].id, high_churn_revision_count: historyRevisions, direct_mutation_count: samples, admission_count: samples, fixture_import: { ...fixtureImportMetrics, ...fixture_import_summary }, commit: { ...seedMetrics, sample_count: samples, p50_ms: percentile(latency, 0.5), p95_ms: percentile(latency, 0.95) }, proposal_to_l1: { ...proposalMetrics, sample_count: samples, p50_ms: percentile(admission, 0.5), p95_ms: percentile(admission, 0.95) } }));
    } else {
      const engagement_id = argument("engagement", "");
      const read_seq = Number(argument("sequence", "0"));
      if (phase === "list") {
        const continuation = [];
        const input = { engagement_id, as_of: read_seq, include_candidates: true, kind: "claim", page_size: 1000, principal_id: "benchmark" };
        const first = await measurePhase(store, filename, () => store.recordsPage(input));
        let count = first.data.records.length;
        const ids = new Set(first.data.records.map((record) => record.id));
        let cursor = first.data.next_cursor;
        while (cursor) {
          const page = await measurePhase(store, filename, () => store.recordsPage({ ...input, cursor }));
          assert.equal(page.data.read_seq, read_seq);
          for (const record of page.data.records) { assert.equal(ids.has(record.id), false); ids.add(record.id); }
          count += page.data.records.length;
          continuation.push({ ...page, serialization: serializationMetrics(page.data) });
          cursor = page.data.next_cursor;
        }
        assert.equal(count, size + 200);
        const { data: firstData, ...firstMetrics } = first;
        process.stdout.write(JSON.stringify({ read_seq, record_count: count, first_page: { ...firstMetrics, serialization: serializationMetrics(firstData) }, continuation: { ...distribution(continuation.map((item) => item.elapsed_ms)), page_count: continuation.length, peak_process_rss_bytes: peakRss(), samples: continuation.map(({ data: _page, ...metrics }) => metrics) } }));
      } else if (phase === "snapshot") {
        const stageSamples = {};
        const result = await measurePhase(store, filename, () => store.snapshot(engagement_id, { asOf: read_seq, includeCandidates: true, diagnostics: (stage, elapsed_ms) => (stageSamples[stage] ??= []).push(elapsed_ms) }));
        const { data, ...metrics } = result;
        process.stdout.write(JSON.stringify({ ...metrics, read_seq: data.read_seq, record_count: data.records.length, stages: Object.fromEntries(Object.entries(stageSamples).map(([stage, values]) => [stage, distribution(values)])), serialization: serializationMetrics(data) }));
      } else if (phase === "export") {
        const result = await measurePhase(store, filename, () => store.exportSnapshot(engagement_id, read_seq));
        const { data, ...metrics } = result;
        process.stdout.write(JSON.stringify({ ...metrics, read_seq: data.read_seq, record_count: data.records.length, serialization: serializationMetrics(data), integrity_hash: data.hash }));
      } else if (phase === "context") {
        const stageSamples = {};
        const options = { principalId: "benchmark", readSeq: read_seq, includeCandidates: true, filters: { kind: "claim" }, scanBudget: 256, cursorKeyRoot: join(dirname(filename), "content"), diagnostics: (stage, elapsed_ms) => (stageSamples[stage] ??= []).push(elapsed_ms) };
        const first = await measurePhase(store, filename, () => buildContextPack(store, engagement_id, 64000, options));
        const { data: firstData, ...firstMetrics } = first;
        const continuations = [];
        let cursor = firstData.cursor;
        const delivered = new Set(firstData.items.map((record) => record.id));
        if (firstData.read_stats) {
          assert.ok(firstData.read_stats.scanned_rows <= options.scanBudget);
          assert.ok(firstData.read_stats.returned_rows <= options.scanBudget);
        }
        for (let index = 0; index < 3 && cursor; index++) {
          const page = await measurePhase(store, filename, () => buildContextPack(store, engagement_id, 64000, { ...options, cursor }));
          for (const record of page.data.items) { assert.equal(delivered.has(record.id), false); delivered.add(record.id); }
          assert.equal(page.data.read_seq, firstData.read_seq);
          const { data, ...metrics } = page;
          if (data.read_stats) {
            assert.ok(data.read_stats.scanned_rows <= options.scanBudget);
            assert.ok(data.read_stats.returned_rows <= options.scanBudget);
          }
          continuations.push({ ...metrics, record_count: data.items.length, cursor_bytes: Buffer.byteLength(data.cursor ?? ""), read_stats: data.read_stats, serialization: serializationMetrics(data) });
          cursor = data.cursor;
        }
        process.stdout.write(JSON.stringify({ read_seq: firstData.read_seq, first_page: { ...firstMetrics, record_count: firstData.items.length, cursor_bytes: Buffer.byteLength(firstData.cursor ?? ""), read_stats: firstData.read_stats, serialization: serializationMetrics(firstData) }, stages: Object.fromEntries(Object.entries(stageSamples).map(([stage, values]) => [stage, distribution(values)])), continuation_sample_count: continuations.length, continuation_timing: distribution(continuations.map((item) => item.elapsed_ms)), continuations }));
      } else throw new Error("unknown benchmark phase");
    }
  } finally { await store.close(); }
} else {
  const sizes = argument("sizes", "10000,50000").split(",").map(Number);
  assert.ok(sizes.every((size) => Number.isSafeInteger(size) && size > 0));
  const samples = [];
  for (const size of sizes) {
    const directory = mkdtempSync(join(tmpdir(), "taric-authority-benchmark-"));
    const filename = join(directory, "authority.sqlite");
    const run = (phase_, extra = []) => {
      const result = spawnSync(process.execPath, ["--no-warnings", "--expose-gc", fileURLToPath(import.meta.url), `--phase=${phase_}`, `--authority=${filename}`, `--size=${size}`, ...extra], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`benchmark ${phase_} failed: ${result.stderr || result.error?.message || result.stdout}`);
      return JSON.parse(result.stdout);
    };
    try {
      const mutation = run("seed");
      const extra = [`--engagement=${mutation.engagement_id}`, `--sequence=${mutation.read_seq}`];
      samples.push({ fixture_count: size, mutation, list: run("list", extra), snapshot: run("snapshot", extra), export: run("export", extra), context: run("context", extra) });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const source_commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const source_hash = createHash("sha256");
  for (const file of [import.meta.url, ...["store.ts", "context.ts", "cursor-key.ts", "sql-driver.ts", "sql-schema.ts"].map((name) => new URL(`../packages/core/src/${name}`, import.meta.url))]) source_hash.update(readFileSync(typeof file === "string" ? new URL(file) : file));
  const boundedContext = samples.every((sample) => sample.context.first_page.read_stats !== undefined);
  const report = { version: "authority-scale/2", measured_at: new Date().toISOString(), source_commit, source_digest: `sha256:${source_hash.digest("hex")}`, configuration: { node: process.version, platform: platform(), arch: arch(), cpu_model: cpus()[0]?.model, cpu_count: cpus().length, total_memory_bytes: totalmem(), sqlite: "node:sqlite/WAL", fixture: "authority-scale-v1", admission_fixture: "admission-scale-v1", mutation_sample_count: 100, high_churn_history_revisions: 25, engagement_count: 4, secondary_records_per_engagement: 22, page_size: 1000, context_character_budget: 64000, context_scan_budget: boundedContext ? 256 : null, context_read_stats: boundedContext ? "reported and asserted within scan_budget for first and continuation pages" : "not exposed by baseline implementation", sample_statistics: "p50/p95 use nearest-rank; singleton measurements report p50=p95; context continuation timing also reports an aggregate over measured pages", memory_scope: "peak_process_rss_bytes includes worker startup validation; phases execute in separate processes", event_loop_scope: "monitorEventLoopDelay during phase plus a 5 ms timer observation; sample_count zero means no timer tick was observed", wal_scope: "SQLite -wal file size before and after each phase; not checkpointed bytes or disk I/O", context_continuation_cost: boundedContext ? "bounded keyset reads pinned to read_seq; each page reports scanned/returned rows and no full snapshot hydration" : "legacy baseline context path; full read cost is measured without bounded scan statistics" }, samples };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = argument("output", undefined);
  if (outputPath) writeFileSync(outputPath, output, { flag: argument("replace", "false") === "true" ? "w" : "wx" });
  process.stdout.write(output);
}
