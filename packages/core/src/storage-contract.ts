import type { AuthorityStore, CanonicalRecord, DoctorReport, ReadSnapshot, TrustLevel, AuditEvent } from "./store.js";
import type { PostgresAuthorityStore } from "./postgres.js";

export const AUTHORITY_STORAGE_CONTRACT_VERSION = "authority-storage/3" as const;

/** Observable guarantees all authority backends must implement; database-specific mechanics remain private. */
export const AUTHORITY_STORAGE_INVARIANTS = [
  "atomic_record_event_idempotency_outbox_commit",
  "expected_version_compare_and_set",
  "uuidv7_primary_identity_and_global_display_sequence",
  "strictly_ordered_audit_event_sequence",
  "pinned_snapshot_read_sequence_and_watermarks",
  "integrity_checked_snapshot_backup_and_atomic_restore",
  "lease_expiry_heartbeat_reclaim_and_fencing_generation",
  "atomic_admission_bound_review_snapshot_and_policy_binding",
] as const;
export type AuthorityStorageInvariant = typeof AUTHORITY_STORAGE_INVARIANTS[number];

/** Method surface used by the shared SQLite/PostgreSQL conformance scenarios. */
export interface AuthorityStorageContract {
  close(): Promise<void>;
  commit(record: CanonicalRecord, trustLevel?: TrustLevel, idempotencyKey?: string, context?: { operation?: string; principal?: string; engagement_id?: string; expected_version?: number }): Promise<CanonicalRecord>;
  compareAndSet(id: string, expectedVersion: number, patch: Record<string, unknown>, trustLevel?: TrustLevel): Promise<CanonicalRecord>;
  snapshot(engagementId: string, options?: { trustLevel?: TrustLevel; includeCandidates?: boolean; asOf?: number }): Promise<ReadSnapshot>;
  exportSnapshot(engagementId: string, asOf?: number): Promise<{ schema_version: string; engagement_id: string; read_seq: number; committed_seq: number; projected_seq: number; records: CanonicalRecord[]; hash: string }>;
  importSnapshot(snapshot: unknown): Promise<{ engagement_id: string; recovered_sequence: number; imported_records: number; integrity_verified: true; display_sequence: number }>;
  claimWorkRun(input: { run_id?: string; work_item_id: string; engagement_id: string; host_id: string; agent_id: string; ttl_ms?: number }): Promise<object>;
  renewWorkRun(runId: string, generation: number, hostId: string, ttlMs?: number): Promise<object>;
  reclaimWorkRun(runId: string, hostId: string, agentId: string, ttlMs?: number): Promise<object>;
  events(): Promise<AuditEvent[]>;
  verifyAudit(): Promise<{ valid: boolean; errors: string[] }>;
  consumeOutbox(limit?: number): Promise<Array<Record<string, unknown>>>;
  doctor(): Promise<DoctorReport>;
}

export type MaybePromise<T> = T | Promise<T>;

/** Core's complete asynchronous persistence surface. Policy remains shared. */
export const AUTHORITY_BACKEND_METHODS = [
  "close", "commit", "createRecord", "initializeEngagement", "get", "getAt", "list", "recordsPage", "compareAndSet", "snapshot", "exportSnapshot", "importSnapshot",
  "submitProposal", "proposals", "proposalsPage", "submitReview", "reviewPack", "admitProposal", "evaluateAdmission", "promoteFinding",
  "createResourceRevision", "applyPatchSet", "addRelation", "impact",
  "claimWorkRun", "renewWorkRun", "reclaimWorkRun", "getWorkRun", "activeWorkRuns", "workItemsPage", "commitCheckpoint", "resumePacket",
  "recordActionIntent", "getActionIntent", "pendingActionIntents", "reconcileAction", "validateArtifactFence",
  "artifactSessions", "saveArtifactSession", "artifactCatalogRows", "artifactCatalogRow", "queryArtifactCatalog", "explainArtifactCatalog",
  "artifactCatalogWatermark", "artifactUploads", "saveArtifactUpload", "deleteArtifactUpload",
  "artifactPublications", "startArtifactPublication", "prepareArtifactPublication", "markArtifactPublication",
  "completeArtifactPublication", "failArtifactPublication", "updateArtifactCatalogRow", "saveArtifactCatalogRow",
  "artifactIdempotencyResult", "saveArtifactIdempotency", "updateArtifactIdempotencyResult", "recordArtifactEvent", "executionCatalogPage", "artifactMutation",
  "transitionWorkRun", "recordHostError", "recordLateResult", "maintenanceRead",
  "events", "verifyAudit", "consumeOutbox", "doctor", "previewRecovery", "reconcileDerived", "operationMarkers", "markOperationFailed", "replayDerived", "rebuildDerived", "sealExecutionSidecars", "executionCatalogRows",
] as const satisfies readonly (keyof AuthorityStore)[];

export type AuthorityBackendMethod = typeof AUTHORITY_BACKEND_METHODS[number];
export type AuthorityBackend = Pick<AuthorityStore, AuthorityBackendMethod>;

export const AUTHORITY_RUNTIME_CONFORMANCE_VERSION = "authority-runtime-conformance/1" as const;
export const AUTHORITY_RUNTIME_SCENARIOS = [
  "proposal", "review", "admission_l1", "admission_l2", "checkpoint", "action", "artifact",
  "lease", "fencing", "audit_outbox", "pinned_read", "backup_restore",
] as const;
export type AuthorityRuntimeScenario = typeof AUTHORITY_RUNTIME_SCENARIOS[number];
export interface AuthorityRuntimeConformance {
  version: typeof AUTHORITY_RUNTIME_CONFORMANCE_VERSION;
  passed: boolean;
  missing_methods: readonly AuthorityBackendMethod[];
  scenarios: readonly { id: AuthorityRuntimeScenario; passed: boolean; evidence: readonly string[]; reason?: string }[];
  failures: readonly string[];
}

export function runtimeConformancePassed(report?: AuthorityRuntimeConformance): boolean {
  return Boolean(report && report.version === AUTHORITY_RUNTIME_CONFORMANCE_VERSION && report.passed === true
    && report.missing_methods.length === 0 && report.failures.length === 0
    && report.scenarios.length === AUTHORITY_RUNTIME_SCENARIOS.length
    && AUTHORITY_RUNTIME_SCENARIOS.every((id) => report.scenarios.filter((scenario) => scenario.id === id && scenario.passed === true && scenario.evidence.length > 0 && scenario.evidence.every((item) => typeof item === "string" && item.trim().length > 0)).length === 1));
}

/** Conformance is executable evidence, never an inference from archived work.
 * Missing operations or scenarios fail closed even when health is green. */
export async function runAuthorityRuntimeConformance(
  backend: object,
  scenarios: Partial<Record<AuthorityRuntimeScenario, () => MaybePromise<readonly string[]>>>,
): Promise<AuthorityRuntimeConformance> {
  const methods = backend as Record<string, unknown>;
  const missing_methods = AUTHORITY_BACKEND_METHODS.filter((method) => typeof methods[method] !== "function");
  const outcomes: AuthorityRuntimeConformance["scenarios"][number][] = [];
  for (const id of AUTHORITY_RUNTIME_SCENARIOS) {
    const check = scenarios[id];
    if (!check) { outcomes.push({ id, passed: false, evidence: [], reason: "scenario has no executable evidence" }); continue; }
    try {
      const evidence = await check();
      if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((item) => typeof item !== "string" || !item.trim())) {
        outcomes.push({ id, passed: false, evidence: [], reason: "scenario returned no evidence" });
      } else outcomes.push({ id, passed: true, evidence: [...evidence] });
    } catch { outcomes.push({ id, passed: false, evidence: [], reason: "scenario did not conform" }); }
  }
  const failures = [...missing_methods.map((method) => `missing backend method: ${method}`), ...outcomes.filter((outcome) => !outcome.passed).map((outcome) => `${outcome.id}: ${outcome.reason}`)];
  return { version: AUTHORITY_RUNTIME_CONFORMANCE_VERSION, passed: failures.length === 0, missing_methods, scenarios: outcomes, failures };
}

/** Structural SQLite adapter; no behavior or transaction model is replaced. */
export function sqliteAuthorityBackend(store: AuthorityStore): AuthorityBackend { return store; }

export interface AuthorityStorageContractManifest {
  version: typeof AUTHORITY_STORAGE_CONTRACT_VERSION;
  invariants: readonly AuthorityStorageInvariant[];
  sqlite: { implemented_by: "AuthorityStore"; conformance: "existing" };
  postgresql: { implementation: "PostgresAuthorityStore"; conformance: "live" };
}

export const AUTHORITY_STORAGE_CONTRACT: AuthorityStorageContractManifest = Object.freeze({
  version: AUTHORITY_STORAGE_CONTRACT_VERSION,
  invariants: AUTHORITY_STORAGE_INVARIANTS,
  sqlite: { implemented_by: "AuthorityStore", conformance: "existing" },
  postgresql: { implementation: "PostgresAuthorityStore", conformance: "live" },
} as const);

/** Compile-time structural check for the current SQLite backend. */
export function asAuthorityStorageContract<T extends AuthorityStorageContract>(store: T): T { return store; }
export function sqliteStorageContract(store: AuthorityStore): AuthorityStorageContract { return asAuthorityStorageContract(store); }
export function postgresStorageContract(store: PostgresAuthorityStore): AuthorityStorageContract { return asAuthorityStorageContract(store); }
