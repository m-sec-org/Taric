import { createHash } from "node:crypto";
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
  /**
   * An explicit runtime configuration file. This is intentionally separate
   * from transport/listener configuration. When supplied, the file is strict:
   * missing or invalid input fails startup and never falls back to ambient
   * workspace or home configuration.
   */
  runtimeConfigPath?: string;
  /** Provenance captured by a caller that already performed discovery. */
  runtimeConfigProvenance?: RuntimeConfigProvenance;
  /** A test-only home lets callers avoid touching the real user directory. */
  test?: boolean;
}

export type RuntimeConfigSource = "explicit" | "environment" | "workspace" | "home" | "default";

/** Safe, non-secret identity of the selected runtime configuration. */
export interface RuntimeConfigProvenance {
  source: RuntimeConfigSource;
  digest: string;
  /** Local operator diagnostics may use this path; remote callers must redact it. */
  path?: string;
}

export type RuntimeValueSource = "environment" | "config" | "default";

/** Which non-secret source supplied each process-facing runtime value. */
export interface RuntimeConfigurationPrecedence {
  authority: RuntimeValueSource;
  db_path: RuntimeValueSource;
  content_root: RuntimeValueSource;
  content_root_mode: "configured" | "derived";
  principal_id: RuntimeValueSource;
  principal_role: RuntimeValueSource;
  engagement_id: RuntimeValueSource;
  content_read_enabled: RuntimeValueSource;
  runtime_conformance_path: RuntimeValueSource;
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
  runtimeConfigProvenance: RuntimeConfigProvenance;
  precedence: RuntimeConfigurationPrecedence;
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

const configDigest = (raw: string | Buffer): string => `sha256:${createHash("sha256").update(raw).digest("hex")}`;

function validateRuntimeConfig(value: unknown): RuntimeStartupConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthorityConfigurationError("invalid Taric configuration");
  const config = value as RuntimeStartupConfig;
  if (config.principal_role !== undefined && !["operator", "model", "host", "reviewer", "writer"].includes(config.principal_role)) throw new AuthorityConfigurationError("invalid principal role in Taric configuration");
  for (const key of ["db_path", "principal_id", "engagement_id", "content_root", "runtime_conformance_path"] as const) if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key]!.trim())) throw new AuthorityConfigurationError("invalid path or principal context in Taric configuration");
  if (config.content_read_enabled !== undefined && typeof config.content_read_enabled !== "boolean") throw new AuthorityConfigurationError("invalid content-read setting in Taric configuration");
  for (const key of ["authority", "deployment"] as const) if (config[key] !== undefined && (!config[key] || typeof config[key] !== "object" || Array.isArray(config[key]))) throw new AuthorityConfigurationError("invalid authority deployment in Taric configuration");
  return config;
}

function readRuntimeConfigFile(path: string, source: RuntimeConfigSource): { config: RuntimeStartupConfig; provenance: RuntimeConfigProvenance } {
  let raw: Buffer;
  try { raw = readFileSync(path); }
  catch { throw new AuthorityConfigurationError(source === "explicit" ? "explicit runtime configuration file is unavailable" : "invalid Taric configuration"); }
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); }
  catch { throw new AuthorityConfigurationError(source === "explicit" ? "explicit runtime configuration is invalid" : "invalid Taric configuration"); }
  return {
    config: validateRuntimeConfig(value),
    provenance: { source, digest: configDigest(raw), path: resolve(path) },
  };
}

/** Shared entrypoint config discovery. Errors contain no caller-controlled
 * values or filesystem paths, so MCP diagnostics are safe to serialize. */
export function discoverRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir(), explicitPath?: string): { config: RuntimeStartupConfig; path?: string; provenance: RuntimeConfigProvenance } {
  if (explicitPath !== undefined) {
    if (typeof explicitPath !== "string" || !explicitPath.trim()) throw new AuthorityConfigurationError("explicit runtime configuration path is required");
    const selected = readRuntimeConfigFile(explicitPath, "explicit");
    return { ...selected, path: explicitPath };
  }
  const candidates = [
    ...(env.TARIC_CONFIG ? [{ path: env.TARIC_CONFIG, source: "environment" as const }] : []),
    { path: join(cwd, ".taric", "config.json"), source: "workspace" as const },
    { path: join(home, ".taric", "config.json"), source: "home" as const },
  ].filter((candidate, index, all) => all.findIndex((item) => item.path === candidate.path) === index);
  for (const candidate of candidates) {
    const { path } = candidate;
    if (!existsSync(path)) continue;
    const selected = readRuntimeConfigFile(path, candidate.source);
    return { ...selected, path };
  }
  const raw = "{}";
  return { config: {}, provenance: { source: "default", digest: configDigest(raw) } };
}

/** Resolve all process-facing authority decisions before constructing a store. */
export function resolveRuntimeAuthority(options: RuntimeStartupOptions = {}): RuntimeStartupResolution {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const discovered = options.config === undefined
    ? discoverRuntimeConfig(env, options.cwd ?? process.cwd(), home, options.runtimeConfigPath)
    : undefined;
  const config = options.config ?? discovered!.config;
  const runtimeConfigProvenance = options.runtimeConfigProvenance ?? discovered?.provenance ?? { source: "default" as const, digest: configDigest("{}") };
  // An explicit source is a complete deployment unit. Do not let ambient
  // environment values silently select a different authority or content root.
  const ambient = runtimeConfigProvenance.source !== "explicit";
  const authorityInput = config.authority ?? (ambient ? envAuthority(env) : undefined);
  const authority = resolveAuthorityConfiguration(authorityInput);
  // `resolveAuthorityConfiguration` keeps its library/test default as
  // `:memory:`. Runtime entrypoints only honor memory when it was explicitly
  // requested in TARIC_DB or authority.sqlite.path.
  const configuredSqlitePath = authorityInput && authority.backend === "sqlite" && "sqlite" in authorityInput && authorityInput.sqlite?.path
    ? authorityInput.sqlite.path
    : undefined;
  const dbPath = (ambient ? env.TARIC_DB : undefined) ?? config.db_path ?? configuredSqlitePath ?? join(home, ".taric", "authority.sqlite");
  const explicitMemory = dbPath === ":memory:";
  const contentRoot = (ambient ? env.TARIC_CONTENT_ROOT : undefined) ?? config.content_root ?? (explicitMemory
    ? join(tmpdir(), "taric-content", uuidv7())
    : join(dirname(resolve(dbPath)), "content"));
  const role = ((ambient ? env.TARIC_PRINCIPAL_ROLE : undefined) ?? config.principal_role ?? "operator") as RuntimePrincipalContext["role"];
  if (!["operator", "model", "host", "reviewer", "writer"].includes(role)) throw new AuthorityConfigurationError("invalid runtime principal role");
  if (typeof dbPath !== "string" || !dbPath.trim() || typeof contentRoot !== "string" || !contentRoot.trim()) throw new AuthorityConfigurationError("invalid authority or content root");
  const engagement = (ambient ? env.TARIC_ENGAGEMENT_ID : undefined) ?? config.engagement_id;
  const principal: RuntimePrincipalContext = {
    id: (ambient ? env.TARIC_PRINCIPAL_ID : undefined) ?? config.principal_id ?? (role === "model" ? "mcp-model" : "operator-local"),
    role,
    ...(engagement ? { engagement_id: engagement } : {}),
    capabilities: (ambient ? env.TARIC_CONTENT_READ_ENABLED === "true" : false) || config.content_read_enabled === true ? ["content_read"] : [],
  };
  const diagnostics = authorityStartupDiagnostics(authority, authority.backend === "postgresql" ? false : undefined, config.deployment);
  const precedence: RuntimeConfigurationPrecedence = {
    authority: config.authority !== undefined ? "config" : ambient && env.TARIC_AUTHORITY_PROFILE ? "environment" : "default",
    db_path: ambient && env.TARIC_DB ? "environment" : config.db_path !== undefined || configuredSqlitePath !== undefined ? "config" : "default",
    content_root: ambient && env.TARIC_CONTENT_ROOT ? "environment" : config.content_root !== undefined ? "config" : "default",
    content_root_mode: ambient && env.TARIC_CONTENT_ROOT || config.content_root !== undefined ? "configured" : "derived",
    principal_id: ambient && env.TARIC_PRINCIPAL_ID ? "environment" : config.principal_id !== undefined ? "config" : "default",
    principal_role: ambient && env.TARIC_PRINCIPAL_ROLE ? "environment" : config.principal_role !== undefined ? "config" : "default",
    engagement_id: ambient && env.TARIC_ENGAGEMENT_ID ? "environment" : config.engagement_id !== undefined ? "config" : "default",
    content_read_enabled: ambient && env.TARIC_CONTENT_READ_ENABLED === "true" ? "environment" : config.content_read_enabled !== undefined ? "config" : "default",
    runtime_conformance_path: ambient && env.TARIC_RUNTIME_CONFORMANCE ? "environment" : config.runtime_conformance_path !== undefined ? "config" : "default",
  };
  const immutableAuthority = Object.freeze({
    ...authority,
    ...(authority.sqlite ? { sqlite: Object.freeze({ ...authority.sqlite }) } : {}),
    ...(authority.postgresql ? { postgresql: Object.freeze({ ...authority.postgresql }) } : {}),
  });
  const immutablePrincipal = Object.freeze({ ...principal, capabilities: Object.freeze([...principal.capabilities]) });
  return Object.freeze({ authority: immutableAuthority, dbPath, contentRoot, principal: immutablePrincipal, diagnostics: Object.freeze(diagnostics), explicitMemory, runtimeConfigProvenance: Object.freeze(runtimeConfigProvenance), precedence: Object.freeze(precedence) });
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
