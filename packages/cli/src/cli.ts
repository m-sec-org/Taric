import { API_CONTRACT_VERSION, AuthorityConfigurationError, authorityStartupDiagnostics, createCoreServiceForPath, createPrincipal, resolveAuthorityConfiguration, type AuthorityStartupDiagnostics, type CoreService, type DeploymentGuardInput, type Principal, type SharedAuthorityConfiguration } from "@taric/core";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

export const cliCommands = ["engagement.init", "engagement.status", "context.build", "query", "proposal.submit", "proposal.list", "review.submit", "admission.evaluate", "capture.observation", "control.list", "control.observe", "access.observe", "work.claim", "work.renew", "work.reclaim", "work.resume", "checkpoint.propose", "checkpoint.commit", "action.recommend", "action.host-decision", "action.host-result", "action.reconcile", "audit.verify", "audit.doctor", "audit.reconcile", "snapshot.export", "snapshot.import", "resource.revise", "resource.patch", "resource.relation", "resource.impact", "adapter.status", "adapter.install", "adapter.remove", "adapter.config", "capability.status"] as const;

/** 二级动词白名单。只有这里列出的组合才会被转发到 Core，未知组合不猜测。 */
export const cliSubcommands: Readonly<Record<string, readonly string[]>> = Object.freeze({
  context: ["build", "query"],
  action: ["recommend", "host-decision", "host-result", "reconcile"],
  audit: ["verify", "doctor", "reconcile"],
  adapter: ["install", "remove", "config", "health", "version"],
});

export type CliExitCode = 0 | 1 | 2;

export interface CliConfig {
  db_path?: string;
  principal_id?: string;
  principal_role?: "operator" | "model" | "host";
  engagement_id?: string;
  authority?: SharedAuthorityConfiguration;
  deployment?: DeploymentGuardInput;
}

export interface CliStartupResolution {
  dbPath: string;
  diagnostics: AuthorityStartupDiagnostics;
}

/** Validate authority selection before opening any SQLite database. */
export function resolveCliStartup(config: CliConfig, env: NodeJS.ProcessEnv = process.env, home = homedir()): CliStartupResolution {
  const authorityInput = config.authority ?? (env.TARIC_AUTHORITY_PROFILE
    ? {
        profile: env.TARIC_AUTHORITY_PROFILE,
        ...(env.TARIC_DATABASE_URL ? { postgresql: { connection_string: env.TARIC_DATABASE_URL } } : {}),
        ...(env.TARIC_HOST_ID ? { host_id: env.TARIC_HOST_ID } : {}),
        ...(env.TARIC_LEASE_MODE ? { lease_mode: env.TARIC_LEASE_MODE } : {}),
      } as unknown as SharedAuthorityConfiguration
    : undefined);
  const authority = resolveAuthorityConfiguration(authorityInput);
  const diagnostics = authorityStartupDiagnostics(authority, authority.backend === "postgresql" ? false : undefined, config.deployment);
  const configuredSqlitePath = authorityInput && authority.backend === "sqlite" ? authority.sqlite?.path : undefined;
  return { dbPath: env.TARIC_DB ?? config.db_path ?? configuredSqlitePath ?? join(home, ".taric", "authority.sqlite"), diagnostics };
}

/**
 * Discover configuration without creating files or reading arbitrary project
 * state. Explicit TARIC_CONFIG wins, then a workspace-local or user config.
 */
export function discoverCliConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir()): { config: CliConfig; path?: string } {
  const candidates = [env.TARIC_CONFIG, join(cwd, ".taric", "config.json"), join(home, ".taric", "config.json")].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error(`invalid Taric config: ${path}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid Taric config: ${path}`);
    const config = parsed as Record<string, unknown>;
    const role = config.principal_role;
    if (role !== undefined && role !== "operator" && role !== "model" && role !== "host") throw new Error(`invalid principal_role in Taric config: ${path}`);
    for (const key of ["db_path", "principal_id", "engagement_id"]) if (config[key] !== undefined && typeof config[key] !== "string") throw new Error(`invalid ${key} in Taric config: ${path}`);
    if (config.authority !== undefined && (!config.authority || typeof config.authority !== "object" || Array.isArray(config.authority))) throw new Error(`invalid authority in Taric config: ${path}`);
    if (config.deployment !== undefined && (!config.deployment || typeof config.deployment !== "object" || Array.isArray(config.deployment))) throw new Error(`invalid deployment in Taric config: ${path}`);
    return { config: { db_path: config.db_path as string | undefined, principal_id: config.principal_id as string | undefined, principal_role: role as CliConfig["principal_role"], engagement_id: config.engagement_id as string | undefined, authority: config.authority as SharedAuthorityConfiguration | undefined, deployment: config.deployment as DeploymentGuardInput | undefined }, path };
  }
  return { config: {} };
}

export async function runCli(argv: string[], service: CoreService, principal: Omit<Principal, "transport_verified">): Promise<{ exitCode: CliExitCode; stdout: string; stderr: string }> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { exitCode: 0, stdout: `taric ${API_CONTRACT_VERSION}\n${cliHelp()}\n`, stderr: "" };
  if (argv[0] === "--version" || argv[0] === "-V") return { exitCode: 0, stdout: `${API_CONTRACT_VERSION}\n`, stderr: "" };
  const operation = normalizeCliOperation(argv);
  if (argv[0] === "adapter" && ["health", "version"].includes(argv[1] ?? "")) {
    if (argv[1] === "version") return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, data: { contract_version: "1.0", api_contract_version: API_CONTRACT_VERSION } })}\n`, stderr: "" };
    const health = service.dispatch("capability.status", createPrincipal(principal.role, principal.id, principal.engagement_id), {});
    const manifest = health.ok ? (health.data as Record<string, unknown>).compatibility_manifest : undefined;
    let adapter_config: Record<string, unknown> = {};
    const configPath = process.env.TARIC_ADAPTER_CONFIG ?? join(homedir(), ".taric", "adapters.json");
    try { adapter_config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>; } catch { /* absent config means no locally installed adapter */ }
    const healthReport = { compatibility_manifest: manifest, core_connected: health.ok, configured_adapters: adapter_config.adapters ?? {}, adapter_config_path: configPath };
    return { exitCode: health.ok ? 0 : 1, stdout: health.ok ? `${JSON.stringify({ ok: true, data: healthReport })}\n` : "", stderr: health.ok ? "" : `${JSON.stringify(health)}\n` };
  }
  const consumed = cliSubcommands[argv[0] ?? ""] && argv[1] ? 2 : 1;
  const args = argv.slice(consumed);
  if (argv[0] === "--json" && argv.length === 1) return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, data: { contract_version: API_CONTRACT_VERSION, commands: cliCommands } })}\n`, stderr: "" };
  const json = args.join(" ").trim() || "{}";
  let request: Record<string, unknown>;
  try { request = JSON.parse(json) as Record<string, unknown>; } catch { return { exitCode: 2, stdout: "", stderr: JSON.stringify({ ok: false, error: { code: "validation_error", message: "request must be valid JSON" } }) + "\n" }; }
  if (Array.isArray(request) || typeof request !== "object") return { exitCode: 2, stdout: "", stderr: `${JSON.stringify({ ok: false, error: { code: "validation_error", message: "request must be a JSON object" } })}\n` };
  const response = service.dispatch(operation, createPrincipal(principal.role, principal.id, principal.engagement_id), request);
  return { exitCode: response.ok ? 0 : 1, stdout: response.ok ? `${JSON.stringify(response)}\n` : "", stderr: response.ok ? "" : `${JSON.stringify(response)}\n` };
}

export function createCliService(directory = join(tmpdir(), "taric-cli")) {
  mkdirSync(dirname(directory), { recursive: true });
  return createCoreServiceForPath(directory);
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
  return `usage: taric <operation> [json]\n  <json> 必须是 JSON 对象；成功输出 stdout，失败输出 stderr\n\n别名:\n  init status propose review capture query capability.status adapter.status\n\n分组命令:\n${groups}\n\n完整 operation 清单:\n  ${cliCommands.join("\n  ")}`;
}

/** CLI 进程入口。配置发现：TARIC_DB 优先，其次 ~/.taric/authority.sqlite。 */
export async function runCliMain(argv: string[] = process.argv.slice(2)): Promise<CliExitCode> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`taric ${API_CONTRACT_VERSION}\n${cliHelp()}\n`);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    process.stdout.write(`${API_CONTRACT_VERSION}\n`);
    return 0;
  }
  let discovered: { config: CliConfig; path?: string };
  try { discovered = discoverCliConfig(); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid Taric config";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "validation_error", message } })}\n`);
    return 2;
  }
  const config = discovered.config;
  let startup: CliStartupResolution;
  try { startup = resolveCliStartup(config); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid authority configuration";
    const code = cause instanceof AuthorityConfigurationError ? cause.code : "validation_error";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    return 2;
  }
  if (!startup.diagnostics.ok) {
    const diagnostic = startup.diagnostics;
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: diagnostic.code, message: diagnostic.message, follow_up: diagnostic.follow_up }, data: diagnostic })}\n`);
    return 1;
  }
  const service = createCliService(startup.dbPath);
  const role = (process.env.TARIC_PRINCIPAL_ROLE ?? config.principal_role ?? "operator") as "operator" | "model" | "host";
  const engagement_id = process.env.TARIC_ENGAGEMENT_ID ?? config.engagement_id;
  const result = await runCli(argv, service, { id: process.env.TARIC_PRINCIPAL_ID ?? config.principal_id ?? "operator-local", role, engagement_id: engagement_id === "" ? undefined : engagement_id });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}
