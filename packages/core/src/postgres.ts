import { SCHEMA_VERSION } from "@taric/schemas";
import { AuthorityStore, type ReadSnapshot, type TrustLevel } from "./store.js";
import { PostgresAuthorityDriver, quotePostgresSchema, type PostgresQueryable, type PostgresQueryResult } from "./sql-driver.js";
import { AUTHORITY_SQL_TABLES, AUTHORITY_SQL_INDEXES, AUTHORITY_SQL_INITIAL_METADATA, AUTHORITY_SQL_SCHEMA_VERSION } from "./sql-schema.js";
import { compatibilityDiagnosticDetails, ContractValidationError, type CompatibilityDiagnosticDetails } from "./validation.js";
import { uuidv7 } from "./identity.js";
import { AUTHORITY_RUNTIME_SCENARIOS, runAuthorityRuntimeConformance, runtimeConformancePassed, type AuthorityBackendMethod, type AuthorityRuntimeConformance, type AuthorityRuntimeScenario } from "./storage-contract.js";

export type { PostgresQueryable, PostgresQueryResult };
export type PostgresBackendProfile = "single_host_sqlite" | "multi_host_authority";
export interface PostgresAuthorityOptions {
  profile?: PostgresBackendProfile;
  schema?: string;
  policyDigest?: string;
  leaseMode?: "server_expiry_fencing";
  /** Already migrated schemas are still validated before authority operations. */
  migrate?: boolean;
}
export interface PostgresLease extends Record<string, unknown> {
  run_id: string; work_item_id: string; engagement_id: string; status: string;
  owner: { host_id: string; agent_id: string }; generation: number; attempt_ref: string;
  lease_expires_at: string; heartbeat_at: string; read_seq: number;
}
export interface PostgresPinnedSnapshot extends ReadSnapshot {
  generation: number; indexed_seq: number; snapshot_id: string;
  watermark: { committed_seq: number; projected_seq: number; indexed_seq: number };
}
export interface PostgresBackendManifest {
  backend: "postgresql"; profile: "multi_host_authority"; enabled: boolean;
  implementation_state: "available"; runtime_state: "disabled" | "enabled";
  evidence_state: "pending" | "failed" | "verified"; primitive_state: "ready" | "uninitialized";
  schema_version: string; storage_format: string;
  supported_postgres: { minimum: string; maximum: string }; policy_digest?: string;
  lease_mode: "server_expiry_fencing";
}
export interface PostgresRuntimeReadiness {
  version: "postgres-runtime-readiness/1"; backend: "postgresql";
  implementation_state: "available"; runtime_state: "disabled" | "enabled";
  evidence_state: "failed" | "verified";
  code: "ready" | "backend_conformance_failed" | "postgresql_unavailable";
  health: {
    available: boolean; schema_valid: boolean; fencing: boolean; read_seq?: number;
    watermarks?: { committed_seq: number; projected_seq: number; indexed_seq: number };
  };
  domains: readonly {
    id: AuthorityRuntimeScenario; missing_methods: readonly AuthorityBackendMethod[];
    missing_tables: readonly string[]; missing_columns: readonly string[];
    persistence_shape: "available" | "missing"; runtime_evidence: "missing" | "passed" | "failed";
  }[];
  conformance: AuthorityRuntimeConformance;
  compatibility?: CompatibilityDiagnosticDetails;
  blocker?: "runtime_conformance_evidence_required" | "backend_health_failed";
}
const runtimeDomainMethods = {
  proposal: ["submitProposal", "proposals", "proposalsPage"], review: ["submitReview"],
  admission_l1: ["admitProposal", "createRecord", "initializeEngagement"], admission_l2: ["evaluateAdmission", "promoteFinding"],
  checkpoint: ["commitCheckpoint", "resumePacket", "getWorkRun"],
  action: ["recordActionIntent", "getActionIntent", "pendingActionIntents", "reconcileAction"],
  artifact: ["validateArtifactFence", "artifactSessions", "saveArtifactSession", "artifactCatalogRow", "saveArtifactCatalogRow", "artifactUploads", "saveArtifactUpload", "deleteArtifactUpload", "artifactPublications", "startArtifactPublication", "prepareArtifactPublication", "markArtifactPublication", "completeArtifactPublication", "failArtifactPublication", "artifactIdempotencyResult", "saveArtifactIdempotency", "executionCatalogPage", "artifactMutation"],
  lease: ["claimWorkRun", "renewWorkRun", "reclaimWorkRun", "getWorkRun"],
  fencing: ["validateArtifactFence", "commitCheckpoint", "recordActionIntent"],
  audit_outbox: ["events", "verifyAudit", "consumeOutbox", "doctor", "previewRecovery", "reconcileDerived"],
  pinned_read: ["snapshot", "getAt", "recordsPage"], backup_restore: ["exportSnapshot", "importSnapshot"],
} as const satisfies Record<AuthorityRuntimeScenario, readonly AuthorityBackendMethod[]>;
const runtimeDomainTables = {
  proposal: ["proposals", "proposal_versions", "object_refs"], review: ["proposals", "proposal_versions", "reviews", "admission_review_packs", "object_refs"],
  admission_l1: ["proposals", "records", "record_versions", "object_refs", "idempotency", "events", "outbox"],
  admission_l2: ["proposals", "reviews", "records", "record_versions", "object_refs", "events", "outbox"],
  checkpoint: ["work_runs", "attempts", "checkpoints", "records", "object_refs"],
  action: ["work_runs", "attempts", "action_intents", "records", "object_refs"],
  artifact: ["artifact_sessions", "artifact_catalog", "artifact_chunks", "artifact_uploads", "artifact_publications", "artifact_idempotency", "artifact_catalog_watermarks", "execution_catalog"],
  lease: ["work_runs", "attempts"], fencing: ["work_runs", "attempts"],
  audit_outbox: ["metadata", "events", "outbox", "operation_markers"], pinned_read: ["record_versions", "reader_pins"],
  backup_restore: ["records", "record_versions", "metadata"],
} as const satisfies Record<AuthorityRuntimeScenario, readonly string[]>;
const requiredRuntimeColumns: Readonly<Record<string, readonly string[]>> = {
  metadata: ["key", "value"], records: ["id", "engagement_id", "kind", "trust_level", "version", "body", "display_id"],
  proposals: ["id", "engagement_id", "subject_type", "expected_version", "target_id", "client_request_id", "canonical_id", "canonical_version", "content_hash", "body", "status"],
  proposal_versions: ["id", "engagement_id", "commit_seq", "body"], reviews: ["id", "proposal_id", "reviewer_id", "input_hash", "verdict", "body"],
  admission_review_packs: ["proposal_id", "engagement_id", "proposal_hash", "canonical_id", "policy_digest", "evidence_snapshot_hash", "admission_seq", "evidence_snapshot"],
  work_runs: ["run_id", "work_item_id", "engagement_id", "generation", "owner_host", "owner_agent", "lease_expires_at", "status", "body"],
  attempts: ["attempt_id", "run_id", "generation", "owner_host", "owner_agent", "lease_expires_at", "status", "body"],
  checkpoints: ["checkpoint_id", "run_id", "generation", "body"], action_intents: ["action_id", "run_id", "generation", "status", "body"],
  record_versions: ["id", "engagement_id", "commit_seq", "trust_level", "body"], object_refs: ["id", "engagement_id", "kind"],
  events: ["commit_seq", "event_id", "event_type", "subject_id", "payload", "prev_hash", "hash"], outbox: ["id", "commit_seq", "status"],
  operation_markers: ["operation_id", "event_id", "commit_seq", "status", "retry_owner"],
  reader_pins: ["snapshot_id", "engagement_id", "read_seq", "read_time", "expires_at"],
  artifact_sessions: ["engagement_id", "session_id", "root", "binding_id"], artifact_catalog: ["content_ref", "engagement_id", "session_id", "artifact_id", "version", "body"],
  artifact_chunks: ["content_ref", "ordinal", "byte_offset", "byte_count", "chunk_hash", "relative_path"], artifact_uploads: ["upload_id", "engagement_id", "session_id", "body"],
  artifact_publications: ["upload_id", "engagement_id", "session_id", "content_ref", "phase", "body"], artifact_idempotency: ["key", "operation", "principal", "engagement_id", "request_hash", "result"],
  artifact_catalog_watermarks: ["engagement_id", "session_id", "catalog_watermark", "index_watermark", "index_status"],
  execution_catalog: ["execution_id", "engagement_id", "session_id", "work_run_id", "attempt_id", "sequence", "body"],
};
export const POSTGRES_SCHEMA_VERSION = SCHEMA_VERSION;
export const POSTGRES_SUPPORTED_VERSIONS = Object.freeze({ minimum: "14", maximum: "18" });
export const POSTGRES_SCHEMA_NAME = "taric";
/** Offline SQL is derived from the same versioned layout used by the drivers. */
export const POSTGRES_MIGRATIONS: readonly { version: string; sql: string }[] = Object.freeze([{
  version: AUTHORITY_SQL_SCHEMA_VERSION,
  sql: `CREATE SCHEMA IF NOT EXISTS taric; SET search_path TO taric,pg_catalog;\n${AUTHORITY_SQL_TABLES.replace("commit_seq INTEGER PRIMARY KEY AUTOINCREMENT", "commit_seq BIGINT PRIMARY KEY").replace("id INTEGER PRIMARY KEY AUTOINCREMENT", "id BIGSERIAL PRIMARY KEY")}\n${AUTHORITY_SQL_INDEXES}\n${AUTHORITY_SQL_INITIAL_METADATA.map(([key, value]) => `INSERT INTO metadata(key,value) VALUES('${key}','${value}') ON CONFLICT(key) DO NOTHING;`).join("\n")}\nINSERT INTO metadata(key,value) VALUES('authority_id',overlay(gen_random_uuid()::text placing '7' from 15 for 1)) ON CONFLICT(key) DO NOTHING;`,
}]);
type SnapshotOptions = { asOf?: number; trustLevel?: TrustLevel; includeCandidates?: boolean; readTime?: string };

/** Both adapters execute the complete shared Core governance and unit of work. */
export class PostgresAuthorityStore extends AuthorityStore {
  private readonly driver: PostgresAuthorityDriver;
  private readonly options: PostgresAuthorityOptions;
  private readiness?: PostgresRuntimeReadiness;
  constructor(queryable: PostgresQueryable, options: PostgresAuthorityOptions = {}) {
    if (options.profile === "single_host_sqlite") throw new ContractValidationError("unsupported_capability", "PostgreSQL requires the multi_host_authority profile");
    const driver = new PostgresAuthorityDriver(queryable, options.schema ?? POSTGRES_SCHEMA_NAME, options.migrate !== false);
    super(driver); this.driver = driver; this.options = options;
  }
  manifest(): PostgresBackendManifest {
    const enabled = this.readiness?.runtime_state === "enabled";
    return { backend: "postgresql", profile: "multi_host_authority", enabled, implementation_state: "available", runtime_state: enabled ? "enabled" : "disabled", evidence_state: this.readiness?.evidence_state ?? "pending", primitive_state: this.driver.migrated ? "ready" : "uninitialized", schema_version: POSTGRES_SCHEMA_VERSION, storage_format: AUTHORITY_SQL_SCHEMA_VERSION, supported_postgres: POSTGRES_SUPPORTED_VERSIONS, policy_digest: this.options.policyDigest, lease_mode: "server_expiry_fencing" };
  }
  async migrate(): Promise<void> { await this.driver.ready; }
  /** No migrations, authority writes or invented scenario evidence during inspection. */
  async runtimeReadiness(report?: AuthorityRuntimeConformance): Promise<PostgresRuntimeReadiness> {
    const missingEvidence = await runAuthorityRuntimeConformance(this, {});
    let conformance = runtimeConformancePassed(report) ? report! : missingEvidence;
    let unavailable = false;
    const columns = new Map<string, Set<string>>();
    const observedMetadata: Record<string, string> = {};
    let health: PostgresRuntimeReadiness["health"] = { available: false, schema_valid: false, fencing: false };
    try {
      await this.driver.inspect(async (client) => {
        const shape = await client.query<{ table_name: string; column_name: string; data_type?: string }>("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1", [this.driver.schema]);
        for (const row of shape.rows) { const entry = columns.get(row.table_name) ?? new Set<string>(); entry.add(row.column_name); columns.set(row.table_name, entry); }
        const schema = quotePostgresSchema(this.driver.schema);
        const metadataText = shape.rows.some((row) => row.table_name === "metadata" && row.column_name === "value" && row.data_type === "text");
        let schema_valid = false;
        if (metadataText) {
          const metadata = await client.query<{ key: string; value: string }>(`SELECT key,value FROM ${schema}.metadata WHERE key IN ('schema_version','storage_format','authority_id')`);
          for (const row of metadata.rows) observedMetadata[row.key] = row.value;
          schema_valid = metadata.rows.find((row) => row.key === "schema_version")?.value === SCHEMA_VERSION && metadata.rows.find((row) => row.key === "storage_format")?.value === AUTHORITY_SQL_SCHEMA_VERSION && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(metadata.rows.find((row) => row.key === "authority_id")?.value ?? "");
        }
        let watermarks: PostgresRuntimeReadiness["health"]["watermarks"];
        const has = (table: string, fields: readonly string[]) => fields.every((field) => columns.get(table)?.has(field));
        if (metadataText && has("events", ["commit_seq"]) && has("outbox", ["commit_seq", "status"])) {
          const result = await client.query<{ committed_seq: unknown; projected_seq: unknown; indexed_seq: unknown }>(`SELECT COALESCE((SELECT MAX(commit_seq) FROM ${schema}.events),0) AS committed_seq, COALESCE((SELECT MIN(e.commit_seq)-1 FROM ${schema}.events e LEFT JOIN ${schema}.outbox o ON o.commit_seq=e.commit_seq WHERE o.commit_seq IS NULL OR o.status<>'applied'),(SELECT COALESCE(MAX(commit_seq),0) FROM ${schema}.events)) AS projected_seq,COALESCE((SELECT value::bigint FROM ${schema}.metadata WHERE key='indexed_seq'),0) AS indexed_seq`);
          const row = result.rows[0]; if (row) watermarks = { committed_seq: Number(row.committed_seq), projected_seq: Number(row.projected_seq), indexed_seq: Number(row.indexed_seq) };
        }
        let fencing = has("work_runs", requiredRuntimeColumns.work_runs!) && has("attempts", requiredRuntimeColumns.attempts!);
        if (fencing) {
          const mismatch = await client.query<{ invalid: unknown }>(`SELECT COUNT(*) AS invalid FROM ${schema}.work_runs w LEFT JOIN ${schema}.attempts a ON a.attempt_id=(w.body::jsonb->>'attempt_ref') AND a.run_id=w.run_id AND a.generation=w.generation WHERE w.lease_expires_at::timestamptz > clock_timestamp() AND w.status NOT IN ('completed','failed','cancelled','lost') AND (a.attempt_id IS NULL OR a.owner_host IS DISTINCT FROM w.owner_host OR a.owner_agent IS DISTINCT FROM w.owner_agent OR a.status IN ('completed','failed','cancelled','lost') OR a.lease_expires_at IS DISTINCT FROM w.lease_expires_at OR (a.body::jsonb->>'status') IS DISTINCT FROM a.status OR (w.body::jsonb->>'status') IS DISTINCT FROM w.status)`);
          fencing = Number(mismatch.rows[0]?.invalid ?? 1) === 0;
        }
        health = { available: true, schema_valid, fencing, read_seq: watermarks?.committed_seq, watermarks };
      });
    } catch { unavailable = true; }
    const domains = AUTHORITY_RUNTIME_SCENARIOS.map((id) => {
      const missing_methods = runtimeDomainMethods[id].filter((method) => typeof this[method] !== "function");
      const missing_tables = runtimeDomainTables[id].filter((table) => !columns.has(table));
      const missing_columns = runtimeDomainTables[id].flatMap((table) => (requiredRuntimeColumns[table] ?? []).filter((field) => !columns.get(table)?.has(field)).map((field) => `${table}.${field}`));
      const evidence = conformance.scenarios.find((scenario) => scenario.id === id);
      return { id, missing_methods, missing_tables, missing_columns, persistence_shape: missing_methods.length || missing_tables.length || missing_columns.length ? "missing" as const : "available" as const, runtime_evidence: evidence?.passed ? "passed" as const : report ? "failed" as const : "missing" as const };
    });
    const healthy = health.available && health.schema_valid && health.fencing && domains.every((domain) => domain.persistence_shape === "available");
    const missingRuntimeColumns = domains.flatMap((domain) => domain.missing_columns).slice(0, 32);
    const compatibility = !health.available ? undefined : !health.schema_valid
      ? compatibilityDiagnosticDetails({ backend: "postgresql", expected: { schema_version: SCHEMA_VERSION, storage_format: AUTHORITY_SQL_SCHEMA_VERSION, authority_id: "uuidv7" }, observed: observedMetadata, failed_marker: observedMetadata.schema_version !== SCHEMA_VERSION ? "metadata.schema_version" : observedMetadata.storage_format !== AUTHORITY_SQL_SCHEMA_VERSION ? "metadata.storage_format" : "metadata.authority_id" })
      : !health.fencing
        ? compatibilityDiagnosticDetails({ backend: "postgresql", expected: { fencing: "valid" }, observed: { fencing: "invalid" }, failed_marker: "authority.fencing" })
        : missingRuntimeColumns.length
          ? compatibilityDiagnosticDetails({ backend: "postgresql", expected: { runtime_layout: "complete" }, failed_marker: "authority.layout", missing: missingRuntimeColumns })
          : undefined;
    if (!healthy && conformance.passed) conformance = { ...conformance, passed: false, failures: [...conformance.failures, "PostgreSQL runtime health did not conform"] };
    const enabled = healthy && runtimeConformancePassed(conformance);
    const result: PostgresRuntimeReadiness = { version: "postgres-runtime-readiness/1", backend: "postgresql", implementation_state: "available", runtime_state: enabled ? "enabled" : "disabled", evidence_state: enabled ? "verified" : "failed", code: enabled ? "ready" : unavailable ? "postgresql_unavailable" : "backend_conformance_failed", health, domains, conformance, ...(compatibility ? { compatibility } : {}), ...(enabled ? {} : { blocker: healthy ? "runtime_conformance_evidence_required" as const : "backend_health_failed" as const }) };
    this.readiness = result; return result;
  }
  async health(): Promise<{ available: true; backend: "postgresql"; schema_version: string; fencing: boolean; committed_seq: number; projected_seq: number; indexed_seq: number }> {
    await this.migrate();
    const report = await this.runtimeReadiness(this.readiness?.conformance);
    if (!report.health.available || !report.health.schema_valid || !report.health.fencing || report.domains.some((domain) => domain.persistence_shape !== "available") || !report.health.watermarks) throw new ContractValidationError("conflict", "PostgreSQL authority health checks failed", report.compatibility);
    return { available: true, backend: "postgresql", schema_version: POSTGRES_SCHEMA_VERSION, fencing: true, ...report.health.watermarks };
  }
  async pinSnapshot(engagementId: string, options: SnapshotOptions & { ttlMs?: number } = {}): Promise<PostgresPinnedSnapshot> {
    const ttl = options.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw new ContractValidationError("validation_error", "snapshot pin ttl must be a positive integer");
    return this.sql.transaction("write", async () => {
      const snapshot = await super.snapshot(engagementId, options);
      const indexed = Number((await this.sql.get<{ value: string }>("SELECT value FROM metadata WHERE key='indexed_seq'"))?.value ?? 0);
      const now = await this.sql.now(); const snapshot_id = uuidv7(); const indexed_seq = Math.min(indexed, snapshot.read_seq);
      await this.sql.run("INSERT INTO reader_pins(snapshot_id,engagement_id,generation,read_seq,committed_seq,projected_seq,indexed_seq,read_time,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", snapshot_id, engagementId, snapshot.read_seq, snapshot.read_seq, snapshot.committed_seq, snapshot.projected_seq, indexed_seq, snapshot.read_time, new Date(Date.parse(now) + ttl).toISOString(), now);
      return { ...snapshot, snapshot_id, generation: snapshot.read_seq, indexed_seq, watermark: { committed_seq: snapshot.committed_seq, projected_seq: snapshot.projected_seq, indexed_seq } };
    });
  }
  async snapshot(engagementId: string, options: SnapshotOptions & { snapshotId: string }): Promise<PostgresPinnedSnapshot>;
  async snapshot(engagementId: string, options?: SnapshotOptions): Promise<ReadSnapshot>;
  async snapshot(engagementId: string, options: SnapshotOptions & { snapshotId?: string } = {}): Promise<ReadSnapshot | PostgresPinnedSnapshot> {
    if (!options.snapshotId) return super.snapshot(engagementId, options);
    return this.readTransaction(async () => {
      const pin = await this.sql.get<Record<string, unknown>>("SELECT * FROM reader_pins WHERE snapshot_id=?", options.snapshotId!);
      const now = await this.sql.now();
      if (!pin || pin.engagement_id !== engagementId || typeof pin.expires_at !== "string" || pin.expires_at <= now || options.asOf !== undefined && options.asOf !== Number(pin.read_seq)) throw new ContractValidationError("stale_version", "snapshot pin is expired or has a mismatched binding");
      const snapshot = await super.snapshot(engagementId, { ...options, asOf: Number(pin.read_seq), readTime: String(pin.read_time) });
      const committed_seq = Number(pin.committed_seq); const projected_seq = Number(pin.projected_seq); const indexed_seq = Number(pin.indexed_seq);
      return { ...snapshot, committed_seq, projected_seq, indexed_seq, generation: Number(pin.generation), snapshot_id: String(pin.snapshot_id), watermark: { committed_seq, projected_seq, indexed_seq } };
    });
  }
  async updateIndexedWatermark(sequence: number): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new ContractValidationError("validation_error", "indexed watermark must be a non-negative integer");
    await this.sql.transaction("write", async () => {
      const current = Number((await this.sql.get<{ value: string }>("SELECT value FROM metadata WHERE key='indexed_seq'"))?.value ?? 0);
      const projected = (await super.snapshot("", { includeCandidates: true })).projected_seq;
      if (sequence < current || sequence > projected) throw new ContractValidationError("stale_version", "indexed watermark cannot regress or exceed projected authority");
      await this.sql.run("UPDATE metadata SET value=? WHERE key='indexed_seq'", String(sequence));
    });
  }
  async assertLease(runId: string, generation: number, hostId: string): Promise<PostgresLease> {
    return this.readTransaction(async () => {
      const run = await this.sql.get<{ owner_host: string; generation: number; status: string; lease_expires_at: string; body: string }>("SELECT owner_host,generation,status,lease_expires_at,body FROM work_runs WHERE run_id=?", runId);
      if (!run || run.owner_host !== hostId || run.generation !== generation || run.lease_expires_at <= await this.sql.now() || ["completed", "failed", "cancelled", "lost"].includes(run.status)) throw new ContractValidationError("stale_version", "write is fenced by an expired lease or generation");
      const body = JSON.parse(run.body) as PostgresLease;
      const attempt = await this.sql.get<{ generation: number; owner_host: string; status: string; lease_expires_at: string }>("SELECT generation,owner_host,status,lease_expires_at FROM attempts WHERE attempt_id=? AND run_id=?", body.attempt_ref, runId);
      if (!attempt || attempt.generation !== generation || attempt.owner_host !== hostId || attempt.lease_expires_at <= await this.sql.now() || ["completed", "failed", "cancelled", "lost"].includes(attempt.status)) throw new ContractValidationError("stale_version", "active Attempt is expired or fenced");
      return body;
    });
  }
  async backup(engagementId: string, asOf?: number): ReturnType<AuthorityStore["exportSnapshot"]> { return this.exportSnapshot(engagementId, asOf); }
  async restore(snapshot: unknown): ReturnType<AuthorityStore["importSnapshot"]> { return this.importSnapshot(snapshot); }
  async diagnostics(): Promise<PostgresBackendManifest & { available: true; committed_seq: number; projected_seq: number; indexed_seq: number; backup_format: string; restore_mode: "atomic_verified_target" }> {
    const health = await this.health(); return { ...this.manifest(), ...health, backup_format: "taric-native-json", restore_mode: "atomic_verified_target" };
  }
}
export function createPostgresAuthorityStore(client: PostgresQueryable, options?: PostgresAuthorityOptions): PostgresAuthorityStore { return new PostgresAuthorityStore(client, options); }
