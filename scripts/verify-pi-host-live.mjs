import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuthorityStore, createCoreService, createPrincipal, createPiExtension } from "../packages/core/dist/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportIndex = process.argv.indexOf("--output");
const packageRoot = process.env.TARIC_PI_HOST_PACKAGE ?? "/tmp/taric-pi-host-probe/node_modules/@earendil-works/pi-coding-agent";
if (reportIndex < 0 || !process.argv[reportIndex + 1]) throw new Error("--output <report.json> is required");
const outputPath = resolve(process.argv[reportIndex + 1]);
const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(packageRoot, "package.json"), "utf8"));
assert.equal(packageJson.name, "@earendil-works/pi-coding-agent");
assert.equal(packageJson.version, "1.4.0");
const binary = resolve(packageRoot, "dist/bundle/cli.js");
const version = (await execFileAsync(process.execPath, [binary, "--version"])).stdout.trim();
assert.equal(version, "1.4.0");

const directory = await mkdtemp(`${tmpdir()}/taric-pi-host-live-`);
const dbPath = resolve(directory, "authority.sqlite");
const contentRoot = resolve(directory, "content");
const extensionPath = resolve(directory, "taric-pi-live-extension.mjs");
const extensionMarker = resolve(directory, "extension-loaded.json");
const report = { version: "taric-third-party-host-live-verification/1", generated_at: new Date().toISOString(), host: { package: packageJson.name, version, commit: "4a08025" }, checks: [] };
let service;
let child;

function nextJsonLine(readline, childProcess, timeoutMs = 15_000) {
  return new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => { cleanup(); rejectLine(new Error("Pi RPC response timed out")); }, timeoutMs);
    const onLine = (line) => { cleanup(); try { resolveLine(JSON.parse(line)); } catch { rejectLine(new Error("Pi RPC returned invalid JSONL")); } };
    const onExit = () => { cleanup(); rejectLine(new Error("Pi RPC exited before responding")); };
    const cleanup = () => { clearTimeout(timer); readline.off("line", onLine); childProcess.off("exit", onExit); };
    readline.once("line", onLine);
    childProcess.once("exit", onExit);
  });
}

try {
  const store = new AuthorityStore(dbPath);
  service = await createCoreService(store, contentRoot);
  const initialized = await service.dispatch("engagement.init", createPrincipal("operator", "pi-live-operator"), {
    name: "Pi 1.4.0 live adapter verification",
    scope: { allowed_targets: ["https://pi-host-live.invalid"], excluded_targets: [], rules_of_engagement_ref: "test:pi-live" },
  });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  const host = createPrincipal("host", "pi-live-host", initialized.data.id);
  const extensionSource = `
    import { writeFile } from "node:fs/promises";
    import { AuthorityStore, createCoreService, createPrincipal, createPiExtension } from ${JSON.stringify(pathToFileURL(resolve(repositoryRoot, "packages/core/dist/index.js")).href)};
    const store = new AuthorityStore(${JSON.stringify(dbPath)});
    const service = await createCoreService(store, ${JSON.stringify(contentRoot)});
    const extension = createPiExtension(service, createPrincipal("host", "pi-live-host", ${JSON.stringify(initialized.data.id)}), "1.4.0");
    export default async (pi) => {
      const result = await extension(pi);
      await writeFile(${JSON.stringify(extensionMarker)}, JSON.stringify({ loaded: result.loaded, callbacks: result.callbacks, capabilities: result.available_capabilities }));
      return result;
    };
  `;
  await writeFile(extensionPath, extensionSource, { mode: 0o600 });

  const piArgs = [binary, "--mode", "rpc", "--no-session", "--offline", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", extensionPath];
  child = spawn(process.execPath, piArgs, {
    cwd: directory,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: directory,
      XDG_CONFIG_HOME: directory,
      PI_OFFLINE: "1",
      NODE_NO_WARNINGS: "1",
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const diagnostics = [];
  child.stderr.on("data", (data) => diagnostics.push(data.toString()));

  child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
  const stateResponse = await nextJsonLine(stdout, child);
  assert.equal(stateResponse.type, "response");
  assert.equal(stateResponse.id, "state");
  assert.equal(stateResponse.command, "get_state");
  assert.equal(stateResponse.success, true, diagnostics.join(""));
  report.checks.push({ id: "real_pi_rpc_process_starts", passed: true, mode: "rpc", session: stateResponse.data?.sessionId ?? null });

  const registrationEvidence = JSON.parse(await (await import("node:fs/promises")).readFile(extensionMarker, "utf8"));
  assert.equal(registrationEvidence.loaded, true, diagnostics.join(""));
  assert.deepEqual(registrationEvidence.callbacks, ["session_start", "context"]);
  report.checks.push({ id: "taric_extension_loaded_by_real_pi_extension_api", passed: true, callbacks: registrationEvidence.callbacks, capabilities: registrationEvidence.capabilities });

  child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  const commandsResponse = await nextJsonLine(stdout, child);
  assert.equal(commandsResponse.id, "commands");
  assert.equal(commandsResponse.success, true);
  report.checks.push({ id: "real_pi_rpc_command_surface_available", passed: true });

  const loadedAdapter = await import("../packages/core/dist/pi-adapter.js");
  const descriptor = loadedAdapter.createPiDescriptor(version);
  assert.equal(descriptor.certification_state, "certified");
  assert.equal(descriptor.host_commit, "4a08025");
  const adapter = loadedAdapter.createPiAdapter(service, host, version);
  const registration = await adapter.register({ on(event, handler) { return () => undefined; } });
  assert.equal(registration.loaded, true);
  assert.deepEqual(registration.available_capabilities, ["session_lifecycle", "context_injection"]);
  assert.equal(adapter.status().supported, true);
  report.checks.push({ id: "current_taric_adapter_matches_live_pi_version", passed: true, available_capabilities: registration.available_capabilities });

  // Record session identity without retaining session contents or local paths.
  const lifecycleDigest = createHash("sha256").update(stateResponse.data?.sessionId ?? "").digest("hex");
  report.pi_session_digest = `sha256:${lifecycleDigest}`;
  report.limitations = ["Pi 1.4.0 was installed and started as a real RPC host and the extension/API versions were checked. No model provider call, credential access, interactive tool execution, or external target action was performed; adapter lifecycle/content behavior remains covered by Taric contract tests."];

  child.stdin.end();
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); rejectExit(new Error("Pi RPC did not shut down")); }, 10_000);
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolveExit() : rejectExit(new Error(`Pi RPC exited with ${code}`)); });
  });
  child = undefined;
  await service.close();
  service = undefined;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, passed: true, checks: report.checks.length, host: `${packageJson.name}@${version}` })}\n`);
} finally {
  if (child) { child.kill("SIGTERM"); await new Promise((resolveExit) => child.once("exit", resolveExit)).catch(() => undefined); }
  await service?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
