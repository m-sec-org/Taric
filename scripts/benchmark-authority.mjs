import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, platform, arch, cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { AuthorityStore, buildContextPack, uuidv7 } from "../packages/core/dist/index.js";

const argument = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
const peakRss = () => process.resourceUsage().maxRSS * 1024;
async function measure(operation) {
  global.gc?.();
  const before = process.memoryUsage();
  const started = performance.now();
  const data = await operation();
  const elapsed_ms = performance.now() - started;
  return { data, elapsed_ms, rss_before_bytes: before.rss, rss_after_bytes: process.memoryUsage().rss, peak_process_rss_bytes: peakRss() };
}
async function measuredResult(operation, summary) {
  const { data, ...metrics } = await measure(operation);
  return { ...metrics, ...summary(data) };
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
      const fixture_import = await measuredResult(() => store.importSnapshot({ ...payload, hash: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}` }), (result) => ({ read_seq: result.recovered_sequence, record_count: result.imported_records, method: "validated_snapshot_import" }));
      const latency = [];
      const samples = 100;
      const duration = await measure(async () => {
        for (let index = 0; index < samples; index++) {
          const started = performance.now();
          await store.createRecord({ engagement_id, kind: "claim", proposition: `authority-scale-v1 claim ${index}`, status: "proposed", evidence_refs: [], limitations: [] });
          latency.push(performance.now() - started);
        }
      });
      const admission = [];
      for (let index = 0; index < samples; index++) {
        const started = performance.now();
        const proposal = await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: { schema_version: "1.0.0", kind: "claim", engagement_id, created_at: new Date().toISOString(), provenance: { host_id: "benchmark", producer_id: "benchmark", source_kind: "model" }, proposition: `admission-scale-v1 claim ${index}`, status: "proposed", evidence_refs: [], limitations: [] } });
        assert.equal((await store.admitProposal(proposal.id, "sha256:" + "0".repeat(64), { expectedBaseVersion: 0 })).ok, true);
        admission.push(performance.now() - started);
      }
      const sequence = await store.maintenanceRead(async (watermarks) => watermarks.read_seq);
      const { data: _data, ...seedMetrics } = duration;
      process.stdout.write(JSON.stringify({ engagement_id, read_seq: sequence, fixture_count: size, direct_mutation_count: samples, admission_count: samples, fixture_import, commit: { ...seedMetrics, sample_count: samples, p50_ms: percentile(latency, 0.5), p95_ms: percentile(latency, 0.95) }, proposal_to_l1: { sample_count: samples, p50_ms: percentile(admission, 0.5), p95_ms: percentile(admission, 0.95), peak_process_rss_bytes: peakRss() } }));
    } else {
      const engagement_id = argument("engagement", "");
      const read_seq = Number(argument("sequence", "0"));
      if (phase === "list") {
        const continuation = [];
        const input = { engagement_id, as_of: read_seq, include_candidates: true, kind: "claim", page_size: 1000, principal_id: "benchmark" };
        const first = await measure(() => store.recordsPage(input));
        let count = first.data.records.length;
        const ids = new Set(first.data.records.map((record) => record.id));
        let cursor = first.data.next_cursor;
        while (cursor) {
          const page = await measure(() => store.recordsPage({ ...input, cursor }));
          assert.equal(page.data.read_seq, read_seq);
          for (const record of page.data.records) { assert.equal(ids.has(record.id), false); ids.add(record.id); }
          count += page.data.records.length;
          continuation.push(page.elapsed_ms);
          cursor = page.data.next_cursor;
        }
        assert.equal(count, size + 200);
        const { data: _data, ...firstMetrics } = first;
        process.stdout.write(JSON.stringify({ read_seq, record_count: count, first_page: firstMetrics, continuation: { page_count: continuation.length, p50_ms: percentile(continuation, 0.5), p95_ms: percentile(continuation, 0.95), peak_process_rss_bytes: peakRss() } }));
      } else if (phase === "snapshot") {
        process.stdout.write(JSON.stringify(await measuredResult(() => store.snapshot(engagement_id, { asOf: read_seq, includeCandidates: true }), (snapshot) => ({ read_seq: snapshot.read_seq, record_count: snapshot.records.length, serialized_bytes: Buffer.byteLength(JSON.stringify(snapshot)) }))));
      } else if (phase === "export") {
        process.stdout.write(JSON.stringify(await measuredResult(() => store.exportSnapshot(engagement_id, read_seq), (snapshot) => ({ read_seq: snapshot.read_seq, record_count: snapshot.records.length, serialized_bytes: Buffer.byteLength(JSON.stringify(snapshot)), integrity_hash: snapshot.hash }))));
      } else if (phase === "context") {
        const options = { principalId: "benchmark", readSeq: read_seq, includeCandidates: true, filters: { kind: "claim" }, cursorKeyRoot: join(dirname(filename), "content") };
        const first = await measure(() => buildContextPack(store, engagement_id, 64000, options));
        const { data: firstData, ...firstMetrics } = first;
        const continuations = [];
        let cursor = firstData.cursor;
        const delivered = new Set(firstData.items.map((record) => record.id));
        for (let index = 0; index < 3 && cursor; index++) {
          const page = await measure(() => buildContextPack(store, engagement_id, 64000, { ...options, cursor }));
          for (const record of page.data.items) { assert.equal(delivered.has(record.id), false); delivered.add(record.id); }
          assert.equal(page.data.read_seq, firstData.read_seq);
          const { data, ...metrics } = page;
          continuations.push({ ...metrics, record_count: data.items.length, cursor_bytes: Buffer.byteLength(data.cursor ?? "") });
          cursor = data.cursor;
        }
        process.stdout.write(JSON.stringify({ read_seq: firstData.read_seq, first_page: { ...firstMetrics, record_count: firstData.items.length, cursor_bytes: Buffer.byteLength(firstData.cursor ?? "") }, continuation_sample_count: continuations.length, continuations }));
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
  process.stdout.write(`${JSON.stringify({ version: "authority-scale/1", measured_at: new Date().toISOString(), source_commit, source_digest: `sha256:${source_hash.digest("hex")}`, configuration: { node: process.version, platform: platform(), arch: arch(), cpu_model: cpus()[0]?.model, cpu_count: cpus().length, sqlite: "node:sqlite/WAL", fixture: "authority-scale-v1", admission_fixture: "admission-scale-v1", mutation_sample_count: 100, page_size: 1000, context_character_budget: 64000, memory_scope: "peak_process_rss_bytes includes worker startup validation; phases execute in separate processes", context_continuation_cost: "re-fetches and orders the pinned snapshot; three measured pages, not constant-time" }, samples }, null, 2)}\n`);
}
