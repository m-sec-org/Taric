import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { coreSchema, SCHEMA_VERSION } from "@taric/schemas";
import { policyDigest } from "./policy.js";
import { createCoreService, createCoreServiceForPath, type CoreService } from "./service.js";
import { PostgresAuthorityStore } from "./postgres.js";
import { authorityStartupDiagnostics } from "./shared-authority-config.js";
import { createSharedAuthorityRuntime } from "./shared-runtime.js";
import { runtimeConformancePassed, type AuthorityRuntimeConformance } from "./storage-contract.js";
import { discoverRuntimeConfig, requireRuntimeAuthority, resolveRuntimeAuthority, RuntimeStartupError, type RuntimeStartupOptions } from "./runtime-startup.js";
import { runtimeImplementationDigest } from "./implementation-digest.js";

const digest = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export { runtimeImplementationDigest };

export interface RuntimeActivationEvidence {
  version: "taric-runtime-activation/1";
  backend: "postgresql";
  implementation_digest: string;
  schema_version: string;
  schema_digest: string;
  policy_digest: string;
  generated_at: string;
  runtime_conformance: AuthorityRuntimeConformance;
}

export function buildRuntimeActivationEvidence(runtime_conformance: AuthorityRuntimeConformance): RuntimeActivationEvidence {
  if (!runtimeConformancePassed(runtime_conformance)) throw new TypeError("complete passing runtime conformance evidence is required");
  return {
    version: "taric-runtime-activation/1", backend: "postgresql",
    implementation_digest: runtimeImplementationDigest(), schema_version: SCHEMA_VERSION,
    schema_digest: digest(JSON.stringify(coreSchema)), policy_digest: policyDigest(),
    generated_at: new Date().toISOString(), runtime_conformance,
  };
}

function readActivationEvidence(path: string): AuthorityRuntimeConformance {
  const value = JSON.parse(readFileSync(path, "utf8")) as RuntimeActivationEvidence;
  if (!value || value.version !== "taric-runtime-activation/1" || value.backend !== "postgresql"
    || value.implementation_digest !== runtimeImplementationDigest()
    || value.schema_version !== SCHEMA_VERSION || value.schema_digest !== digest(JSON.stringify(coreSchema))
    || value.policy_digest !== policyDigest() || !Number.isFinite(Date.parse(value.generated_at))
    || !runtimeConformancePassed(value.runtime_conformance)) throw new TypeError("runtime activation evidence does not match this implementation");
  return value.runtime_conformance;
}

/** Both entrypoints construct the selected authority here. A PostgreSQL failure
 * has no path to a SQLite constructor, and startup never runs mutating fixtures. */
export async function openRuntimeService(options: RuntimeStartupOptions = {}): Promise<CoreService> {
  const env = options.env ?? process.env;
  const discovered = options.config === undefined
    ? discoverRuntimeConfig(env, options.cwd, options.home, options.runtimeConfigPath)
    : undefined;
  const config = options.config ?? discovered!.config;
  const resolution = resolveRuntimeAuthority({
    ...options,
    config,
    env,
    runtimeConfigProvenance: options.runtimeConfigProvenance ?? discovered?.provenance,
  });
  if (resolution.authority.backend === "sqlite") {
    const startup = requireRuntimeAuthority({ ...options, config, env, runtimeConfigProvenance: resolution.runtimeConfigProvenance });
    return await createCoreServiceForPath(startup.dbPath, startup.contentRoot);
  }
  const disabled = (message: string, code: "backend_conformance_failed" | "postgresql_unavailable") => new RuntimeStartupError({
    ...resolution.diagnostics, ok: false, enabled: false, runtime_state: "disabled", evidence_state: "failed", code, message,
  });
  const evidencePath = resolution.runtimeConfigProvenance.source === "explicit"
    ? config.runtime_conformance_path
    : env.TARIC_RUNTIME_CONFORMANCE ?? config.runtime_conformance_path;
  if (!evidencePath) throw new RuntimeStartupError(resolution.diagnostics);
  let conformance: AuthorityRuntimeConformance;
  try { conformance = readActivationEvidence(evidencePath); }
  catch { throw disabled("PostgreSQL runtime conformance evidence is absent, failed, or does not match this implementation", "backend_conformance_failed"); }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: resolution.authority.postgresql!.connection_string, max: 8, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
  // Idle connection errors must not print credentials or crash the transport.
  pool.on("error", () => undefined);
  const backend = new PostgresAuthorityStore(pool, { profile: "multi_host_authority", migrate: false });
  try {
    const health = async () => {
      const report = await backend.runtimeReadiness(conformance);
      return { available: report.runtime_state === "enabled" && report.code === "ready" && report.health.available && report.health.schema_valid, fencing: report.health.fencing, schema_version: SCHEMA_VERSION };
    };
    const initialHealth = await health();
    const diagnostics = authorityStartupDiagnostics(resolution.authority, initialHealth.available && initialHealth.fencing, config.deployment, conformance);
    if (!diagnostics.ok) throw new RuntimeStartupError(diagnostics);
    mkdirSync(resolution.contentRoot, { recursive: true, mode: 0o700 });
    let core: CoreService | undefined;
    const activation = await createSharedAuthorityRuntime({
      backend, conformance, health,
      createService: async () => { core = await createCoreService(backend, resolution.contentRoot); return core; },
    });
    if (!activation.service || !core) throw disabled("PostgreSQL shared authority failed runtime activation", activation.code === "postgresql_unavailable" ? "postgresql_unavailable" : "backend_conformance_failed");
    let closed = false;
    const guarded = { ...core, dispatch: activation.service.dispatch };
    for (const key of Object.keys(core) as Array<keyof CoreService>) {
      if (key === "close" || key === "dispatch") continue;
      const method = core[key] as (...args: unknown[]) => Promise<unknown>;
      Object.assign(guarded, { [key]: async (...args: unknown[]) => {
        let current: Awaited<ReturnType<typeof health>>;
        try { current = await health(); }
        catch { return { ok: false, error: { code: "unavailable_host", message: "shared authority is unavailable; writes are blocked" } }; }
        if (!current.available || !current.fencing) return { ok: false, error: { code: "unavailable_host", message: "shared authority is unavailable; writes are blocked" } };
        return method(...args);
      } });
    }
    return { ...guarded, async close() { if (closed) return; closed = true; await backend.close(); await pool.end(); } };
  } catch (cause) {
    await pool.end().catch(() => undefined);
    if (cause instanceof RuntimeStartupError) throw cause;
    throw disabled("PostgreSQL shared authority is unavailable; authority writes are blocked", "postgresql_unavailable");
  }
}
