/**
 * Deterministic deployment boundary checks for the optional shared authority.
 *
 * This module deliberately does not inspect the filesystem or contact a
 * service. Startup/health callers provide the observed deployment facts, and
 * this validator turns them into a stable result or a stable error.
 */

export const UNSUPPORTED_DEPLOYMENT_CODE = "unsupported_deployment" as const;

export type DeploymentProfile = "single_host_sqlite" | "multi_host_authority";
export type DeploymentBackend = "sqlite" | "postgresql";

export interface AuthorityServiceObservation {
  /** Whether a shared authority service was configured. */
  configured?: boolean;
  /** Whether the configured service passed its connectivity/health check. */
  available?: boolean;
  /** Whether all hosts use this same authority service. */
  shared?: boolean;
  /** Number of authority services advertised by the deployment. */
  count?: number;
  endpoint?: string;
}

export interface DeploymentGuardInput {
  profile?: DeploymentProfile | string;
  backend?: DeploymentBackend | string;
  /** A multi-host declaration is invalid with SQLite, even when profile is omitted. */
  multi_host?: boolean;
  host_count?: number;
  sqlite_path?: string;
  /** True when the SQLite path is visible to more than one host. */
  shared_sqlite_path?: boolean;
  /** True when a SQLite path uses NFS or another non-local lock implementation. */
  nfs_lock?: boolean;
  /** Number of independent SQLite authority copies claimed as one deployment. */
  sqlite_replica_count?: number;
  independent_sqlite_replicas?: boolean;
  /** A shared Git clone can be a projection, never an authority. */
  shared_git_clone?: boolean;
  /** True when Git/Markdown is being declared as the authority lock/order source. */
  git_authority?: boolean;
  authority_service?: AuthorityServiceObservation;
  /** Accept the common camelCase spelling used by JSON callers as well. */
  sharedSqlitePath?: boolean;
  nfsLock?: boolean;
  sqliteReplicaCount?: number;
  independentSqliteReplicas?: boolean;
  sharedGitClone?: boolean;
  gitAuthority?: boolean;
  hostCount?: number;
  multiHost?: boolean;
  authorityService?: AuthorityServiceObservation;
}

export interface DeploymentDiagnostics {
  profile: DeploymentProfile;
  backend: DeploymentBackend;
  enabled: boolean;
  host_count: number;
  lease_mode: "local_process" | "server_fenced";
  authority_service: {
    configured: boolean;
    available: boolean;
    shared: boolean;
    count: number;
    endpoint?: string;
  };
}

export interface DeploymentGuardResult {
  supported: boolean;
  code?: typeof UNSUPPORTED_DEPLOYMENT_CODE;
  reasons: readonly string[];
  diagnostics: DeploymentDiagnostics;
}

export class UnsupportedDeploymentError extends Error {
  readonly code = UNSUPPORTED_DEPLOYMENT_CODE;
  readonly reasons: readonly string[];
  readonly diagnostics: DeploymentDiagnostics;

  constructor(result: DeploymentGuardResult) {
    super(result.reasons.join("; ") || "deployment is unsupported");
    this.name = "UnsupportedDeploymentError";
    this.reasons = result.reasons;
    this.diagnostics = result.diagnostics;
  }
}

function bool(value: unknown): boolean {
  return value === true;
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function profileOf(input: DeploymentGuardInput): DeploymentProfile {
  if (input.profile === undefined || input.profile === "") return "single_host_sqlite";
  if (input.profile === "single_host_sqlite" || input.profile === "multi_host_authority") return input.profile;
  // Keep invalid profile values in the unsupported result instead of silently
  // selecting a backend. The caller still receives a typed diagnostic.
  return "multi_host_authority";
}

function backendOf(input: DeploymentGuardInput): DeploymentBackend {
  if (input.backend === undefined || input.backend === "") return "sqlite";
  if (input.backend === "sqlite" || input.backend === "postgresql") return input.backend;
  return "sqlite";
}

/** Validate the explicit deployment boundary without performing I/O. */
export function checkDeploymentGuard(input: DeploymentGuardInput = {}): DeploymentGuardResult {
  const profile = profileOf(input);
  const backend = backendOf(input);
  const service = input.authority_service ?? input.authorityService ?? {};
  const hosts = count(input.host_count ?? input.hostCount, 1);
  const serviceCount = count(service.count, 0);
  const configured = bool(service.configured) || typeof service.endpoint === "string" && service.endpoint.length > 0;
  const available = bool(service.available);
  const shared = bool(service.shared);
  const multiHost = bool(input.multi_host ?? input.multiHost) || profile === "multi_host_authority" || hosts > 1;
  const sharedSqlite = bool(input.shared_sqlite_path ?? input.sharedSqlitePath);
  const nfsLock = bool(input.nfs_lock ?? input.nfsLock);
  const replicaCount = count(input.sqlite_replica_count ?? input.sqliteReplicaCount, 1);
  const independentReplicas = bool(input.independent_sqlite_replicas ?? input.independentSqliteReplicas) || replicaCount > 1;
  const sharedGit = bool(input.shared_git_clone ?? input.sharedGitClone);
  const gitAuthority = bool(input.git_authority ?? input.gitAuthority);
  const reasons: string[] = [];

  if (input.profile !== undefined && input.profile !== "single_host_sqlite" && input.profile !== "multi_host_authority") {
    reasons.push(`unsupported deployment profile: ${String(input.profile)}`);
  }
  if (input.backend !== undefined && input.backend !== "sqlite" && input.backend !== "postgresql") {
    reasons.push(`unsupported authority backend: ${String(input.backend)}`);
  }
  if (hosts < 1) reasons.push("host_count must be at least 1");
  if (replicaCount < 1) reasons.push("sqlite_replica_count must be at least 1");
  if (profile === "single_host_sqlite" && backend !== "sqlite") reasons.push("single_host_sqlite requires the SQLite backend");
  if (profile === "multi_host_authority" && backend !== "postgresql") reasons.push("multi_host_authority requires the PostgreSQL backend");
  if (multiHost && backend === "sqlite") reasons.push("shared authority cannot use a shared or replicated SQLite file; configure one PostgreSQL authority service");
  if (sharedSqlite) reasons.push("shared SQLite paths are unsupported as authority");
  if (nfsLock) reasons.push("NFS or network filesystem locks are unsupported as authority coordination");
  if (independentReplicas) reasons.push("independent SQLite replicas cannot provide shared authority ordering");
  if (sharedGit) reasons.push("shared Git clones are projections and cannot provide authority locking or event ordering");
  if (gitAuthority) reasons.push("Git/Markdown cannot be declared as the authority");

  if (profile === "multi_host_authority") {
    if (!configured) reasons.push("multi_host_authority requires a configured PostgreSQL service");
    if (!available) reasons.push("multi_host_authority PostgreSQL service is unavailable");
    if (!shared) reasons.push("all multi-host instances must use one shared PostgreSQL authority service");
    if (serviceCount !== 1) reasons.push("multi_host_authority requires exactly one shared authority service");
  } else if (configured || available || shared || serviceCount > 1) {
    reasons.push("PostgreSQL service configuration requires the multi_host_authority profile");
  }

  const diagnostics: DeploymentDiagnostics = {
    profile,
    backend,
    enabled: reasons.length === 0 && (profile === "multi_host_authority" ? available : true),
    host_count: hosts,
    lease_mode: profile === "multi_host_authority" ? "server_fenced" : "local_process",
    authority_service: { configured, available, shared, count: serviceCount, ...(service.endpoint ? { endpoint: service.endpoint } : {}) },
  };
  return reasons.length === 0
    ? { supported: true, reasons: [], diagnostics }
    : { supported: false, code: UNSUPPORTED_DEPLOYMENT_CODE, reasons, diagnostics: { ...diagnostics, enabled: false } };
}

/** Throw a stable, structured error when the deployment facts are unsupported. */
export function assertDeploymentSupported(input: DeploymentGuardInput = {}): DeploymentDiagnostics {
  const result = checkDeploymentGuard(input);
  if (!result.supported) throw new UnsupportedDeploymentError(result);
  return result.diagnostics;
}

/** Alias used by startup/health integrations. */
export const validateDeployment = checkDeploymentGuard;

