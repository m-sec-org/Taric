import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const runStartedAt = new Date().toISOString();
const runStartedMono = performance.now();
const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "taric-proxy-restart-"));
const db = join(dir, "authority.sqlite");
const socket = join(dir, "core.sock");
const content = join(dir, "content");
const token = "p".repeat(48);
const sessionId = "proxy-restart-session";
const env = { ...process.env, TARIC_DB: db, TARIC_CONTENT_ROOT: content, TARIC_CORE_SOCKET: socket, TARIC_ADAPTER_TOKEN: token, TARIC_PRINCIPAL_ID: "benchmark-host", TARIC_SESSION_ID: sessionId };
const cli = join(process.cwd(), "packages/cli/dist/bin.js");
const bunClient = join(process.cwd(), "scripts/adapter-rpc-bun-client.mjs");
const measured = { calls: 0, cli_calls: 0, rpc_calls: 0, retries: 0, waits_ms: [], restart_ms: [], proxy_instances: [], samples: [], outcomes: [] };
const measureCall = async (transport, operation, request, invoke) => {
  const started = performance.now();
  const response = JSON.parse((await invoke()).stdout);
  const elapsed_ms = performance.now() - started;
  measured.calls++;
  measured[transport === "bun_rpc" ? "rpc_calls" : "cli_calls"]++;
  measured.waits_ms.push(elapsed_ms);
  measured.samples.push({ transport, operation, elapsed_ms, request, response });
  return response;
};
const runCli = (operation, request) => measureCall("node_cli", operation, request, async () => {
  try { return await exec(process.execPath, [cli, operation, JSON.stringify(request)], { env: { ...env, TARIC_PRINCIPAL_ID: "benchmark-operator", TARIC_PRINCIPAL_ROLE: "operator" } }); }
  catch (cause) {
    if (cause.code === 1 && cause.stderr && JSON.parse(cause.stderr).ok === false) return { stdout: cause.stderr };
    throw cause;
  }
});
const runBun = (operation, request) => measureCall("bun_rpc", operation, request, () => exec("bun", [bunClient], { env: { ...env, TARIC_ENGAGEMENT_ID: request.engagement_id, TARIC_RPC_OPERATION: operation, TARIC_RPC_REQUEST: JSON.stringify(request), TARIC_RPC_ALLOW_ERROR: "1" } }));
const waitForSocket = async (child) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`proxy exited ${child.exitCode ?? child.signalCode}`);
    try {
      const info = await stat(socket);
      if (info.isSocket() && (info.mode & 0o777) === 0o600) return info;
    } catch { /* wait for the listener and its permission change */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("proxy socket did not appear");
};
const start = async () => {
  const child = spawn(process.execPath, [cli, "proxy"], { env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.resume();
  const info = await waitForSocket(child);
  measured.proxy_instances.push({ pid: child.pid, socket_mode: `0${(info.mode & 0o777).toString(8)}` });
  return child;
};
const stop = async (child) => { if (child.exitCode !== null || child.signalCode !== null) return; const done = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await done; };
let proxy;
const restart = async () => {
  await stop(proxy);
  const started = performance.now();
  proxy = await start();
  measured.restart_ms.push(performance.now() - started);
  assert.notEqual(measured.proxy_instances.at(-1).pid, measured.proxy_instances.at(-2).pid);
};
try {
  const initialized = await runCli("engagement.init", { name: "proxy restart benchmark", scope: { allowed_targets: ["https://proxy.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:proxy" } });
  assert.equal(initialized.ok, true);
  const engagement_id = initialized.data.id;
  env.TARIC_ENGAGEMENT_ID = engagement_id;
  const binding = await runCli("artifact.session.bind", { engagement_id, session_id: sessionId, root: join(content, sessionId), mode: "host-session" });
  assert.equal(binding.ok, true);
  const item = await runCli("proposal.submit", { engagement_id, subject_type: "work_item", expected_version: 0, content: { schema_version: "1.0.0", engagement_id, kind: "work_item", title: "proxy restart fixture", status: "queued", acceptance_criteria: ["restart"] } });
  const admitted = await runCli("admission.evaluate", { engagement_id, proposal_id: item.data.id, expected_version: 0, policy_digest: `sha256:${"a".repeat(64)}` });
  assert.equal(admitted.ok, true);
  const work_item_id = admitted.data.record.id;
  proxy = await start();
  const key = `proxy-restart-${work_item_id}`;
  const proposalRequest = { engagement_id, subject_type: "claim", expected_version: 0, idempotency_key: key, content: { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "persistent proxy retry", status: "proposed", evidence_refs: [], limitations: [] } };
  const first = await runBun("proposal.submit", proposalRequest);
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "pending");
  const admittedClaim = await runCli("admission.evaluate", { engagement_id, proposal_id: first.data.id, expected_version: 0, policy_digest: `sha256:${"a".repeat(64)}` });
  assert.equal(admittedClaim.ok, true);
  assert.equal(admittedClaim.data.ok, true);
  assert.equal(admittedClaim.data.record.trust_level, "L1");
  const canonical = admittedClaim.data.record;
  const run = await runBun("work.claim", { engagement_id, work_item_id, agent_id: "proxy-agent", ttl_ms: 60000 });
  assert.equal(run.ok, true);
  assert.equal(run.data.task_session_ref, sessionId);
  const query = () => runBun("query", { engagement_id, kind: "claim", include_candidates: true });
  const beforeRestart = await query();
  assert.equal(beforeRestart.ok, true);
  assert.equal(beforeRestart.data.records.find((record) => record.id === canonical.id)?.version, canonical.version);
  await restart();
  const recovered = await query();
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.data.records, beforeRestart.data.records);
  assert.equal(recovered.data.read_seq, beforeRestart.data.read_seq);
  const retry = await runBun("proposal.submit", proposalRequest); measured.retries++;
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.data, first.data, "idempotent retry after proxy restart must return the original result");
  const conflict = await runBun("proposal.submit", { ...proposalRequest, content: { ...proposalRequest.content, proposition: "changed late retry" } });
  assert.equal(conflict.ok, false); assert.equal(conflict.error.code, "idempotency_conflict"); measured.outcomes.push("changed_retry_rejected");
  const renewed = await runBun("work.renew", { engagement_id, work_run_id: run.data.run_id, generation: run.data.generation, ttl_ms: 60000 });
  assert.equal(renewed.ok, true, "the persisted run must renew after proxy restart");
  const stale = await runBun("work.renew", { engagement_id, work_run_id: run.data.run_id, generation: run.data.generation - 1, ttl_ms: 60000 });
  assert.equal(stale.ok, false); assert.equal(stale.error.code, "stale_version"); measured.outcomes.push("stale_generation_renewal_rejected");

  // Both updates observe the same canonical version; only one may advance it.
  const updates = [];
  for (const proposition of ["first canonical revision", "competing canonical revision"]) {
    const update = await runBun("proposal.submit", { engagement_id, subject_type: "claim", target_id: canonical.id, expected_version: canonical.version, content: { ...proposalRequest.content, proposition } });
    assert.equal(update.ok, true);
    updates.push(update.data);
  }
  const revision = await runCli("admission.evaluate", { engagement_id, proposal_id: updates[0].id, expected_version: canonical.version, policy_digest: `sha256:${"a".repeat(64)}` });
  assert.equal(revision.ok, true);
  assert.equal(revision.data.ok, true);
  assert.equal(revision.data.record.version, canonical.version + 1);
  const beforeConflict = await query();
  assert.equal(beforeConflict.ok, true);
  const competing = await runCli("admission.evaluate", { engagement_id, proposal_id: updates[1].id, expected_version: canonical.version, policy_digest: `sha256:${"a".repeat(64)}` });
  assert.equal(competing.ok, true);
  assert.equal(competing.data.ok, false);
  assert.equal(competing.data.reason, "base version mismatch");
  assert.equal(competing.data.proposal.status, "rejected");
  const afterConflict = await query();
  assert.equal(afterConflict.ok, true);
  assert.equal(afterConflict.data.read_seq, beforeConflict.data.read_seq + 1, "rejected admission adds its audit event");
  assert.deepEqual(afterConflict.data.records, beforeConflict.data.records);
  measured.outcomes.push("expected_version_cas_advanced_once", "competing_cas_rejected_with_audit");

  const expiring = await runBun("work.renew", { engagement_id, work_run_id: run.data.run_id, generation: run.data.generation, ttl_ms: 1 });
  assert.equal(expiring.ok, true);
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, Date.parse(expiring.data.lease_expires_at) - Date.now() + 1)));
  const beforeLate = await query();
  assert.equal(beforeLate.ok, true);
  const lateRequest = { ...proposalRequest, idempotency_key: `${key}-late`, work_run_id: run.data.run_id, generation: run.data.generation, content: { ...proposalRequest.content, proposition: "expired Attempt result" } };
  const late = await runBun("proposal.submit", lateRequest);
  assert.equal(late.ok, true);
  assert.equal(late.data.status, "rejected");
  assert.equal(late.data.run_attribution.attempt_id, run.data.attempt_ref);
  assert.equal(late.data.run_attribution.session_id, sessionId);
  const afterLate = await query();
  assert.equal(afterLate.ok, true);
  assert.deepEqual(afterLate.data.records, beforeLate.data.records);
  assert.equal(afterLate.data.read_seq, beforeLate.data.read_seq + 1, "quarantine adds one attributable event");
  await restart();
  const lateRetry = await runBun("proposal.submit", lateRequest); measured.retries++;
  assert.equal(lateRetry.ok, true);
  assert.deepEqual(lateRetry.data, late.data);
  const afterLateRetry = await query();
  assert.equal(afterLateRetry.ok, true);
  assert.equal(afterLateRetry.data.read_seq, afterLate.data.read_seq);
  assert.deepEqual(afterLateRetry.data.records, afterLate.data.records);
  const proposals = await runBun("proposal.list", { engagement_id, page_size: 100 });
  assert.equal(proposals.ok, true);
  assert.equal(proposals.data.next_cursor, undefined);
  assert.equal(proposals.data.proposals.filter((proposal) => proposal.id === late.data.id && proposal.status === "rejected").length, 1);
  measured.outcomes.push("expired_attempt_quarantined", "late_retry_after_restart_has_no_new_commit");
  const outputPath = process.argv.find((value) => value.startsWith("--output="))?.slice("--output=".length);
  const output = { version: "proxy-restart/2", started_at: runStartedAt, measured_at: new Date().toISOString(), harness_elapsed_ms: performance.now() - runStartedMono, runtime: { node: process.version, bun: (await exec("bun", ["--version"])).stdout.trim(), platform: process.platform, arch: process.arch }, authority: { persistent_during_run: true, storage: "temporary SQLite file retained while the proxy and its embedded Core authority reopen across two process restarts", socket_mode: measured.proxy_instances[0].socket_mode }, measured: { ...measured, call_scope: "all isolated operator Node CLI calls and fixed-host Bun RPC calls; wait includes client process startup and Core response", commands: [`node scripts/benchmark-proxy-restart.mjs${outputPath ? ` --output=${outputPath}` : ""}`, "node packages/cli/dist/bin.js proxy", "bun scripts/adapter-rpc-bun-client.mjs"] }, conclusion: { public_entrypoints_only: true, canonical_read_after_restart: true, idempotency_after_restart: true, run_state_survives_proxy_restart: true, stale_generation_rejected: true, expected_version_cas: true, expired_proposal_quarantined: true, late_retry_after_restart_has_no_new_commit: true }, limitations: ["local Unix socket", "single-host SQLite", "timings are one synthetic run", "implementation labor-hours were not instrumented", "host-session isolation with explicit run attribution on the late proposal; not universal run-bound fencing", "does not certify external credentials or network failure"] };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (outputPath) { const { mkdirSync } = await import("node:fs"); const { dirname, resolve } = await import("node:path"); mkdirSync(dirname(resolve(outputPath)), { recursive: true }); (await import("node:fs")).writeFileSync(resolve(outputPath), serialized); }
  process.stdout.write(serialized);
} finally { if (proxy) await stop(proxy).catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
