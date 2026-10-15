import type { ApiResponse, CoreService } from "./service.js";
import { SCHEMA_VERSION } from "@taric/schemas";
import {
  runAuthorityRuntimeConformance,
  AUTHORITY_BACKEND_METHODS,
  runtimeConformancePassed,
  type AuthorityBackend,
  type AuthorityRuntimeConformance,
  type AuthorityRuntimeScenario,
  type MaybePromise,
} from "./storage-contract.js";

export interface SharedBackendHealth { available: boolean; fencing: boolean; schema_version: string; }
export interface SharedRuntimeDispatcher {
  dispatch(...args: Parameters<CoreService["dispatch"]>): Promise<ApiResponse<unknown>>;
}
export interface SharedRuntimeActivation {
  implementation_state: "available";
  runtime_state: "enabled" | "disabled";
  evidence_state: "verified" | "failed";
  code: "ready" | "backend_conformance_failed" | "postgresql_unavailable";
  conformance: AuthorityRuntimeConformance;
  service?: SharedRuntimeDispatcher;
}

/** This factory has no SQLite path/factory and cannot create a fallback authority.
 * Primitive-only backends fail before health/migrations or service construction.
 * The accepted service implements Core governance rather than backend policy. */
export async function createSharedAuthorityRuntime(input: {
  backend: Partial<AuthorityBackend>;
  scenarios?: Partial<Record<AuthorityRuntimeScenario, () => MaybePromise<readonly string[]>>>;
  /** Evidence from an explicit isolated conformance run. Startup never creates
   * test records in a production authority. Backend methods are checked again. */
  conformance?: AuthorityRuntimeConformance;
  health: () => MaybePromise<SharedBackendHealth>;
  createService: (backend: AuthorityBackend) => MaybePromise<Pick<CoreService, "dispatch"> | SharedRuntimeDispatcher>;
}): Promise<SharedRuntimeActivation> {
  let conformance: AuthorityRuntimeConformance;
  if (input.conformance) {
    const missing = AUTHORITY_BACKEND_METHODS.filter((method) => typeof input.backend[method] !== "function");
    const valid = runtimeConformancePassed(input.conformance) && missing.length === 0;
    conformance = {
      ...input.conformance,
      passed: valid,
      missing_methods: missing,
      failures: valid ? [] : [...input.conformance.failures, ...missing.map((method) => `missing backend method: ${method}`), ...(!runtimeConformancePassed(input.conformance) ? ["runtime conformance evidence is incomplete"] : [])],
    };
  } else conformance = await runAuthorityRuntimeConformance(input.backend, input.scenarios ?? {});
  const disabled = { implementation_state: "available", runtime_state: "disabled", evidence_state: "failed", conformance } as const;
  if (!conformance.passed) return { ...disabled, code: "backend_conformance_failed" };
  const healthy = async (): Promise<boolean> => {
    try { const health = await input.health(); return health.available === true && health.fencing === true && health.schema_version === SCHEMA_VERSION; }
    catch { return false; }
  };
  if (!await healthy()) return { ...disabled, code: "postgresql_unavailable" };
  let core: Pick<CoreService, "dispatch"> | SharedRuntimeDispatcher;
  try { core = await input.createService(input.backend as AuthorityBackend); }
  catch { return { ...disabled, code: "postgresql_unavailable" }; }
  return {
    implementation_state: "available", runtime_state: "enabled", evidence_state: "verified", code: "ready", conformance,
    service: {
      async dispatch(...args) {
        // Losing connectivity/fencing blocks subsequent writes and reads rather
        // than handing a client a new independent authority.
        if (!await healthy()) return { ok: false, error: { code: "unavailable_host", message: "shared authority is unavailable; writes are blocked" } };
        try { return await core.dispatch(...args); }
        catch { return { ok: false, error: { code: "internal_error", message: "internal error" } }; }
      },
    },
  };
}
