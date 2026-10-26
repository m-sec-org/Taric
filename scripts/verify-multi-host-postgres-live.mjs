import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { PostgresAuthorityStore, runtimeImplementationDigest } from "../packages/core/dist/index.js";

const databaseUrl = process.env.TARIC_TEST_DATABASE_URL;
const activationPath = process.env.TARIC_RUNTIME_CONFORMANCE;
const outputIndex = process.argv.indexOf("--output");
if (!databaseUrl) throw new Error("TARIC_TEST_DATABASE_URL is required");
if (!activationPath) throw new Error("TARIC_RUNTIME_CONFORMANCE must point to a current passing activation report");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("--output <report.json> is required");

const activation = JSON.parse(await (await import("node:fs/promises")).readFile(activationPath, "utf8"));
if (activation?.version !== "taric-runtime-activation/1" || activation?.backend !== "postgresql" || activation?.implementation_digest !== runtimeImplementationDigest() || activation?.runtime_conformance?.passed !== true) {
  throw new Error("a passing activation report matching the current implementation is required");
}

const outputPath = resolve(process.argv[outputIndex + 1]);
const suffix = randomBytes(6).toString("hex");
const databaseName = `taric_mh_${suffix}`;
const directory = await mkdtemp(`${tmpdir()}/taric-multi-host-`);
const admin = new Pool({ connectionString: databaseUrl, max: 2 });
const baseUrl = new URL(databaseUrl);
const workerModule = "file:///workspace/packages/core/dist/index.js";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dockerContext = process.env.TARIC_DOCKER_CONTEXT ?? "orbstack";
const dockerNetwork = process.env.TARIC_TEST_DOCKER_NETWORK ?? "taric-authority_default";
const postgresContainer = process.env.TARIC_TEST_POSTGRES_CONTAINER ?? "taric-authority-postgres-1";
const nodeImage = process.env.TARIC_TEST_NODE_IMAGE ?? "node:22-alpine";
const execFileAsync = promisify(execFile);
const workers = new Set();
let databaseCreated = false;

function workerSource() {
  return `
    import { createInterface } from "node:readline";
    import { readFile } from "node:fs/promises";
    import { openRuntimeService, createPrincipal } from ${JSON.stringify(workerModule)};
    let service;
    try {
      process.env.TARIC_DATABASE_URL = (await readFile(process.env.TARIC_DATABASE_URL_FILE, "utf8")).trim();
      service = await openRuntimeService({ env: process.env, config: {}, home: process.env.TARIC_TEST_HOME });
      process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
    } catch {
      process.stdout.write(JSON.stringify({ type: "startup-error" }) + "\\n");
      process.exit(2);
    }
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const command = JSON.parse(line);
      if (command.type === "close") {
        await service.close();
        process.stdout.write(JSON.stringify({ type: "closed" }) + "\\n");
        break;
      }
      const principal = createPrincipal("host", process.env.TARIC_HOST_ID, command.engagement_id);
      const response = await service.dispatch(command.operation, principal, command.request);
      process.stdout.write(JSON.stringify({ type: "response", response }) + "\\n");
    }
    if (service) await service.close();
  `;
}

async function startWorker(hostId) {
  const contentRoot = resolve(directory, `content-${hostId}`);
  await mkdir(contentRoot, { recursive: true, mode: 0o700 });
  const workerUrl = new URL(`/${databaseName}`, baseUrl);
  workerUrl.hostname = postgresContainer;
  workerUrl.port = "5432";
  const workerDatabaseUrlPath = resolve(directory, "database-url");
  await writeFile(workerDatabaseUrlPath, workerUrl.toString(), { mode: 0o600 });
  const containerName = `taric-mh-${suffix}-${hostId}`;
  const child = spawn("docker", [
    "--context", dockerContext, "run", "--rm", "--interactive", "--name", containerName,
    "--network", dockerNetwork, "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    "--volume", `${repositoryRoot}:/workspace:ro`, "--volume", `${contentRoot}:/content:rw`,
    "--volume", `${workerDatabaseUrlPath}:/verification/database-url:ro`,
    "--volume", `${resolve(activationPath)}:/verification/runtime-activation.json:ro`,
    "--workdir", "/workspace", "--env", "TARIC_AUTHORITY_PROFILE=multi_host_authority",
    "--env", "TARIC_DATABASE_URL_FILE=/verification/database-url",
    "--env", `TARIC_HOST_ID=${hostId}`, "--env", "TARIC_LEASE_MODE=server_side",
    "--env", "TARIC_RUNTIME_CONFORMANCE=/verification/runtime-activation.json",
    "--env", "TARIC_CONTENT_ROOT=/content", "--env", `TARIC_PRINCIPAL_ID=${hostId}`,
    "--env", "TARIC_PRINCIPAL_ROLE=host", "--env", "TARIC_TEST_HOME=/verification",
    nodeImage, "node", "--input-type=module", "-e", workerSource(),
  ], { cwd: repositoryRoot, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const queued = [];
    const waiters = [];
    let exited;
    const exitPromise = new Promise((resolveExit) => { exited = resolveExit; });
    lines.on("line", (line) => {
      let value;
      try { value = JSON.parse(line); } catch { value = { type: "invalid-output" }; }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value); else queued.push(value);
    });
    child.on("error", () => exited({ code: null, signal: null }));
    child.on("exit", (code, signal) => exited({ code, signal }));
    const next = async (timeoutMs = 15_000) => {
      if (queued.length) return queued.shift();
      let waiter;
      let timer;
      try {
        return await Promise.race([
          new Promise((resolveLine, rejectLine) => { waiter = { resolve: resolveLine, reject: rejectLine }; waiters.push(waiter); }),
          exitPromise.then(() => { throw new Error("multi-host worker exited before responding"); }),
          new Promise((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(new Error("multi-host worker response timed out")), timeoutMs); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (waiter) {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
        }
      }
    };
    const ready = next();
    const worker = {
      hostId,
      containerName,
      child,
      next,
      async send(command) { child.stdin.write(`${JSON.stringify(command)}\n`); return await next(); },
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          const response = await this.send({ type: "close" });
          if (response?.type !== "closed") throw new Error("container did not close cleanly");
        } catch { await this.crash(); }
        await exitPromise;
        workers.delete(this);
      },
      async crash() {
        if (child.exitCode === null && child.signalCode === null) {
          await execFileAsync("docker", ["--context", dockerContext, "kill", containerName], { cwd: repositoryRoot, timeout: 10_000 }).catch(() => undefined);
        }
        await exitPromise;
        workers.delete(this);
      },
    };
    workers.add(worker);
    const message = await ready;
    if (message?.type !== "ready") {
      await worker.crash();
      throw new Error("multi-host worker failed runtime activation");
    }
    return worker;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

try {
  await execFileAsync("docker", ["--context", dockerContext, "network", "inspect", dockerNetwork], { cwd: repositoryRoot, timeout: 10_000 });
  await execFileAsync("docker", ["--context", dockerContext, "inspect", postgresContainer], { cwd: repositoryRoot, timeout: 10_000 });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  const targetUrl = new URL(`/${databaseName}`, baseUrl).toString();
  const seedPool = new Pool({ connectionString: targetUrl, max: 2 });
  const seed = new PostgresAuthorityStore(seedPool, { profile: "multi_host_authority" });
  await seed.migrate();
  const engagement = await seed.initializeEngagement({ name: "isolated two-container live verification", scope: { allowed_targets: ["https://multi-host.invalid"], excluded_targets: [], rules_of_engagement_ref: "test:multi-host-live" } });
  const workItem = await seed.createRecord({ engagement_id: engagement.id, kind: "work_item", title: "shared PostgreSQL lease race", status: "queued", acceptance_criteria: ["exactly one active owner"] }, "L2");
  const version = await seedPool.query("SELECT current_setting('server_version_num')::int AS version_num");
  await seed.close();
  await seedPool.end();

  const hostA = await startWorker("host-a");
  const hostB = await startWorker("host-b");
  const leaseMs = 5_000;
  const claimResults = await Promise.all([hostA, hostB].map((worker) => worker.send({
    operation: "work.claim", engagement_id: engagement.id,
    request: { engagement_id: engagement.id, work_item_id: workItem.id, host_id: worker.hostId, agent_id: `agent-${worker.hostId}`, ttl_ms: leaseMs },
  })));
  const winnerIndex = claimResults.findIndex((entry) => entry?.type === "response" && entry.response?.ok === true);
  assert.notEqual(winnerIndex, -1, "one independent host container must claim the shared work item");
  assert.equal(claimResults.filter((entry) => entry?.type === "response" && entry.response?.ok === true).length, 1, "a shared lease must have exactly one active owner");
  const winner = [hostA, hostB][winnerIndex];
  const recovering = winner === hostA ? hostB : hostA;
  const claimed = claimResults[winnerIndex].response.data;
  assert.equal(claimResults[1 - winnerIndex].response?.ok, false, "the competing host container must be fenced from a second claim");

  await winner.crash();
  await sleep(Math.max(0, Date.parse(claimed.lease_expires_at) - Date.now()) + 100);
  const reclaimedMessage = await recovering.send({
    operation: "work.reclaim", engagement_id: engagement.id,
    request: { engagement_id: engagement.id, work_run_id: claimed.run_id, agent_id: `agent-${recovering.hostId}`, ttl_ms: 30_000 },
  });
  assert.equal(reclaimedMessage?.type, "response");
  assert.equal(reclaimedMessage.response?.ok, true, "the surviving host container must reclaim the expired run");
  const reclaimed = reclaimedMessage.response.data;
  assert.equal(reclaimed.generation, claimed.generation + 1, "reclaim must advance the fencing generation");
  assert.equal(reclaimed.owner.host_id, recovering.hostId);

  const restarted = await startWorker(winner.hostId);
  const staleRenewal = await restarted.send({
    operation: "work.renew", engagement_id: engagement.id,
    request: { engagement_id: engagement.id, work_run_id: claimed.run_id, generation: claimed.generation, ttl_ms: 30_000 },
  });
  assert.equal(staleRenewal?.type, "response");
  assert.equal(staleRenewal.response?.ok, false, "a restarted host container must not renew an older generation");
  const currentRenewal = await recovering.send({
    operation: "work.renew", engagement_id: engagement.id,
    request: { engagement_id: engagement.id, work_run_id: claimed.run_id, generation: reclaimed.generation, ttl_ms: 30_000 },
  });
  assert.equal(currentRenewal.response?.ok, true, "the current owner must renew the reclaimed generation");

  const report = {
    version: "taric-multi-host-container-verification/1",
    generated_at: new Date().toISOString(),
    implementation_digest: activation.implementation_digest,
    postgres_major_version: Math.floor(version.rows[0].version_num / 10_000),
    topology: { independent_host_containers: 2, independent_node_processes: 2, distinct_host_ids: true, shared_postgresql_authority: true, separate_content_roots: true, physical_machines: 1, docker_network: dockerNetwork },
    checks: [
      { id: "concurrent_claim_single_owner", passed: true, loser_code: claimResults[1 - winnerIndex].response.error?.code },
      { id: "crashed_owner_reclaimed_after_expiry", passed: true, generation: reclaimed.generation },
      { id: "restarted_old_generation_fenced", passed: true, error_code: staleRenewal.response.error?.code },
      { id: "current_generation_renewed", passed: true },
    ],
    limitations: ["The two host containers ran on one OrbStack workstation and shared the Compose bridge network with PostgreSQL; this does not test separate physical machines or network partition/reconnect."],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, passed: true, checks: report.checks.length, postgres_major_version: report.postgres_major_version, host_containers: 2 })}\n`);
} finally {
  for (const worker of [...workers]) await worker.crash().catch(() => undefined);
  if (databaseCreated) {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
  }
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
