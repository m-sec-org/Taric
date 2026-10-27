import { API_CONTRACT_VERSION, ARTIFACT_DEPLOYMENT_PROFILE, AuthorityConfigurationError, ContractValidationError, normalizeDiagnosticDetails, RuntimeStartupError, createCoreServiceForPath, createPrincipal, discoverRuntimeConfig, openRuntimeService, resolveRuntimeAuthority, type AuthorityStartupDiagnostics, type CoreService, type DeploymentGuardInput, type Principal, type RuntimeConfigProvenance, type RuntimeConfigurationPrecedence, type SharedAuthorityConfiguration } from "@taric/core";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

export const cliCommands = ["engagement.init", "engagement.status", "context.build", "query", "proposal.submit", "proposal.list", "review.pack", "review.submit", "admission.evaluate", "admission.promote_l2", "capture.observation", "control.list", "host.state", "control.observe", "access.observe", "work.claim", "work.renew", "work.reclaim", "work.transition", "work.resume", "coverage.record", "checkpoint.propose", "checkpoint.commit", "action.recommend", "action.host-decision", "action.host-result", "action.reconcile", "artifact.session.bind", "artifact.store.begin", "artifact.store.append", "artifact.store.append-file", "artifact.store.commit", "artifact.metadata", "artifact.content.read", "artifact.content.list", "artifact.session.output", "audit.verify", "audit.doctor", "audit.reconcile", "snapshot.export", "resource.revise", "resource.patch", "resource.relation", "resource.impact", "adapter.status", "adapter.install", "adapter.remove", "adapter.config", "capability.status"] as const;

/** 二级动词白名单。只有这里列出的组合才会被转发到 Core，未知组合不猜测。 */
export const cliSubcommands: Readonly<Record<string, readonly string[]>> = Object.freeze({
  context: ["build", "query"],
  admission: ["evaluate", "promote_l2"],
  action: ["recommend", "host-decision", "host-result", "reconcile"],
  audit: ["verify", "doctor", "reconcile"],
  adapter: ["install", "remove", "config", "health", "version"],
});

export type CliExitCode = 0 | 1 | 2;

export interface CliConfig {
  db_path?: string;
  principal_id?: string;
  principal_role?: "operator" | "model" | "host" | "reviewer" | "writer";
  engagement_id?: string;
  content_read_enabled?: boolean;
  content_root?: string;
  runtime_conformance_path?: string;
  authority?: SharedAuthorityConfiguration;
  deployment?: DeploymentGuardInput;
}

export interface CliStartupResolution {
  dbPath: string;
  contentRoot: string;
  diagnostics: AuthorityStartupDiagnostics;
  runtimeConfigProvenance: RuntimeConfigProvenance;
  precedence: RuntimeConfigurationPrecedence;
}

/** Validate authority selection before opening any SQLite database. */
export function resolveCliStartup(config: CliConfig, env: NodeJS.ProcessEnv = process.env, home = homedir(), runtimeConfigProvenance?: RuntimeConfigProvenance): CliStartupResolution {
  const resolution = resolveRuntimeAuthority({ config, env, home, runtimeConfigProvenance });
  return { dbPath: resolution.dbPath, contentRoot: resolution.contentRoot, diagnostics: resolution.diagnostics, runtimeConfigProvenance: resolution.runtimeConfigProvenance, precedence: resolution.precedence };
}

/**
 * Discover configuration without creating files or reading arbitrary project
 * state. Explicit TARIC_CONFIG wins, then a workspace-local or user config.
 */
export function discoverCliConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir()): ReturnType<typeof discoverRuntimeConfig> {
  return discoverRuntimeConfig(env, cwd, home);
}

export async function runCli(argv: string[], service: CoreService, principal: Omit<Principal, "transport_verified">): Promise<{ exitCode: CliExitCode; stdout: string; stderr: string }> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { exitCode: 0, stdout: `taric ${API_CONTRACT_VERSION}\n${cliHelp()}\n`, stderr: "" };
  if (argv[0] === "--version" || argv[0] === "-V") return { exitCode: 0, stdout: `${API_CONTRACT_VERSION}\n`, stderr: "" };
  const operation = normalizeCliOperation(argv);
  if (argv[0] === "adapter" && ["health", "version"].includes(argv[1] ?? "")) {
    if (argv[1] === "version") return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, data: { contract_version: "1.0", api_contract_version: API_CONTRACT_VERSION } })}\n`, stderr: "" };
    const health = await service.dispatch("capability.status", createPrincipal(principal.role, principal.id, principal.engagement_id, [], undefined, principal.transport_session_id), {});
    const manifest = health.ok ? (health.data as Record<string, unknown>).compatibility_manifest : undefined;
    let adapter_config: Record<string, unknown> = {};
    const configPath = process.env.TARIC_ADAPTER_CONFIG ?? join(homedir(), ".taric", "adapters.json");
    try { adapter_config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>; } catch { /* absent config means no locally installed adapter */ }
    const healthReport = { compatibility_manifest: manifest, core_connected: health.ok, configured_adapters: adapter_config.adapters ?? {}, adapter_config_path: configPath };
    return { exitCode: health.ok ? 0 : 1, stdout: health.ok ? `${JSON.stringify({ ok: true, data: healthReport })}\n` : "", stderr: health.ok ? "" : `${JSON.stringify(health)}\n` };
  }
  if (operation === "artifact.store.append-file") {
    if (argv.length !== 3) return cliError(2, "validation_error", "artifact.store.append-file requires metadata JSON and a local file path");
    let request: Record<string, unknown>;
    try { request = JSON.parse(argv[1] ?? "") as Record<string, unknown>; } catch { return cliError(2, "validation_error", "request must be valid JSON"); }
    const fields = new Set(["engagement_id", "session_id", "upload_id", "ordinal", "idempotency_key"]);
    if (!request || Array.isArray(request) || typeof request !== "object" || Object.keys(request).some((key) => !fields.has(key)) ||
      ["engagement_id", "session_id", "upload_id"].some((key) => typeof request[key] !== "string") ||
      typeof request.ordinal !== "number" || !Number.isSafeInteger(request.ordinal) || request.ordinal < 0 ||
      (request.idempotency_key !== undefined && typeof request.idempotency_key !== "string")) return cliError(2, "validation_error", "Artifact append metadata is invalid");
    let byte_length: number;
    try { byte_length = statSync(argv[2]!).size; } catch { return cliError(2, "validation_error", "Artifact append file is unavailable"); }
    if (!Number.isSafeInteger(byte_length) || byte_length < 1 || byte_length > 64 * 1024 * 1024) return cliError(2, "validation_error", "Artifact append file must contain 1 byte to 64 MiB");
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > ARTIFACT_DEPLOYMENT_PROFILE.json_metadata_max_bytes) return cliError(2, "validation_error", "Artifact metadata exceeds the 16 KiB bound");
    const digest = createHash("sha256");
    try { for await (const chunk of createReadStream(argv[2]!, { highWaterMark: 64 * 1024 })) digest.update(chunk); }
    catch { return cliError(2, "validation_error", "Artifact append file is unavailable"); }
    const principalContext = createPrincipal(principal.role, principal.id, principal.engagement_id, principal.capabilities ?? [], undefined, principal.transport_session_id);
    const response = await service.artifactStoreAppendBinaryStream(principalContext, { ...request, byte_length, chunk_hash: `sha256:${digest.digest("hex")}` } as Parameters<CoreService["artifactStoreAppendBinaryStream"]>[1], createReadStream(argv[2]!, { highWaterMark: 64 * 1024 }));
    return { exitCode: response.ok ? 0 : 1, stdout: response.ok ? `${JSON.stringify(response)}\n` : "", stderr: response.ok ? "" : `${JSON.stringify(response)}\n` };
  }
  const consumed = cliSubcommands[argv[0] ?? ""] && argv[1] ? 2 : 1;
  const args = argv.slice(consumed);
  if (argv[0] === "--json" && argv.length === 1) return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, data: { contract_version: API_CONTRACT_VERSION, commands: cliCommands } })}\n`, stderr: "" };
  const includeContent = args.includes("--include-content");
  const json = args.filter((arg) => arg !== "--include-content").join(" ").trim() || "{}";
  let request: Record<string, unknown>;
  try { request = JSON.parse(json) as Record<string, unknown>; } catch { return { exitCode: 2, stdout: "", stderr: JSON.stringify({ ok: false, error: { code: "validation_error", message: "request must be valid JSON" } }) + "\n" }; }
  if (!request || Array.isArray(request) || typeof request !== "object") return { exitCode: 2, stdout: "", stderr: `${JSON.stringify({ ok: false, error: { code: "validation_error", message: "request must be a JSON object" } })}\n` };
  if (includeContent) request.include_content = true;
  const response = await service.dispatch(operation, createPrincipal(principal.role, principal.id, principal.engagement_id, principal.capabilities ?? [], undefined, principal.transport_session_id), request);
  return { exitCode: response.ok ? 0 : 1, stdout: response.ok ? `${JSON.stringify(response)}\n` : "", stderr: response.ok ? "" : `${JSON.stringify(response)}\n` };
}

export function createCliService(directory = join(tmpdir(), "taric-cli"), contentRoot?: string) {
  mkdirSync(dirname(directory), { recursive: true });
  return createCoreServiceForPath(directory, contentRoot);
}

/** 便于宿主以单个命令字符串调用，同时保持策略集中在 Core。 */
export function normalizeCliOperation(argv: string[]): string {
  const aliases: Record<string, string> = {
    init: "engagement.init", status: "engagement.status", propose: "proposal.submit",
    query: "query", review: "review.submit", admit: "admission.evaluate", capture: "capture.observation",
    "capability.status": "capability.status", "adapter.status": "adapter.status",
  };
  if (argv[0] === "adapter") return argv[1] && ["install", "remove", "config"].includes(argv[1]) ? `adapter.${argv[1]}` : "adapter.invalid";
  const verb = cliSubcommands[argv[0] ?? ""];
  if (verb) return argv[1] && verb.includes(argv[1]) ? `${argv[0]}.${argv[1]}` : `${argv[0]}.invalid`;
  return aliases[argv[0] ?? ""] ?? argv[0] ?? "";
}

export function cliHelp(): string {
  const groups = Object.entries(cliSubcommands).map(([group, verbs]) => `  ${group} ${verbs.join("|")}`).join("\n");
  return `usage: taric <operation> [json]\n  <json> 必须是 JSON 对象；成功输出 stdout，失败输出 stderr\n  artifact.store.append-file <metadata-json> <path> streams one local file up to 64 MiB\n  review --proposal <id> | --input-hash <sha256> --export | --submit-result <path> exports or forwards an external result\n  review submission requires trusted TARIC_REVIEWER_ID and TARIC_REVIEWER_ATTESTATION host configuration\n  Taric review does not call providers, select reviewers, or generate verdicts\n\n别名:\n  init status propose review capture query capability.status adapter.status\n\n分组命令:\n${groups}\n\n完整 operation 清单:\n  ${cliCommands.join("\n  ")}`;
}

function cliError(exitCode: CliExitCode, code: string, message: string) {
  return { exitCode, stdout: "", stderr: `${JSON.stringify({ ok: false, error: { code, message } })}\n` };
}

/** CLI 进程入口。配置发现：TARIC_DB 优先，其次 ~/.taric/authority.sqlite。 */
export async function runCliMain(argv: string[] = process.argv.slice(2)): Promise<CliExitCode> {
  if (argv[0] === "proxy") {
    if (argv.length > 1 && !["--help", "-h"].includes(argv[1] ?? "")) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "validation_error", message: "proxy accepts configuration through environment variables" } })}\n`);
      return 2;
    }
    if (argv.length > 1) {
      process.stdout.write("usage: taric proxy\nConfigure TARIC_CORE_SOCKET, TARIC_ADAPTER_TOKEN, and TARIC_ENGAGEMENT_ID in the trusted host process.\n");
      return 0;
    }
    const { runProxyMain } = await import("./proxy.js");
    return await runProxyMain() as CliExitCode;
  }
  if (argv[0] === "gateway") {
    const { GatewayArgumentError, parseGatewayArguments } = await import("./gateway-args.js");
    let gatewayArgs: { configPath: string; runtimeConfigPath?: string };
    try { gatewayArgs = parseGatewayArguments(argv.slice(1)); }
    catch (cause) {
      const message = cause instanceof GatewayArgumentError ? cause.message : "invalid gateway arguments";
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "validation_error", message } })}\n`);
      return 2;
    }
    const { runGatewayMain } = await import("./gateway.js");
    return await runGatewayMain(gatewayArgs.configPath, process.env, gatewayArgs.runtimeConfigPath) as CliExitCode;
  }
  // `taric review --proposal …` exports the admission-bound fixed pack or
  // forwards an external result; `taric review '<json>'` remains review.submit.
  if (argv[0] === "review" && (argv.length === 1 || (argv[1] ?? "").startsWith("--"))) {
    const { runReviewHarness } = await import("./review.js");
    try {
      const result = await runReviewHarness(argv.slice(1));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.ok && result.submitted ? 0 : result.ok ? 0 : 1;
    } catch (cause) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "review_harness_failed", message: cause instanceof Error ? cause.message : "review harness failed" } })}\n`);
      return 1;
    }
  }
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`taric ${API_CONTRACT_VERSION}\n${cliHelp()}\n`);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`${API_CONTRACT_VERSION}\n`);
    return 0;
  }
  let discovered: ReturnType<typeof discoverCliConfig>;
  try { discovered = discoverCliConfig(); }
  catch (cause) {
    const message = cause instanceof AuthorityConfigurationError ? cause.message : "invalid Taric configuration";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "validation_error", message } })}\n`);
    return 2;
  }
  const config = discovered.config;
  let startup: CliStartupResolution;
  try { startup = resolveCliStartup(config, process.env, homedir(), discovered.provenance); }
  catch (cause) {
    const message = cause instanceof AuthorityConfigurationError ? cause.message : "invalid authority configuration";
    const code = cause instanceof AuthorityConfigurationError ? cause.code : "validation_error";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    return 2;
  }
  if (!startup.diagnostics.ok && !(process.env.TARIC_RUNTIME_CONFORMANCE ?? config.runtime_conformance_path)) {
    const diagnostic = startup.diagnostics;
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: diagnostic.code, message: diagnostic.message, follow_up: diagnostic.follow_up }, data: diagnostic })}\n`);
    return 1;
  }
  let service: CoreService;
  try { service = await openRuntimeService({ config, runtimeConfigProvenance: discovered.provenance }); }
  catch (cause) {
    const error = cause instanceof RuntimeStartupError
      ? { code: cause.code, message: cause.diagnostics.message, follow_up: cause.diagnostics.follow_up }
      : { code: "configuration_invalid", message: "invalid authority configuration" };
    const details = cause instanceof ContractValidationError ? normalizeDiagnosticDetails(cause.details) : undefined;
    process.stderr.write(`${JSON.stringify({ ok: false, error: { ...error, ...(details ? { details } : {}) } })}\n`);
    return 1;
  }
  const role = (process.env.TARIC_PRINCIPAL_ROLE ?? config.principal_role ?? "operator") as "operator" | "model" | "host" | "reviewer" | "writer";
  const engagement_id = process.env.TARIC_ENGAGEMENT_ID ?? config.engagement_id;
  const contentReadEnabled = process.env.TARIC_CONTENT_READ_ENABLED === "true" || config.content_read_enabled === true;
  try {
    const result = await runCli(argv, service, { id: process.env.TARIC_PRINCIPAL_ID ?? config.principal_id ?? "operator-local", role, engagement_id: engagement_id === "" ? undefined : engagement_id, capabilities: contentReadEnabled ? ["content_read"] : [] });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  } finally { await service.close(); }
}
