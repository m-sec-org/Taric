import { SCHEMA_VERSION } from "@taric/schemas";
import { policyDigest } from "./policy.js";
import { checkDeploymentGuard, type DeploymentGuardResult } from "./deployment-guard.js";
import { runtimeConformancePassed, type AuthorityRuntimeConformance } from "./storage-contract.js";

export const SINGLE_HOST_SQLITE_PROFILE = "single_host_sqlite" as const;
export const MULTI_HOST_AUTHORITY_PROFILE = "multi_host_authority" as const;
export const POSTGRESQL_SUPPORTED_MAJOR_VERSIONS = [14, 15, 16, 17, 18] as const;
export const SHARED_AUTHORITY_BACKEND_MANIFEST_VERSION = "1.0" as const;

export type AuthorityDeploymentProfile = typeof SINGLE_HOST_SQLITE_PROFILE | typeof MULTI_HOST_AUTHORITY_PROFILE;
export interface SingleHostSqliteConfiguration {
  profile?: typeof SINGLE_HOST_SQLITE_PROFILE;
  sqlite?: { path?: string };
}
export interface MultiHostAuthorityConfiguration {
  profile: typeof MULTI_HOST_AUTHORITY_PROFILE;
  postgresql: { connection_string: string };
  host_id: string;
  lease_mode: "server_side";
}
export type SharedAuthorityConfiguration = SingleHostSqliteConfiguration | MultiHostAuthorityConfiguration;
export interface ResolvedAuthorityConfiguration {
  profile: AuthorityDeploymentProfile;
  backend: "sqlite" | "postgresql";
  enabled: boolean;
  sqlite?: { path: string };
  postgresql?: { connection_string: string };
  host_id: string | null;
  lease_mode: "local" | "server_side";
}

export interface SharedAuthorityBackendManifest {
  manifest_version: typeof SHARED_AUTHORITY_BACKEND_MANIFEST_VERSION;
  default_profile: typeof SINGLE_HOST_SQLITE_PROFILE;
  profiles: {
    single_host_sqlite: { backend: "sqlite"; default: true; enabled: true; postgres_dependency: false; lease_mode: "local" };
    multi_host_authority: { backend: "postgresql"; default: false; enabled: false; implementation_state: "available"; runtime_state: "disabled"; evidence_state: "verified"; postgres_dependency: "optional"; lease_mode: "server_side" };
  };
  postgresql: { minimum_major: number; maximum_major: number; supported_majors: readonly number[]; version_source: "postgresql.org/support/versioning" };
  schema_version: string;
  api_version: "1.0.0";
  policy_digest: string;
}

export const SHARED_AUTHORITY_BACKEND_MANIFEST: SharedAuthorityBackendManifest = Object.freeze({
  manifest_version: SHARED_AUTHORITY_BACKEND_MANIFEST_VERSION,
  default_profile: SINGLE_HOST_SQLITE_PROFILE,
  profiles: {
    single_host_sqlite: { backend: "sqlite", default: true, enabled: true, postgres_dependency: false, lease_mode: "local" },
    multi_host_authority: { backend: "postgresql", default: false, enabled: false, implementation_state: "available", runtime_state: "disabled", evidence_state: "verified", postgres_dependency: "optional", lease_mode: "server_side" },
  },
  postgresql: {
    minimum_major: POSTGRESQL_SUPPORTED_MAJOR_VERSIONS[0],
    maximum_major: POSTGRESQL_SUPPORTED_MAJOR_VERSIONS.at(-1)!,
    supported_majors: POSTGRESQL_SUPPORTED_MAJOR_VERSIONS,
    version_source: "postgresql.org/support/versioning",
  },
  schema_version: SCHEMA_VERSION,
  api_version: "1.0.0",
  policy_digest: policyDigest(),
} as const);

export type AuthorityDiagnosticCode = "ready" | "postgresql_unavailable" | "backend_conformance_failed" | "unsupported_deployment" | "configuration_invalid";
export interface AuthorityStartupDiagnostics {
  ok: boolean;
  enabled: boolean;
  profile: AuthorityDeploymentProfile;
  backend: "sqlite" | "postgresql";
  schema_version: string;
  policy_digest: string;
  host_id: string | null;
  lease_mode: "local" | "server_side";
  code: AuthorityDiagnosticCode;
  message: string;
  follow_up?: string;
  deployment_guard?: DeploymentGuardResult;
  implementation_state: "available";
  runtime_state: "enabled" | "disabled";
  evidence_state: "verified" | "pending" | "failed";
}

export class AuthorityConfigurationError extends Error {
  readonly code = "configuration_invalid" as const;
  constructor(message: string) { super(message); this.name = "AuthorityConfigurationError"; }
}

/** Resolve configuration without loading a PostgreSQL driver. An omitted config is the local SQLite profile. */
export function resolveAuthorityConfiguration(input?: SharedAuthorityConfiguration): ResolvedAuthorityConfiguration {
  if (input === undefined) return { profile: SINGLE_HOST_SQLITE_PROFILE, backend: "sqlite", enabled: true, sqlite: { path: ":memory:" }, host_id: null, lease_mode: "local" };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AuthorityConfigurationError("authority configuration must be an object");
  const rawInput = input as SharedAuthorityConfiguration & Record<string, unknown>;
  const profile = rawInput.profile ?? SINGLE_HOST_SQLITE_PROFILE;
  if (profile === SINGLE_HOST_SQLITE_PROFILE) {
    if ("postgresql" in rawInput || "host_id" in rawInput || "lease_mode" in rawInput) throw new AuthorityConfigurationError("single_host_sqlite cannot include multi-host PostgreSQL or lease settings");
    const sqlite = (input as SingleHostSqliteConfiguration).sqlite;
    const path = sqlite?.path ?? ":memory:";
    if (typeof path !== "string" || path.trim() === "") throw new AuthorityConfigurationError("sqlite.path must be a non-empty path");
    return { profile, backend: "sqlite", enabled: true, sqlite: { path }, host_id: null, lease_mode: "local" };
  }
  if (profile !== MULTI_HOST_AUTHORITY_PROFILE) throw new AuthorityConfigurationError(`unsupported authority profile: ${String(profile)}`);
  const multi = input as MultiHostAuthorityConfiguration;
  if (!multi.postgresql || typeof multi.postgresql.connection_string !== "string" || multi.postgresql.connection_string.trim() === "") throw new AuthorityConfigurationError("multi_host_authority requires postgresql.connection_string");
  if (typeof multi.host_id !== "string" || multi.host_id.trim() === "") throw new AuthorityConfigurationError("multi_host_authority requires a non-empty host_id");
  if (multi.lease_mode !== "server_side") throw new AuthorityConfigurationError("multi_host_authority requires lease_mode=server_side");
  return { profile, backend: "postgresql", enabled: false, postgresql: { connection_string: multi.postgresql.connection_string }, host_id: multi.host_id, lease_mode: "server_side" };
}

/** Build startup diagnostics from an explicit service availability probe. No probe means the selected backend is not ready. */
export function authorityStartupDiagnostics(config: ResolvedAuthorityConfiguration, postgresqlAvailable?: boolean, deploymentFacts: Parameters<typeof checkDeploymentGuard>[0] = {}, conformance?: AuthorityRuntimeConformance): AuthorityStartupDiagnostics {
  const unavailable = config.backend === "postgresql" && postgresqlAvailable !== true;
  const primitiveOnly = config.backend === "postgresql" && !runtimeConformancePassed(conformance);
  const observedService = deploymentFacts.authority_service ?? deploymentFacts.authorityService ?? {};
  const deploymentGuard = checkDeploymentGuard({
    ...deploymentFacts,
    profile: config.profile,
    backend: config.backend,
    authority_service: config.backend === "postgresql"
      ? {
          configured: observedService.configured ?? true,
          available: postgresqlAvailable === true,
          shared: observedService.shared ?? postgresqlAvailable === true,
          count: observedService.count ?? (postgresqlAvailable === true ? 1 : 0),
          ...(observedService.endpoint ? { endpoint: observedService.endpoint } : {}),
        }
      : {},
  });
  return {
    ok: !unavailable && !primitiveOnly && deploymentGuard.supported,
    enabled: !unavailable && !primitiveOnly && deploymentGuard.supported,
    profile: config.profile,
    backend: config.backend,
    schema_version: SCHEMA_VERSION,
    policy_digest: policyDigest(),
    host_id: config.host_id,
    lease_mode: config.lease_mode,
    code: !deploymentGuard.supported && config.backend === "sqlite" ? "unsupported_deployment" : unavailable || !deploymentGuard.supported ? "postgresql_unavailable" : primitiveOnly ? "backend_conformance_failed" : "ready",
    message: unavailable ? "PostgreSQL shared authority is unavailable; authority writes are blocked" : !deploymentGuard.supported ? "authority deployment is unsupported" : primitiveOnly ? "matching full Core runtime conformance evidence is required before PostgreSQL activation" : `${config.profile} authority is ready`,
    ...(!deploymentGuard.supported || unavailable || primitiveOnly ? { follow_up: primitiveOnly ? "complete shared Core runtime conformance and retry startup" : "restore authority service/configuration and retry startup" } : {}),
    deployment_guard: deploymentGuard,
    implementation_state: "available",
    runtime_state: !unavailable && !primitiveOnly && deploymentGuard.supported ? "enabled" : "disabled",
    evidence_state: primitiveOnly ? conformance ? "failed" : "pending" : "verified",
  };
}
