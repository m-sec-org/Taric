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
assert.equal(packageJson.version, "1.5.0");
const piSchemaPath = resolve(packageRoot, "../pi-schema/dist/index.js");
const piSchemaPackage = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(packageRoot, "../pi-schema/package.json"), "utf8"));
assert.equal(piSchemaPackage.name, "@earendil-works/pi-schema");
assert.equal(piSchemaPackage.version, "1.5.0");
const binary = resolve(packageRoot, "dist/bundle/cli.js");
const version = (await execFileAsync(process.execPath, [binary, "--version"])).stdout.trim();
assert.equal(version, "1.5.0");

const upstreamCommit = "f9a26365568127461c47a07a37dcb42c140a3ac5";
const evidenceCommands = [
  "npm install --prefix <isolated-prefix> --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.0",
  "node scripts/verify-pi-host-live.mjs --output <report-path>",
];

const directory = await mkdtemp(`${tmpdir()}/taric-pi-host-live-`);
const dbPath = resolve(directory, "authority.sqlite");
const contentRoot = resolve(directory, "content");
const extensionPath = resolve(directory, "taric-pi-live-extension.mjs");
const extensionMarker = resolve(directory, "extension-loaded.json");
const report = {
  version: "taric-third-party-host-live-verification/2",
  generated_at: new Date().toISOString(),
  host: { package: packageJson.name, version, commit: upstreamCommit },
  evidence: { upstream_tag: "v1.5.0", upstream_commit: upstreamCommit, commands: evidenceCommands, install_source: "npm registry", installation: "isolated package prefix" },
  schema: { package: piSchemaPackage.name, version: piSchemaPackage.version },
  release_review: {
    extension_api: "ExtensionAPI.on/registerTool",
    tool_validation: "Pi 1.5.0 routes JSON Schema tool arguments through pi-schema, including coercion and pi-schema diagnostics.",
    typebox_boundary: "TypeBox-only features outside JSON Schema are not applied to tool arguments.",
  },
  checks: [],
};
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
    name: "Pi 1.5.0 live adapter verification",
    scope: { allowed_targets: ["https://pi-host-live.invalid"], excluded_targets: [], rules_of_engagement_ref: "test:pi-live" },
  });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  const host = createPrincipal("host", "pi-live-host", initialized.data.id);
  const extensionSource = `
    import { writeFile } from "node:fs/promises";
    import { AuthorityStore, createCoreService, createPrincipal, createPiExtension } from ${JSON.stringify(pathToFileURL(resolve(repositoryRoot, "packages/core/dist/index.js")).href)};
    const store = new AuthorityStore(${JSON.stringify(dbPath)});
    const service = await createCoreService(store, ${JSON.stringify(contentRoot)});
    const extension = createPiExtension(service, createPrincipal("host", "pi-live-host", ${JSON.stringify(initialized.data.id)}), "1.5.0");
    export default async (pi) => {
      const registeredTools = [];
      const observedPi = new Proxy(pi, {
        get(target, property, receiver) {
          if (property === "registerTool") return (tool) => { registeredTools.push(tool); return target.registerTool.call(target, tool); };
          return Reflect.get(target, property, receiver);
        },
      });
      const result = await extension(observedPi);
      const proposal = registeredTools.find((tool) => tool.name === "taric_proposal");
      if (!proposal) throw new Error("Taric proposal tool was not registered by Pi");
      const { compile } = await import(${JSON.stringify(pathToFileURL(piSchemaPath).href)});
      const validator = compile(proposal.parameters, { coerce: true });
      const content = { schema_version: "1.0.0", engagement_id: ${JSON.stringify(initialized.data.id)}, kind: "claim", proposition: "Pi 1.5.0 schema smoke", status: "proposed", evidence_refs: [], limitations: [] };
      const coerced = validator.parse({ subject_type: "claim", expected_version: "0", content });
      const invalid = validator.parse({ subject_type: "claim", expected_version: "not-an-integer", content });
      const extra = validator.parse({ subject_type: "claim", expected_version: 0, content, unexpected: true });
      if (!coerced.ok || invalid.ok || extra.ok) throw new Error("Pi schema behavior did not match the registered tool contract");
      const execution = await proposal.execute("pi-live-proposal", coerced.value);
      const coreInvalid = await proposal.execute("pi-live-invalid", { subject_type: "claim", expected_version: "not-an-integer", content });
      const coreExtra = await proposal.execute("pi-live-extra", { subject_type: "claim", expected_version: 0, content, unexpected: true });
      const executionDetails = execution?.details && typeof execution.details === "object" ? execution.details : {};
      const coreInvalidDetails = coreInvalid?.details && typeof coreInvalid.details === "object" ? coreInvalid.details : {};
      const coreExtraDetails = coreExtra?.details && typeof coreExtra.details === "object" ? coreExtra.details : {};
      await writeFile(${JSON.stringify(extensionMarker)}, JSON.stringify({
        loaded: result.loaded,
        callbacks: result.callbacks,
        hooks: result.hooks,
        capabilities: result.available_capabilities,
        registered_tools: registeredTools.map((tool) => tool.name),
        proposal_parameters: proposal.parameters,
        pi_schema: {
          coercion: { input_expected_version: "0", output_expected_version_type: typeof coerced.value.expected_version, output_expected_version: coerced.value.expected_version },
          invalid: { ok: invalid.ok, errors: invalid.ok ? [] : invalid.errors.slice(0, 4) },
          additional_properties: { ok: extra.ok, errors: extra.ok ? [] : extra.errors.slice(0, 4) },
        },
        proposal_execution: {
          valid_coerced: { ok: executionDetails.ok === true, error_code: executionDetails.error?.code ?? null },
          core_invalid: { ok: coreInvalidDetails.ok === true, error_code: coreInvalidDetails.error?.code ?? null },
          core_additional_property: { ok: coreExtraDetails.ok === true, error_code: coreExtraDetails.error?.code ?? null },
        },
      }));
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
  assert.deepEqual(registrationEvidence.hooks, ["session_start", "context", "before_agent_start", "agent_before_settle", "tool_result", "session_shutdown", "registerTool:taric_proposal"]);
  assert.deepEqual(registrationEvidence.registered_tools, ["taric_proposal"]);
  assert.equal(registrationEvidence.pi_schema.coercion.output_expected_version, 0);
  assert.equal(registrationEvidence.pi_schema.coercion.output_expected_version_type, "number");
  assert.equal(registrationEvidence.pi_schema.invalid.ok, false);
  assert.equal(registrationEvidence.pi_schema.additional_properties.ok, false);
  assert.equal(registrationEvidence.proposal_execution.valid_coerced.ok, true);
  assert.equal(registrationEvidence.proposal_execution.core_invalid.ok, false);
  assert.equal(registrationEvidence.proposal_execution.core_invalid.error_code, "validation_error");
  assert.equal(registrationEvidence.proposal_execution.core_additional_property.ok, false);
  assert.equal(registrationEvidence.proposal_execution.core_additional_property.error_code, "validation_error");
  report.checks.push({ id: "taric_extension_loaded_by_real_pi_extension_api", passed: true, callbacks: registrationEvidence.callbacks, hooks: registrationEvidence.hooks, capabilities: registrationEvidence.capabilities, registered_tools: registrationEvidence.registered_tools });
  report.checks.push({ id: "pi_1_5_schema_coercion_and_diagnostics", passed: true, coercion: registrationEvidence.pi_schema.coercion, invalid: registrationEvidence.pi_schema.invalid, additional_properties: registrationEvidence.pi_schema.additional_properties, proposal_execution: registrationEvidence.proposal_execution });

  child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  const commandsResponse = await nextJsonLine(stdout, child);
  assert.equal(commandsResponse.id, "commands");
  assert.equal(commandsResponse.success, true);
  report.checks.push({ id: "real_pi_rpc_command_surface_available", passed: true });

  const loadedAdapter = await import("../packages/core/dist/pi-adapter.js");
  const descriptor = loadedAdapter.createPiDescriptor(version);
  assert.equal(descriptor.certification_state, "certified");
  assert.equal(descriptor.host_commit, upstreamCommit);
  const adapter = loadedAdapter.createPiAdapter(service, host, version);
  const registration = await adapter.register({ on(event, handler) { return () => undefined; } });
  assert.equal(registration.loaded, true);
  assert.deepEqual(registration.available_capabilities, ["session_lifecycle", "context_injection"]);
  assert.equal(adapter.status().supported, true);
  report.checks.push({ id: "current_taric_adapter_matches_live_pi_version", passed: true, available_capabilities: registration.available_capabilities });

  // Record session identity without retaining session contents or local paths.
  const lifecycleDigest = createHash("sha256").update(stateResponse.data?.sessionId ?? "").digest("hex");
  report.pi_session_digest = `sha256:${lifecycleDigest}`;
  report.limitations = ["Pi 1.5.0 was installed and started as a real RPC host. The extension registered Taric's proposal tool, and the installed pi-schema compiler recorded numeric coercion plus invalid/additional-property diagnostics. The smoke calls the extension tool implementation directly to confirm Core rejects invalid and extra arguments; it does not send model-generated tool calls through a provider. No model provider call, credential access, interactive target tool execution, or external target action was performed; Core remains the strict authorization and contract boundary."];

  child.stdin.end();
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); rejectExit(new Error("Pi RPC did not shut down")); }, 10_000);
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolveExit() : rejectExit(new Error(`Pi RPC exited with ${code}`)); });
  });
  child = undefined;
  await service.close();
  service = undefined;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, passed: true, checks: report.checks.length, host: `${packageJson.name}@${version}` })}\n`);
} finally {
  if (child) { child.kill("SIGTERM"); await new Promise((resolveExit) => child.once("exit", resolveExit)).catch(() => undefined); }
  await service?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
