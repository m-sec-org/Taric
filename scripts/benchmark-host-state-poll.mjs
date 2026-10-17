import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../packages/core/dist/index.js";

const percentile = (values, ratio) => values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * ratio) - 1)] ?? 0;
const stats = (values) => ({ sample_count: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) });
const writerSource = `
import { AuthorityStore, uuidv7 } from "./packages/core/dist/index.js";
const store = new AuthorityStore(process.env.TARIC_DB);
try {
  const record = await store.createRecord({
    engagement_id: process.env.TARIC_ENGAGEMENT_ID,
    kind: "claim",
    proposition: "cross-process host.state polling fixture",
    status: "proposed",
    evidence_refs: [],
    limitations: ["synthetic polling benchmark"],
  }, "L1");
  process.stdout.write(JSON.stringify({ record_id: record.id, committed_at: new Date().toISOString() }) + "\\n");
} finally { await store.close(); }
`;

async function runWriter(database, engagementId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", writerSource], {
      cwd: process.cwd(),
      env: { ...process.env, TARIC_DB: database, TARIC_ENGAGEMENT_ID: engagementId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`writer exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (cause) { reject(cause); }
    });
  });
}

const directory = mkdtempSync(join(tmpdir(), "taric-host-state-poll-"));
const database = join(directory, "authority.sqlite");
const contentRoot = join(directory, "content");
const engagementId = uuidv7();
const host = createPrincipal("host", "poll-benchmark-host", engagementId);
let store = new AuthorityStore(database);
let service = await createCoreService(store, contentRoot);
const calls = [];
const failures = [];
const discovery = [];
let disconnectedAt;
let reconnectedAt;
let notificationsEnabled = false;
const budget = {
  baseline_calls: 10,
  baseline_interval_ms: 20,
  discovery_deadline_ms: 1000,
  reconnect_attempts: 1,
  poll_initial_backoff_ms: 20,
  poll_max_backoff_ms: 250,
};

try {
  await store.initializeEngagement({ name: "host-state polling benchmark", scope: { allowed_targets: ["https://poll.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:polling" } });
  const poll = async () => {
    const started = performance.now();
    const response = await service.dispatch("host.state", host, { engagement_id: engagementId, limit: 100 });
    calls.push(performance.now() - started);
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.data;
  };

  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  for (let index = 0; index < budget.baseline_calls; index++) {
    await poll();
    if (index + 1 < budget.baseline_calls) await delay(budget.baseline_interval_ms);
  }
  const baseline = {
    calls: budget.baseline_calls,
    request_latency: stats(calls),
    cpu_microseconds: process.cpuUsage(cpuBefore),
    rss_delta_bytes: process.memoryUsage().rss - rssBefore,
  };
  const beforeWrite = await poll();
  const writer = await runWriter(database, engagementId);
  const writeObservedAt = performance.now();

  await service.close();
  disconnectedAt = performance.now();
  try { await poll(); } catch (error) { failures.push({ code: error.code ?? "transport_error", message: "injected service restart boundary" }); }
  store = new AuthorityStore(database);
  service = await createCoreService(store, contentRoot);
  reconnectedAt = performance.now();

  let backoff = budget.poll_initial_backoff_ms;
  let observed;
  let discoveryLatencyFromCommitMs;
  const deadline = performance.now() + budget.discovery_deadline_ms;
  while (performance.now() <= deadline) {
    try {
      observed = await poll();
      if (observed.aggregates.l1_pending > beforeWrite.aggregates.l1_pending) {
        discovery.push(performance.now() - writeObservedAt);
        discoveryLatencyFromCommitMs = Date.now() - Date.parse(writer.committed_at);
        break;
      }
    } catch (error) {
      failures.push({ code: error.code ?? "transport_error", message: "poll failed during recovery" });
    }
    await delay(backoff);
    backoff = Math.min(budget.poll_max_backoff_ms, backoff * 2);
  }

  assert.ok(observed?.aggregates.l1_pending > beforeWrite.aggregates.l1_pending, "polling must observe the cross-process commit");
  const discoveryLatency = discoveryLatencyFromCommitMs ?? Number.POSITIVE_INFINITY;
  const result = {
    version: "host-state-poll/1",
    measured_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, notifications_enabled: notificationsEnabled },
    budget,
    baseline,
    cross_process_write: { record_id: writer.record_id, committed_at: writer.committed_at },
    polling: {
      total_calls: calls.length,
      request_latency: stats(calls),
      discovery_latency_from_commit_ms: Number.isFinite(discoveryLatency) ? discoveryLatency : null,
      discovery_latency_from_poll_start_ms: discovery[0] ?? null,
      backoff_final_ms: backoff,
      state: observed.aggregates,
      freshness: observed.freshness,
    },
    recovery: { failures, reconnect_latency_ms: reconnectedAt - disconnectedAt },
    conclusion: {
      discovery_within_budget: discoveryLatency <= budget.discovery_deadline_ms,
      notifications_required: false,
    },
    limitations: ["SQLite single-host fixture", "synthetic claim only", "no real host/MCP resource subscription", "timings are local process measurements"],
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = process.argv.find((value) => value.startsWith("--output="))?.slice("--output=".length);
  if (outputPath) {
    const destination = resolve(outputPath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, serialized);
  }
  process.stdout.write(serialized);
} finally {
  await service.close().catch(() => undefined);
  rmSync(directory, { recursive: true, force: true });
}
