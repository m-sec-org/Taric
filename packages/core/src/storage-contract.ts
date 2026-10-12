import type { AuthorityStore, CanonicalRecord, DoctorReport, ReadSnapshot, TrustLevel, AuditEvent } from "./store.js";
import type { PostgresAuthorityStore } from "./postgres.js";

export const AUTHORITY_STORAGE_CONTRACT_VERSION = "authority-storage/1" as const;

/** Observable guarantees all authority backends must implement; database-specific mechanics remain private. */
export const AUTHORITY_STORAGE_INVARIANTS = [
  "atomic_record_event_idempotency_outbox_commit",
  "expected_version_compare_and_set",
  "uuidv7_primary_identity_and_global_display_sequence",
  "strictly_ordered_audit_event_sequence",
  "pinned_snapshot_read_sequence_and_watermarks",
  "integrity_checked_snapshot_backup_and_atomic_restore",
  "lease_expiry_heartbeat_reclaim_and_fencing_generation",
] as const;
export type AuthorityStorageInvariant = typeof AUTHORITY_STORAGE_INVARIANTS[number];

/** Method surface used by the shared SQLite/PostgreSQL conformance scenarios. */
export interface AuthorityStorageContract {
  close(): MaybePromise<void>;
  commit(record: CanonicalRecord, trustLevel?: TrustLevel, idempotencyKey?: string, context?: { operation?: string; principal?: string; engagement_id?: string; expected_version?: number }): MaybePromise<CanonicalRecord>;
  compareAndSet(id: string, expectedVersion: number, patch: Record<string, unknown>, trustLevel?: TrustLevel): MaybePromise<CanonicalRecord>;
  snapshot(engagementId: string, options?: { trustLevel?: TrustLevel; includeCandidates?: boolean; asOf?: number }): MaybePromise<ReadSnapshot>;
  exportSnapshot(engagementId: string, asOf?: number): MaybePromise<{ schema_version: string; engagement_id: string; read_seq: number; committed_seq: number; projected_seq: number; records: CanonicalRecord[]; hash: string }>;
  importSnapshot(snapshot: unknown): MaybePromise<{ engagement_id: string; recovered_sequence: number; imported_records: number; integrity_verified: true; display_sequence: number }>;
  claimWorkRun(input: { run_id?: string; work_item_id: string; engagement_id: string; host_id: string; agent_id: string; ttl_ms?: number }): MaybePromise<object>;
  renewWorkRun(runId: string, generation: number, hostId: string, ttlMs?: number): MaybePromise<object>;
  reclaimWorkRun(runId: string, hostId: string, agentId: string, ttlMs?: number): MaybePromise<object>;
  events(): MaybePromise<AuditEvent[]>;
  verifyAudit(): MaybePromise<{ valid: boolean; errors: string[] }>;
  consumeOutbox(limit?: number): MaybePromise<Array<Record<string, unknown>>>;
  doctor(): MaybePromise<DoctorReport>;
}

export type MaybePromise<T> = T | Promise<T>;

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
