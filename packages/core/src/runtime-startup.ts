import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { uuidv7 } from "./identity.js";
import {
  authorityStartupDiagnostics,
  AuthorityConfigurationError,
  resolveAuthorityConfiguration,
  type AuthorityStartupDiagnostics,
  type ResolvedAuthorityConfiguration,
  type SharedAuthorityConfiguration,
} from "./shared-authority-config.js";
import type { DeploymentGuardInput } from "./deployment-guard.js";
import type { PrincipalRole, PrincipalCapability } from "./service.js";

export interface RuntimeStartupConfig {
  db_path?: string;
  content_root?: string;
  principal_id?: string;
  principal_role?: PrincipalRole;
  engagement_id?: string;
  content_read_enabled?: boolean;
  /** Operator-produced evidence from an isolated live PostgreSQL run. */
  runtime_conformance_path?: string;
  authority?: SharedAuthorityConfiguration;
  deployment?: DeploymentGuardInput;
}

export interface RuntimeStartupOptions {
  config?: RuntimeStartupConfig;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  /** A test-only home lets callers avoid touching the real user directory. */
  test?: boolean;
}

export interface RuntimePrincipalContext {
  id: string;
  role: PrincipalRole;
  engagement_id?: string;
  capabilities: readonly PrincipalCapability[];
}

export interface RuntimeStartupResolution {
  authority: ResolvedAuthorityConfiguration;
  dbPath: string;
  contentRoot: string;
  principal: RuntimePrincipalContext;
  diagnostics: AuthorityStartupDiagnostics;
  explicitMemory: boolean;
}

export type RuntimeStartupErrorCode = "postgresql_unavailable" | "backend_conformance_failed" | "unsupported_deployment" | "configuration_invalid";

/** Public startup failure. The diagnostic is safe to expose on stderr. */
export class RuntimeStartupError extends Error {
  readonly code: RuntimeStartupErrorCode;
  readonly diagnostics: AuthorityStartupDiagnostics;

  constructor(diagnostics: AuthorityStartupDiagnostics) {
    super(diagnostics.message);
    this.name = "RuntimeStartupError";
    this.code = diagnostics.code as RuntimeStartupErrorCode;
    this.diagnostics = diagnostics;
  }
}

function envAuthority(env: NodeJS.ProcessEnv): SharedAuthorityConfiguration | undefined {
  if (!env.TARIC_AUTHORITY_PROFILE) return undefined;
  return {
    profile: env.TARIC_AUTHORITY_PROFILE,
    ...(env.TARIC_DATABASE_URL ? { postgresql: { connection_string: env.TARIC_DATABASE_URL } } : {}),
    ...(env.TARIC_HOST_ID ? { host_id: env.TARIC_HOST_ID } : {}),
    ...(env.TARIC_LEASE_MODE ? { lease_mode: env.TARIC_LEASE_MODE } : {}),
  } as unknown as SharedAuthorityConfiguration;
}

/** Shared entrypoint config discovery. Errors contain no caller-controlled
 * values or filesystem paths, so MCP diagnostics are safe to serialize. */
export function discoverRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir()): { config: RuntimeStartupConfig; path?: string } {
  const candidates = [env.TARIC_CONFIG, join(cwd, ".taric", "config.json"), join(home, ".taric", "config.json")].filter((path, index, all): path is string => Boolean(path) && all.indexOf(path) === index);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new AuthorityConfigurationError("invalid Taric configuration"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthorityConfigurationError("invalid Taric configuration");
    const config = value as RuntimeStartupConfig;
    if (config.principal_role !== undefined && !["operator", "model", "host", "reviewer", "writer"].includes(config.principal_role)) throw new AuthorityConfigurationError("invalid principal role in Taric configuration");
    for (const key of ["db_path", "principal_id", "engagement_id", "content_root", "runtime_conformance_path"] as const) if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key]!.trim())) throw new AuthorityConfigurationError("invalid path or principal context in Taric configuration");
    if (config.content_read_enabled !== undefined && typeof config.content_read_enabled !== "boolean") throw new AuthorityConfigurationError("invalid content-read setting in Taric configuration");
    for (const key of ["authority", "deployment"] as const) if (config[key] !== undefined && (!config[key] || typeof config[key] !== "object" || Array.isArray(config[key]))) throw new AuthorityConfigurationError("invalid authority deployment in Taric configuration");
    return { config, path };
  }
  return { config: {} };
}

/** Resolve all process-facing authority decisions before constructing a store. */
export function resolveRuntimeAuthority(options: RuntimeStartupOptions = {}): RuntimeStartupResolution {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const config = options.config ?? discoverRuntimeConfig(env, options.cwd ?? process.cwd(), home).config;
  const authorityInput = config.authority ?? envAuthority(env);
  const authority = resolveAuthorityConfiguration(authorityInput);
  // `resolveAuthorityConfiguration` keeps its library/test default as
  // `:memory:`. Runtime entrypoints only honor memory when it was explicitly
  // requested in TARIC_DB or authority.sqlite.path.
  const configuredSqlitePath = authorityInput && authority.backend === "sqlite" && "sqlite" in authorityInput && authorityInput.sqlite?.path
    ? authorityInput.sqlite.path
    : undefined;
  const dbPath = env.TARIC_DB ?? config.db_path ?? configuredSqlitePath ?? join(home, ".taric", "authority.sqlite");
  const explicitMemory = dbPath === ":memory:";
  const contentRoot = env.TARIC_CONTENT_ROOT ?? config.content_root ?? (explicitMemory
    ? join(tmpdir(), "taric-content", uuidv7())
    : join(dirname(resolve(dbPath)), "content"));
  const role = (env.TARIC_PRINCIPAL_ROLE ?? config.principal_role ?? "operator") as RuntimePrincipalContext["role"];
  if (!["operator", "model", "host", "reviewer", "writer"].includes(role)) throw new AuthorityConfigurationError("invalid runtime principal role");
  if (typeof dbPath !== "string" || !dbPath.trim() || typeof contentRoot !== "string" || !contentRoot.trim()) throw new AuthorityConfigurationError("invalid authority or content root");
  const engagement = env.TARIC_ENGAGEMENT_ID ?? config.engagement_id;
  const principal: RuntimePrincipalContext = {
    id: env.TARIC_PRINCIPAL_ID ?? config.principal_id ?? (role === "model" ? "mcp-model" : "operator-local"),
    role,
    ...(engagement ? { engagement_id: engagement } : {}),
    capabilities: env.TARIC_CONTENT_READ_ENABLED === "true" || config.content_read_enabled === true ? ["content_read"] : [],
  };
  const diagnostics = authorityStartupDiagnostics(authority, authority.backend === "postgresql" ? false : undefined, config.deployment);
  return { authority, dbPath, contentRoot, principal, diagnostics, explicitMemory };
}

/** Resolve and fail closed before opening any authority store. */
export function requireRuntimeAuthority(options: RuntimeStartupOptions = {}): RuntimeStartupResolution {
  const resolution = resolveRuntimeAuthority(options);
  if (!resolution.diagnostics.ok) {
    throw new RuntimeStartupError(resolution.diagnostics);
  }
  if (!resolution.explicitMemory) mkdirSync(dirname(resolve(resolution.dbPath)), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(resolution.contentRoot), { recursive: true, mode: 0o700 });
  return resolution;
}
