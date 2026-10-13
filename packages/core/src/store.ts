import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { uuidv7 } from "./identity.js";
import { DEFAULT_ADMISSION_POLICY, evaluateAdmission, policyDigest, riskClassOf, type AdmissionDecision, type AdmissionPolicy, type AdmissionReview, type PinnedEvidence, type RiskClass } from "./policy.js";
import { contractNames, SCHEMA_VERSION, type ContractName } from "@taric/schemas";
import { ContractValidationError, validateCanonicalRecord, validateContract, validateAuthorityReferences } from "./validation.js";

export type TrustLevel = "L0" | "L1" | "L2";
export interface CanonicalRecord { id: string; engagement_id: string; trust_level?: TrustLevel; version?: number; [key: string]: unknown }
export interface Proposal { id: string; engagement_id: string; subject_type: string; content: CanonicalRecord; base_version: number; status: "pending" | "rejected" | "admitted" | "needs_evidence"; content_hash: string; }
export interface AuditEvent { event_id: string; commit_seq: number; event_type: string; subject_id?: string; payload: Record<string, unknown>; prev_hash: string | null; hash: string; created_at: string; actor_id?: string; host_id?: string; worker_id?: string; dispatch_id?: string; work_item_id?: string; attempt_id?: string; proposal_id?: string; review_id?: string; entity_id?: string; policy_digest?: string; input_hash?: string; evidence_refs?: string[]; idempotency_key?: string; changed_fields?: string[]; }
export interface AdmissionResult { ok: boolean; reason?: string; record?: CanonicalRecord; proposal: Proposal; }
export interface ReadSnapshot { read_seq: number; committed_seq: number; projected_seq: number; records: CanonicalRecord[]; }
export interface IdempotencyContext { operation: string; principal: string; engagement_id: string; expected_version?: number; }
export interface GovernanceWriteOptions extends Partial<IdempotencyContext> {
  idempotencyKey?: string;
  /** Run-scoped proposals and observations must arrive from the active Attempt. */
  workRunId?: string;
  generation?: number;
  principalRole?: string;
}
export interface OperationMarker { operation_id: string; event_id: string; engagement_id?: string; commit_seq: number; kind: string; input_hash: string; status: "pending" | "applied" | "indexed" | "failed" | "recovered"; error?: string; retry_owner?: string; updated_at: string; }
export interface DoctorReport {
  valid: boolean;
  schema_version: string;
  committed_seq: number;
  projected_seq: number;
  pending_outbox: number;
  operation_markers: Record<OperationMarker["status"], number>;
  authority: { valid: boolean; errors: string[] };
  derived: { valid: boolean; errors: string[]; repair_actions: string[] };
  audit: ReturnType<AuthorityStore["verifyAudit"]>;
  errors: string[];
}
export interface OperationRecoveryPreview {
  action: "preview";
  committed_seq: number;
  pending_outbox: number;
  failed_markers: number;
  missing_outbox: number;
  missing_markers: number;
  authority_valid: boolean;
  authority_writable: boolean;
  repair_actions: string[];
}

export interface ResourceRevisionInput {
  engagement_id: string;
  resource_id?: string;
  asset_type?: string;
  identity?: Record<string, unknown>;
  variant?: Record<string, unknown>;
  method?: string;
  path?: string;
  parameter?: string;
  content_type?: string;
  principal_ref?: string;
  tenant_ref?: string;
  content_hash: string;
  source_observation_refs?: string[];
  valid_from?: string;
  valid_until?: string;
  principal?: string;
}

export interface PatchOperation {
  op?: "upsert" | "replace" | "add_relation" | "remove_relation";
  kind?: string;
  id?: string;
  entity_id?: string;
  patch?: Record<string, unknown>;
  changes?: Record<string, unknown>;
  base?: Record<string, unknown>;
  record?: CanonicalRecord;
  relation?: CanonicalRecord;
  expected_version?: number;
}

export interface PatchSetInput {
  id?: string;
  engagement_id: string;
  base_generation: number;
  base_versions?: Record<string, number>;
  read_set?: Array<string | { entity_ref: string; version: number }>;
  write_set?: Array<string | { entity_ref: string; base_version: number }>;
  operations: Array<PatchOperation | "upsert_resource" | "upsert_relation" | "replace_property" | "add_relation" | "remove_relation" | "revise_claim" | "revise_hypothesis" | "attach_observation">;
  source_observation_refs?: string[];
  principal?: string;
  work_run_id?: string;
  attempt_ref?: string;
  generation?: number;
}

export interface PatchSetResult {
  patch_id: string;
  status: "merged" | "conflict";
  generation: number;
  records: CanonicalRecord[];
  conflicts: CanonicalRecord[];
}

export interface ImpactResult {
  event_id: string;
  affected_ids: string[];
  revalidation_work_item_ids: string[];
  continuation?: string;
  pending_watermark: number;
}

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const impactCursorKey = randomBytes(32);
function payloadWithRecords(payload: Record<string, unknown>, records: unknown[]): Record<string, unknown> {
  return { schema_version: payload.schema_version, core_version: payload.core_version, engagement_id: payload.engagement_id, read_seq: payload.read_seq, committed_seq: payload.committed_seq, projected_seq: payload.projected_seq, format: payload.format, records };
}
const json = (value: unknown) => JSON.stringify(value);
/** 必须经过共享校验器的 Phase 1 领域合同 kind。 */
const phaseOneContracts = new Set<string>(contractNames.filter((name) => !["apiSuccess", "apiError", "auditEvent"].includes(name)));
const recordContractNames: Record<string, ContractName> = {
  resource_revision: "resourceRevision", test_hypothesis: "testHypothesis", attack_path: "attackPath", patch_set: "patchSet", conflict: "conflict", impact_event: "impactEvent", protective_control_revision: "protectiveControlRevision", control_applicability_event: "controlApplicabilityEvent",
};

/** ActionIntent 的合法状态迁移；denied 不得再进入执行态。 */
const actionTransitions: Record<string, string[]> = {
  recommended: ["authorized", "denied"],
  authorized: ["executed", "failed", "unknown"],
  unknown: ["executed", "failed"],
  executed: [],
  failed: [],
  denied: [],
};

const workTransitions: Record<string, string[]> = {
  queued: ["claimed", "cancelled"],
  claimed: ["running", "checkpointed", "blocked", "completed", "failed", "cancelled", "lost"],
  running: ["checkpointed", "blocked", "completed", "failed", "cancelled", "lost"],
  checkpointed: ["running", "blocked", "completed", "failed", "cancelled", "lost"],
  blocked: ["running", "checkpointed", "completed", "failed", "cancelled", "lost"],
  lost: ["claimed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const attemptTransitions: Record<string, string[]> = {
  claimed: ["running", "checkpointed", "blocked", "completed", "failed", "cancelled", "lost"],
  running: ["checkpointed", "blocked", "completed", "failed", "cancelled", "lost"],
  checkpointed: ["running", "blocked", "completed", "failed", "cancelled", "lost"],
  blocked: ["running", "checkpointed", "completed", "failed", "cancelled", "lost"],
  lost: [],
  completed: [],
  failed: [],
  cancelled: [],
};

const checkpointForbiddenFields = new Set(["reasoning", "hidden_reasoning", "chain_of_thought", "thoughts", "internal_reasoning", "private_reasoning"]);
function sanitizeSnapshotRecord(value: unknown, sensitive: RegExp): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeSnapshotRecord(item, sensitive)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "host_ref") || Object.prototype.hasOwnProperty.call(record, "content_ref")) {
    if (typeof record.content_ref !== "string") return undefined;
    const allowed = new Set(["content_ref", "artifact_id", "version", "storage_mode", "content_status", "integrity_status", "payload_kind", "media_type", "byte_length", "chunk_count", "content_hash", "manifest_hash", "captured_at", "stored_at", "provenance_ref", "derived_from", "child_refs"]);
    return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, sanitizeSnapshotRecord(item, sensitive)]));
  }
  if (typeof record.content_ref === "string") {
    const allowed = new Set(["content_ref", "artifact_id", "version", "storage_mode", "content_status", "integrity_status", "payload_kind", "media_type", "byte_length", "chunk_count", "content_hash", "manifest_hash", "captured_at", "stored_at", "provenance_ref", "derived_from", "child_refs"]);
    return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, sanitizeSnapshotRecord(item, sensitive)]));
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => !sensitive.test(key)).map(([key, item]) => [key, sanitizeSnapshotRecord(item, sensitive)]));
}
function sanitizeExecutionMetadata(value: unknown): unknown {
  const forbidden = /(?:token|secret|credential|password|cookie|authorization|bearer|body|packet|hidden_reasoning|chain_of_thought|private_key)/i;
  if (Array.isArray(value)) return value.map(sanitizeExecutionMetadata).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 512) : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !forbidden.test(key))
    .map(([key, item]) => [key, sanitizeExecutionMetadata(item)]));
}

/** 规范化 JSON 对象键序，保证等价 payload 产生同一 request hash。 */
function stablePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["version", "created_at", "trust_level", "display_id"].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stablePayload(item)]));
  }
  return value;
}

/** SQLite WAL authority store. Node 22+ supplies the synchronous sqlite binding. */
export class AuthorityStore {
  /** 数据库句柄只在 Core 内部使用；adapter/model 只能拿 scoped service。 */
  readonly #db: DatabaseSync;
  readonly #filename: string;
  #transactionDepth = 0;
  #writeBlocked = false;
  constructor(filename = ":memory:") {
    this.#filename = filename;
    this.#db = new DatabaseSync(filename);
    const hasMetadata = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get());
    const hasRecords = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").get());
    const priorSchema = hasMetadata ? this.#db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as { value?: string } | undefined : undefined;
    if (((hasRecords || hasMetadata) && !priorSchema) || (priorSchema && priorSchema.value !== SCHEMA_VERSION)) {
      this.#db.close();
      throw new ContractValidationError("unsupported_schema_version", `unsupported authority schema version: ${priorSchema?.value ?? "unversioned"}`, { expected: SCHEMA_VERSION });
    }
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, kind TEXT NOT NULL, trust_level TEXT NOT NULL, version INTEGER NOT NULL, display_id TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, subject_type TEXT NOT NULL, base_version INTEGER NOT NULL, status TEXT NOT NULL, content_hash TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (commit_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, event_type TEXT NOT NULL, subject_id TEXT, payload TEXT NOT NULL, prev_hash TEXT, hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, operation TEXT NOT NULL DEFAULT '', principal TEXT NOT NULL DEFAULT '', engagement_id TEXT NOT NULL DEFAULT '', request_hash TEXT NOT NULL DEFAULT '', result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS record_versions (id TEXT NOT NULL, commit_seq INTEGER NOT NULL, engagement_id TEXT NOT NULL, trust_level TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id, commit_seq));
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, commit_seq INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS operation_markers (operation_id TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, engagement_id TEXT, commit_seq INTEGER UNIQUE NOT NULL, kind TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, retry_owner TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, reviewer_kind TEXT NOT NULL, input_hash TEXT NOT NULL, verdict TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS object_refs (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_runs (run_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, engagement_id TEXT NOT NULL, status TEXT NOT NULL, owner_host TEXT, owner_agent TEXT, generation INTEGER NOT NULL, lease_expires_at TEXT, heartbeat_at TEXT, checkpoint_id TEXT, read_seq INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, work_item_id TEXT NOT NULL, engagement_id TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, owner_host TEXT NOT NULL, owner_agent TEXT NOT NULL, lease_expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (checkpoint_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_intents (action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_sessions (engagement_id TEXT NOT NULL, session_id TEXT NOT NULL, root TEXT NOT NULL, binding_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(engagement_id,session_id));
      CREATE UNIQUE INDEX IF NOT EXISTS artifact_session_root_unique ON artifact_sessions(root);
      CREATE TABLE IF NOT EXISTS artifact_catalog (content_ref TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, session_id TEXT NOT NULL, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, category TEXT, media_type TEXT, stored_at TEXT NOT NULL, work_run_id TEXT, attempt_id TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_chunks (content_ref TEXT NOT NULL, ordinal INTEGER NOT NULL, byte_offset INTEGER NOT NULL, byte_count INTEGER NOT NULL, chunk_hash TEXT NOT NULL, relative_path TEXT NOT NULL, PRIMARY KEY(content_ref,ordinal));
      CREATE TABLE IF NOT EXISTS artifact_catalog_watermarks (engagement_id TEXT NOT NULL, session_id TEXT NOT NULL, catalog_watermark INTEGER NOT NULL, index_watermark INTEGER NOT NULL, index_status TEXT NOT NULL, PRIMARY KEY(engagement_id,session_id));
      CREATE TABLE IF NOT EXISTS artifact_uploads (upload_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, session_id TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_idempotency (key TEXT PRIMARY KEY, operation TEXT NOT NULL, principal TEXT NOT NULL, engagement_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_publications (upload_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, session_id TEXT NOT NULL, content_ref TEXT NOT NULL, phase TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_catalog (execution_id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, session_id TEXT NOT NULL, work_run_id TEXT, attempt_id TEXT, sequence INTEGER NOT NULL, body TEXT NOT NULL);
    `);
    const catalogColumns = this.#db.prepare("PRAGMA table_info(artifact_catalog)").all() as Array<{ name: string }>;
    if (!catalogColumns.some((column) => column.name === "media_type")) this.#db.exec("ALTER TABLE artifact_catalog ADD COLUMN media_type TEXT");
    this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS records_display_id_unique ON records(display_id) WHERE display_id IS NOT NULL;");
    this.#db.exec("CREATE INDEX IF NOT EXISTS artifact_catalog_session_time ON artifact_catalog(engagement_id,session_id,stored_at,content_ref); CREATE INDEX IF NOT EXISTS artifact_catalog_category_time ON artifact_catalog(engagement_id,session_id,category,stored_at,content_ref); CREATE INDEX IF NOT EXISTS artifact_catalog_media_time ON artifact_catalog(engagement_id,session_id,media_type,stored_at,content_ref); CREATE INDEX IF NOT EXISTS artifact_catalog_reference_version ON artifact_catalog(engagement_id,session_id,artifact_id,version); CREATE INDEX IF NOT EXISTS artifact_catalog_work_run ON artifact_catalog(engagement_id,session_id,work_run_id,attempt_id,stored_at,content_ref); CREATE INDEX IF NOT EXISTS artifact_chunks_reference ON artifact_chunks(content_ref,ordinal); CREATE INDEX IF NOT EXISTS execution_catalog_run ON execution_catalog(engagement_id,session_id,work_run_id,attempt_id,sequence,execution_id); CREATE INDEX IF NOT EXISTS artifact_publications_session ON artifact_publications(engagement_id,session_id,phase,updated_at);");
    this.#db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('schema_version',?)").run(SCHEMA_VERSION);
    this.#db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('display_sequence','1')").run();
    this.doctor();
  }
  close(): void { this.#db.close(); }
  artifactSessions(): Array<{ engagement_id: string; session_id: string; root: string; binding_id: string; created_at: string }> { return this.#db.prepare("SELECT engagement_id,session_id,root,binding_id,created_at FROM artifact_sessions").all() as Array<{ engagement_id: string; session_id: string; root: string; binding_id: string; created_at: string }>; }
  executionCatalogRows(input: { engagement_id: string; session_id: string; work_run_id?: string; attempt_id?: string }): Array<Record<string, unknown>> {
    return this.executionCatalogPage({ ...input, page_size: 1000 }).items;
  }
  executionCatalogPage(input: { engagement_id: string; session_id: string; work_run_id?: string; attempt_id?: string; cursor?: string; page_size: number }): { items: Array<Record<string, unknown>>; next_cursor?: string; index_watermark: number } {
    const limit = Math.min(1000, Math.max(1, Math.trunc(input.page_size)));
    const cursor = input.cursor ? (() => { const [sequence, executionId] = input.cursor.split("\0"); const parsed = Number(sequence); if (!Number.isSafeInteger(parsed) || !executionId) throw new ContractValidationError("validation_error", "invalid execution cursor"); return { sequence: parsed, executionId }; })() : undefined;
    const where = ["engagement_id=?", "session_id=?"];
    const values: Array<string | number> = [input.engagement_id, input.session_id];
    if (input.work_run_id) { where.push("work_run_id=?"); values.push(input.work_run_id); }
    if (input.attempt_id) { where.push("attempt_id=?"); values.push(input.attempt_id); }
    if (cursor) { where.push("(sequence>? OR (sequence=? AND execution_id>?))"); values.push(cursor.sequence, cursor.sequence, cursor.executionId); }
    const rows = this.#db.prepare(`SELECT execution_id,sequence,body FROM execution_catalog WHERE ${where.join(" AND ")} ORDER BY sequence,execution_id LIMIT ?`).all(...values, limit + 1) as Array<{ execution_id: string; sequence: number; body: string }>;
    const hasMore = rows.length > limit; const selected = hasMore ? rows.slice(0, limit) : rows;
    const root = this.#db.prepare("SELECT root FROM artifact_sessions WHERE engagement_id=? AND session_id=?").get(input.engagement_id, input.session_id) as { root?: string } | undefined;
    const items = selected.map((row) => {
      const body = JSON.parse(row.body) as Record<string, unknown>;
      if (body.sealed === true || body.quarantine === true) return { ...body, sidecar_status: body.quarantine === true ? "quarantined" : "sealed" };
      if (typeof body.sidecar_path !== "string" || typeof body.sidecar_hash !== "string") return { ...body, sidecar_status: "unavailable" };
      try { const rootPath = resolve(root?.root ?? ""); const path = realpathSync(join(rootPath, body.sidecar_path)); if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`)) return { ...body, sidecar_status: "integrity_failed" }; const content = readFileSync(path); return hash(content.toString("utf8")) === body.sidecar_hash ? { ...body, sidecar_status: "available" } : { ...body, sidecar_status: "integrity_failed" }; } catch { return { ...body, sidecar_status: "unavailable" }; }
    });
    const last = selected.at(-1);
    return { items, next_cursor: hasMore && last ? `${last.sequence}\0${last.execution_id}` : undefined, index_watermark: Number((this.#db.prepare("SELECT COALESCE(MAX(sequence),0) AS value FROM execution_catalog WHERE engagement_id=? AND session_id=?").get(input.engagement_id, input.session_id) as { value: number }).value) };
  }
  private writeExecutionSidecar(input: { engagement_id: string; session_id?: string; work_run_id?: string; attempt_id?: string; generation?: number; kind: "checkpoint" | "action" | "result" | "error"; reference_id: string; metadata: Record<string, unknown> }): Record<string, unknown> {
    if (!input.session_id) return { execution_id: input.reference_id, sidecar_status: "unbound" };
    const binding = this.#db.prepare("SELECT root FROM artifact_sessions WHERE engagement_id=? AND session_id=?").get(input.engagement_id, input.session_id) as { root?: string } | undefined;
    if (!binding?.root) throw new ContractValidationError("authorization_error", "execution sidecar requires a registered task session");
    if (input.work_run_id && input.generation !== undefined && input.metadata.quarantine !== true) {
      const runRow = this.#db.prepare("SELECT engagement_id,generation,status,lease_expires_at,body FROM work_runs WHERE run_id=?").get(input.work_run_id) as { engagement_id?: string; generation?: number; status?: string; lease_expires_at?: string; body?: string } | undefined;
      const runBody = runRow?.body ? JSON.parse(runRow.body) as Record<string, unknown> : {};
      const attemptRow = input.attempt_id ? this.#db.prepare("SELECT status,generation,owner_host,body FROM attempts WHERE attempt_id=? AND run_id=?").get(input.attempt_id,input.work_run_id) as { status?: string; generation?: number; owner_host?: string; body?: string } | undefined : undefined;
      const attemptBody = attemptRow?.body ? JSON.parse(attemptRow.body) as Record<string, unknown> : {};
      if (!runRow || runRow.engagement_id !== input.engagement_id || runBody.task_session_ref !== input.session_id || Number(runRow.generation) !== input.generation || runBody.attempt_ref !== input.attempt_id || !runRow.lease_expires_at || runRow.lease_expires_at <= new Date().toISOString() || !["claimed", "running", "checkpointed", "blocked"].includes(String(runRow.status)) || !attemptRow || Number(attemptRow.generation) !== input.generation || !["claimed", "running", "checkpointed", "blocked"].includes(String(attemptRow.status)) || attemptBody.task_session_ref !== input.session_id) throw new ContractValidationError("stale_version", "execution sidecar is fenced by an inactive or stale Attempt");
    }
    const executionId = uuidv7(); const storedAt = new Date().toISOString(); const day = storedAt.slice(0, 10).split("-"); const run = input.work_run_id ?? "unbound"; const attempt = input.attempt_id ?? "unbound"; const sequence = Number((this.#db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM execution_catalog WHERE engagement_id=? AND session_id=?").get(input.engagement_id, input.session_id) as { next: number }).next);
    const dir = join(binding.root, "execution", ...day, run.slice(0, 2), run, attempt); mkdirSync(dir, { recursive: true, mode: 0o700 }); const body = { schema_version: "1.0.0", execution_id: executionId, kind: input.kind, engagement_id: input.engagement_id, session_id: input.session_id, work_run_id: input.work_run_id, attempt_id: input.attempt_id, generation: input.generation, sequence, reference_id: input.reference_id, stored_at: storedAt, ...sanitizeExecutionMetadata(input.metadata) as Record<string, unknown> }; const text = `# Execution ${executionId}\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`; const temporary = join(dir, `.segment-${executionId}.tmp`); const path = join(dir, `${input.kind}-${String(sequence).padStart(8, "0")}.md`); writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, path); const catalogBody = { ...body, sidecar_path: path.slice(binding.root.length + 1), sidecar_hash: hash(text) }; this.#db.prepare("INSERT INTO execution_catalog(execution_id,engagement_id,session_id,work_run_id,attempt_id,sequence,body) VALUES(?,?,?,?,?,?,?)").run(executionId, input.engagement_id, input.session_id, input.work_run_id ?? null, input.attempt_id ?? null, sequence, JSON.stringify(catalogBody)); return catalogBody;
  }
  saveArtifactSession(binding: { engagement_id: string; session_id: string; root: string; binding_id: string; created_at: string }): void { this.transaction(() => { const roots = this.#db.prepare("SELECT engagement_id,session_id,root FROM artifact_sessions WHERE NOT (engagement_id=? AND session_id=?)").all(binding.engagement_id,binding.session_id) as Array<{ engagement_id: string; session_id: string; root: string }>; const path = resolve(binding.root); if (roots.some((owner) => { const other = resolve(owner.root); return path === other || path.startsWith(`${other}${sep}`) || other.startsWith(`${path}${sep}`); })) throw new ContractValidationError("authorization_error", "task session roots cannot overlap"); const owner = this.#db.prepare("SELECT engagement_id,session_id FROM artifact_sessions WHERE root=?").get(binding.root) as { engagement_id: string; session_id: string } | undefined; if (owner && (owner.engagement_id !== binding.engagement_id || owner.session_id !== binding.session_id)) throw new ContractValidationError("authorization_error", "session root is already bound"); this.#db.prepare("INSERT INTO artifact_sessions(engagement_id,session_id,root,binding_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(engagement_id,session_id) DO UPDATE SET binding_id=artifact_sessions.binding_id,created_at=artifact_sessions.created_at WHERE artifact_sessions.root=excluded.root").run(binding.engagement_id,binding.session_id,binding.root,binding.binding_id,binding.created_at); const row = this.#db.prepare("SELECT root FROM artifact_sessions WHERE engagement_id=? AND session_id=?").get(binding.engagement_id,binding.session_id) as { root?: string } | undefined; if (!row || row.root !== binding.root) throw new ContractValidationError("conflict", "task session is already bound to another root"); }); }
  artifactCatalogRows(): Array<Record<string, unknown>> { return (this.#db.prepare("SELECT body FROM artifact_catalog ORDER BY stored_at,content_ref").all() as Array<{ body: string }>).map((row) => JSON.parse(row.body) as Record<string, unknown>); }
  artifactCatalogRow(engagementId: string, sessionId: string, contentRef: string): Record<string, unknown> | undefined { const row = this.#db.prepare("SELECT body FROM artifact_catalog WHERE engagement_id=? AND session_id=? AND content_ref=?").get(engagementId, sessionId, contentRef) as { body?: string } | undefined; return row?.body ? JSON.parse(row.body) as Record<string, unknown> : undefined; }
  artifactCatalogWatermark(engagementId: string, sessionId: string): { catalog_watermark: number; index_watermark: number; index_status: string } { const row = this.#db.prepare("SELECT catalog_watermark,index_watermark,index_status FROM artifact_catalog_watermarks WHERE engagement_id=? AND session_id=?").get(engagementId, sessionId) as { catalog_watermark: number; index_watermark: number; index_status: string } | undefined; return row ? { catalog_watermark: Number(row.catalog_watermark), index_watermark: Number(row.index_watermark), index_status: row.index_status } : { catalog_watermark: 0, index_watermark: 0, index_status: "current" }; }
  queryArtifactCatalog(input: { engagement_id: string; session_id: string; category?: string; media_type?: string; work_run_id?: string; after?: { stored_at: string; content_ref: string }; limit: number }): { items: Array<Record<string, unknown>>; has_more: boolean; watermark: ReturnType<AuthorityStore["artifactCatalogWatermark"]> } {
    const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit)));
    const where = ["engagement_id=?", "session_id=?"];
    const values: Array<string | number | null> = [input.engagement_id, input.session_id];
    if (input.category) { where.push("category=?"); values.push(input.category); }
    if (input.media_type) { where.push("media_type=?"); values.push(input.media_type); }
    if (input.work_run_id) { where.push("work_run_id=?"); values.push(input.work_run_id); }
    if (input.after) { where.push("(stored_at>? OR (stored_at=? AND content_ref>?))"); values.push(input.after.stored_at, input.after.stored_at, input.after.content_ref); }
    const rows = this.#db.prepare(`SELECT body FROM artifact_catalog WHERE ${where.join(" AND ")} ORDER BY stored_at,content_ref LIMIT ?`).all(...values, limit + 1) as Array<{ body: string }>;
    const has_more = rows.length > limit;
    return { items: rows.slice(0, limit).map((row) => JSON.parse(row.body) as Record<string, unknown>), has_more, watermark: this.artifactCatalogWatermark(input.engagement_id, input.session_id) };
  }
  explainArtifactCatalog(input: { engagement_id: string; session_id: string; category?: string; media_type?: string; work_run_id?: string }): string[] {
    const where = ["engagement_id=?", "session_id=?"];
    const values: string[] = [input.engagement_id, input.session_id];
    if (input.category) { where.push("category=?"); values.push(input.category); }
    if (input.media_type) { where.push("media_type=?"); values.push(input.media_type); }
    if (input.work_run_id) { where.push("work_run_id=?"); values.push(input.work_run_id); }
    return (this.#db.prepare(`EXPLAIN QUERY PLAN SELECT body FROM artifact_catalog WHERE ${where.join(" AND ")} ORDER BY stored_at,content_ref LIMIT 101`).all(...values) as Array<{ detail: string }>).map((row) => row.detail);
  }
  artifactPublications(): Array<{ upload_id: string; engagement_id: string; session_id: string; content_ref: string; phase: string; body: Record<string, unknown> }> { return (this.#db.prepare("SELECT upload_id,engagement_id,session_id,content_ref,phase,body FROM artifact_publications WHERE phase!='committed' ORDER BY updated_at,upload_id").all() as Array<{ upload_id: string; engagement_id: string; session_id: string; content_ref: string; phase: string; body: string }>).map((row) => ({ ...row, body: JSON.parse(row.body) as Record<string, unknown> })); }
  startArtifactPublication(uploadId: string, engagementId: string, sessionId: string, contentRef: string, publishPath: string): void {
    this.transaction(() => {
      const prior = this.#db.prepare("SELECT phase FROM artifact_publications WHERE upload_id=?").get(uploadId) as { phase?: string } | undefined;
      if (prior && prior.phase !== "quarantined") throw new ContractValidationError("conflict", "Artifact publication is already in progress");
      const event = this.nextEvent("artifact.publication.pending", { engagement_id: engagementId, session_id: sessionId, upload_id: uploadId, content_ref: contentRef }, uploadId);
      this.#db.prepare("INSERT INTO artifact_publications(upload_id,engagement_id,session_id,content_ref,phase,body,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(upload_id) DO UPDATE SET engagement_id=excluded.engagement_id,session_id=excluded.session_id,content_ref=excluded.content_ref,phase='publishing',body=excluded.body,updated_at=excluded.updated_at").run(uploadId, engagementId, sessionId, contentRef, "publishing", JSON.stringify({ publish_path: publishPath, marker_event_id: event.event_id, marker_commit_seq: event.commit_seq }), new Date().toISOString());
    });
  }
  prepareArtifactPublication(uploadId: string, row: Record<string, unknown> & { content_ref: string; engagement_id: string; session_id: string }, chunks: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }>, publishPath: string, idempotency?: { key: string; principal: string; request_hash: string; result: unknown }): void {
    this.transaction(() => {
      const publication = this.#db.prepare("SELECT body FROM artifact_publications WHERE upload_id=? AND phase='publishing'").get(uploadId) as { body?: string } | undefined;
      if (!publication?.body) throw new ContractValidationError("conflict", "Artifact publication marker is unavailable");
      const prior = JSON.parse(publication.body) as Record<string, unknown>;
      this.#db.prepare("UPDATE artifact_publications SET phase='ready',body=?,updated_at=? WHERE upload_id=?").run(JSON.stringify({ ...prior, row, chunks, publish_path: publishPath, idempotency }), new Date().toISOString(), uploadId);
    });
  }
  completeArtifactPublication(uploadId: string, row: Record<string, unknown> & { content_ref: string; engagement_id: string; session_id: string; artifact_id: string; version: number; category?: string; stored_at: string; work_run_id?: string; attempt_id?: string; relative_dir: string; manifest_path: string }, chunks: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }>, idempotency?: { key: string; principal: string; request_hash: string; result: unknown }): void {
    this.transaction(() => {
      const publication = this.#db.prepare("SELECT phase,body FROM artifact_publications WHERE upload_id=?").get(uploadId) as { phase?: string; body?: string } | undefined;
      if (!publication || !["ready", "publishing", "published"].includes(String(publication.phase))) throw new ContractValidationError("conflict", "Artifact publication marker is unavailable");
      const category = typeof row.category === "string" ? row.category : null; const mediaType = typeof row.media_type === "string" ? row.media_type : null;
      this.#db.prepare("INSERT INTO artifact_catalog(content_ref,engagement_id,session_id,artifact_id,version,category,media_type,stored_at,work_run_id,attempt_id,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(row.content_ref,row.engagement_id,row.session_id,row.artifact_id,row.version,category,mediaType,row.stored_at,typeof row.work_run_id === "string" ? row.work_run_id : null,typeof row.attempt_id === "string" ? row.attempt_id : null,JSON.stringify(row));
      const add = this.#db.prepare("INSERT INTO artifact_chunks(content_ref,ordinal,byte_offset,byte_count,chunk_hash,relative_path) VALUES(?,?,?,?,?,?)");
      for (const chunk of chunks) add.run(row.content_ref,chunk.ordinal,chunk.offset,chunk.bytes,chunk.hash,chunk.path);
      this.#db.prepare("DELETE FROM artifact_uploads WHERE upload_id=?").run(uploadId);
      if (idempotency?.key) this.#db.prepare("INSERT INTO artifact_idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(idempotency.key,"artifact.store.commit",idempotency.principal,row.engagement_id,idempotency.request_hash,JSON.stringify(idempotency.result));
      this.#db.prepare("INSERT INTO artifact_catalog_watermarks(engagement_id,session_id,catalog_watermark,index_watermark,index_status) VALUES(?,?,1,1,'current') ON CONFLICT(engagement_id,session_id) DO UPDATE SET catalog_watermark=catalog_watermark+1,index_watermark=index_watermark+1,index_status='current'").run(row.engagement_id,row.session_id);
      const marker = JSON.parse(publication.body!) as { marker_commit_seq?: number };
      if (marker.marker_commit_seq) { this.#db.prepare("UPDATE outbox SET status='applied' WHERE commit_seq=?").run(marker.marker_commit_seq); this.#db.prepare("UPDATE operation_markers SET status='indexed',updated_at=? WHERE commit_seq=? AND status='pending'").run(new Date().toISOString(),marker.marker_commit_seq); }
      this.#db.prepare("UPDATE artifact_publications SET phase='committed',updated_at=? WHERE upload_id=?").run(new Date().toISOString(),uploadId);
      this.nextEvent("artifact.content.committed", { engagement_id: row.engagement_id, session_id: row.session_id, content_ref: row.content_ref, byte_length: row.byte_length, content_hash: row.content_hash, chunk_count: row.chunk_count, work_run_id: row.work_run_id, attempt_id: row.attempt_id, generation: row.generation }, row.content_ref);
    });
  }
  updateArtifactCatalogRow(row: Record<string, unknown> & { content_ref: string; engagement_id: string; session_id: string }, eventType: string): void {
    this.transaction(() => { this.#db.prepare("UPDATE artifact_catalog SET body=? WHERE engagement_id=? AND session_id=? AND content_ref=?").run(JSON.stringify(row),row.engagement_id,row.session_id,row.content_ref); this.nextEvent(eventType, { engagement_id: row.engagement_id, session_id: row.session_id, content_ref: row.content_ref, content_status: row.content_status, integrity_status: row.integrity_status }, row.content_ref); });
  }
  markArtifactPublication(uploadId: string, phase: "publishing" | "published" | "quarantined"): void { this.transaction(() => { const changed = this.#db.prepare("UPDATE artifact_publications SET phase=?,updated_at=? WHERE upload_id=? AND phase!='committed'").run(phase,new Date().toISOString(),uploadId); if (Number(changed.changes) !== 1) throw new ContractValidationError("conflict", "Artifact publication marker is unavailable"); }); }
  failArtifactPublication(uploadId: string, reason: string): void { this.transaction(() => { const row = this.#db.prepare("SELECT engagement_id,session_id,content_ref,body FROM artifact_publications WHERE upload_id=?").get(uploadId) as { engagement_id?: string; session_id?: string; content_ref?: string; body?: string } | undefined; if (!row) return; const marker = row.body ? JSON.parse(row.body) as { marker_commit_seq?: number } : {}; const message = reason.slice(0,512); this.#db.prepare("UPDATE artifact_publications SET phase='quarantined',body=?,updated_at=? WHERE upload_id=?").run(JSON.stringify({ ...(row.body ? JSON.parse(row.body) as Record<string, unknown> : {}), failure: message }),new Date().toISOString(),uploadId); if (marker.marker_commit_seq) { this.#db.prepare("UPDATE outbox SET status='applied' WHERE commit_seq=?").run(marker.marker_commit_seq); this.#db.prepare("UPDATE operation_markers SET status='failed',error=?,updated_at=? WHERE commit_seq=?").run(message,new Date().toISOString(),marker.marker_commit_seq); } this.nextEvent("artifact.publication.quarantined", { engagement_id: row.engagement_id, session_id: row.session_id, content_ref: row.content_ref, reason: message }, uploadId); }); }
  saveArtifactCatalogRow(row: Record<string, unknown> & { content_ref: string; engagement_id: string; session_id: string; artifact_id: string; version: number; category?: string; stored_at: string; work_run_id?: string; attempt_id?: string; relative_dir: string; manifest_path: string }, chunks: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }>, uploadId?: string, idempotency?: { key: string; principal: string; request_hash: string; result: unknown }): void {
    this.transaction(() => { const category = typeof row.category === "string" ? row.category : null; const mediaType = typeof row.media_type === "string" ? row.media_type : null; this.#db.prepare("INSERT INTO artifact_catalog(content_ref,engagement_id,session_id,artifact_id,version,category,media_type,stored_at,work_run_id,attempt_id,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(row.content_ref,row.engagement_id,row.session_id,row.artifact_id,row.version,category,mediaType,row.stored_at,typeof row.work_run_id === "string" ? row.work_run_id : null,typeof row.attempt_id === "string" ? row.attempt_id : null,JSON.stringify(row)); const add = this.#db.prepare("INSERT INTO artifact_chunks(content_ref,ordinal,byte_offset,byte_count,chunk_hash,relative_path) VALUES(?,?,?,?,?,?)"); for (const chunk of chunks) add.run(row.content_ref,chunk.ordinal,chunk.offset,chunk.bytes,chunk.hash,chunk.path); if (uploadId) this.#db.prepare("DELETE FROM artifact_uploads WHERE upload_id=?").run(uploadId); if (idempotency?.key) this.#db.prepare("INSERT INTO artifact_idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(idempotency.key,"artifact.store.commit",idempotency.principal,row.engagement_id,idempotency.request_hash,JSON.stringify(idempotency.result)); this.#db.prepare("INSERT INTO artifact_catalog_watermarks(engagement_id,session_id,catalog_watermark,index_watermark,index_status) VALUES(?,?,1,1,'current') ON CONFLICT(engagement_id,session_id) DO UPDATE SET catalog_watermark=catalog_watermark+1,index_watermark=index_watermark+1,index_status='current'").run(row.engagement_id,row.session_id); this.nextEvent(row.content_status === "external" ? "artifact.reference.external" : "artifact.content.committed", { engagement_id: row.engagement_id, session_id: row.session_id, content_ref: row.content_ref, byte_length: row.byte_length, content_hash: row.content_hash, chunk_count: row.chunk_count, work_run_id: row.work_run_id, attempt_id: row.attempt_id, generation: row.generation }, row.content_ref); });
  }
  saveArtifactUpload(uploadId: string, engagementId: string, sessionId: string, body: Record<string, unknown>): void { this.transaction(() => { this.#db.prepare("INSERT INTO artifact_uploads(upload_id,engagement_id,session_id,body,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(upload_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at").run(uploadId,engagementId,sessionId,JSON.stringify(body),new Date().toISOString()); }); }
  artifactUploads(): Array<{ upload_id: string; engagement_id: string; session_id: string; body: Record<string, unknown> }> { return (this.#db.prepare("SELECT upload_id,engagement_id,session_id,body FROM artifact_uploads").all() as Array<{ upload_id: string; engagement_id: string; session_id: string; body: string }>).map((row) => ({ ...row, body: JSON.parse(row.body) as Record<string, unknown> })); }
  deleteArtifactUpload(uploadId: string): void { this.transaction(() => { this.#db.prepare("DELETE FROM artifact_uploads WHERE upload_id=?").run(uploadId); }); }
  artifactIdempotencyResult(key: string, operation: string, principal: string, engagementId: string, requestHash: string): unknown | undefined { const row = this.#db.prepare("SELECT operation,principal,engagement_id,request_hash,result FROM artifact_idempotency WHERE key=?").get(key) as { operation: string; principal: string; engagement_id: string; request_hash: string; result: string } | undefined; if (!row) return undefined; if (row.operation !== operation || row.principal !== principal || row.engagement_id !== engagementId || row.request_hash !== requestHash) throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another Artifact request"); return JSON.parse(row.result) as unknown; }
  saveArtifactIdempotency(key: string, operation: string, principal: string, engagementId: string, requestHash: string, result: unknown): void { this.transaction(() => { this.#db.prepare("INSERT INTO artifact_idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(key,operation,principal,engagementId,requestHash,JSON.stringify(result)); }); }
  recordArtifactEvent(eventType: string, engagementId: string, subjectId: string, metadata: Record<string, unknown>): void { this.transaction(() => { this.nextEvent(eventType, { engagement_id: engagementId, ...metadata }, subjectId); }); }
  /** Authority corruption blocks further writes until an operator repairs the store. */
  private authorityDrift(): string[] {
    const errors: string[] = [];
    const events = this.#db.prepare("SELECT commit_seq FROM events ORDER BY commit_seq").all() as Array<{ commit_seq: number }>;
    events.forEach((event, index) => { if (Number(event.commit_seq) !== index + 1) errors.push(`event sequence gap at ${event.commit_seq}`); });
    const counter = Number((this.#db.prepare("SELECT value FROM metadata WHERE key='display_sequence'").get() as { value?: string } | undefined)?.value ?? NaN);
    const aliases = this.#db.prepare("SELECT display_id FROM records WHERE display_id IS NOT NULL").all() as Array<{ display_id: string }>;
    const maxAlias = aliases.reduce((max, row) => {
      const match = /^TAR-(\d+)$/.exec(row.display_id);
      if (!match) errors.push(`invalid display id in records: ${row.display_id}`);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    if (!Number.isSafeInteger(counter) || counter < maxAlias + 1) errors.push(`display counter drift: ${Number.isFinite(counter) ? counter : "missing"} < ${maxAlias + 1}`);
    const idempotency = this.#db.prepare("SELECT key,operation,principal,engagement_id,request_hash,result FROM idempotency").all() as Array<Record<string, unknown>>;
    for (const row of idempotency) {
      if (!["key", "operation", "principal", "engagement_id", "request_hash", "result"].every((field) => typeof row[field] === "string" && String(row[field]).length > 0)) errors.push(`idempotency row ${String(row.key)} is incomplete`);
      if (typeof row.request_hash === "string" && !/^sha256:[a-f0-9]{64}$/.test(row.request_hash)) errors.push(`idempotency row ${String(row.key)} has an invalid request hash`);
      try { JSON.parse(String(row.result)); } catch { errors.push(`idempotency row ${String(row.key)} has invalid result`); }
    }
    const materialized = this.#db.prepare("SELECT id,version,body,engagement_id,kind FROM records").all() as Array<{ id: string; version: number; body: string; engagement_id: string; kind: string }>;
    for (const row of materialized) {
      const latest = this.#db.prepare("SELECT body,commit_seq FROM record_versions WHERE id=? ORDER BY commit_seq DESC LIMIT 1").get(row.id) as { body?: string; commit_seq?: number } | undefined;
      const currentVersion = latest?.commit_seq === undefined ? undefined : Number((this.#db.prepare("SELECT COUNT(*) AS count FROM record_versions WHERE id=?").get(row.id) as { count: number }).count);
      if (!latest || latest.body !== row.body || currentVersion !== Number(row.version)) errors.push(`record materialized view drift: ${row.id}`);
      const ref = this.#db.prepare("SELECT engagement_id,kind FROM object_refs WHERE id=?").get(row.id) as { engagement_id?: string; kind?: string } | undefined;
      if (!ref || ref.engagement_id !== row.engagement_id || ref.kind !== row.kind) errors.push(`object reference drift: ${row.id}`);
    }
    if (this.#filename !== ":memory:") {
      try {
        const mode = statSync(this.#filename).mode;
        if ((mode & 0o200) === 0) errors.push("authority store is not owner-writable");
        if ((mode & 0o022) !== 0) errors.push("authority store is writable by group or other users");
      } catch { errors.push("authority store permissions could not be checked"); }
    }
    const recordEvents = this.#db.prepare("SELECT e.commit_seq,e.subject_id,e.payload,v.body FROM events e LEFT JOIN record_versions v ON v.commit_seq=e.commit_seq WHERE e.event_type='record.commit'").all() as Array<{ commit_seq: number; subject_id: string | null; payload: string; body: string | null }>;
    for (const row of recordEvents) {
      if (!row.body) { errors.push(`record event has no version row at sequence ${row.commit_seq}`); continue; }
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        if (payload.after_hash !== hash(row.body)) errors.push(`record event body drift at sequence ${row.commit_seq}`);
      } catch { errors.push(`record event payload is invalid at sequence ${row.commit_seq}`); }
    }
    return errors;
  }
  private derivedDrift(): { errors: string[]; missingOutbox: number; missingMarkers: number } {
    const errors: string[] = [];
    const missingOutbox = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM events e LEFT JOIN outbox o ON o.commit_seq=e.commit_seq WHERE o.commit_seq IS NULL").get() as { count: number }).count);
    const missingMarkers = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM events e LEFT JOIN operation_markers m ON m.commit_seq=e.commit_seq WHERE m.commit_seq IS NULL").get() as { count: number }).count);
    if (missingOutbox > 0) errors.push(`${missingOutbox} committed event(s) have no outbox row`);
    if (missingMarkers > 0) errors.push(`${missingMarkers} committed event(s) have no operation marker`);
    const invalidOutbox = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM outbox o LEFT JOIN events e ON e.commit_seq=o.commit_seq WHERE e.commit_seq IS NULL OR o.status NOT IN ('pending','applied')").get() as { count: number }).count);
    if (invalidOutbox > 0) errors.push(`${invalidOutbox} outbox row(s) reference missing events or have an invalid status`);
    const invalidMarkers = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM operation_markers m LEFT JOIN events e ON e.commit_seq=m.commit_seq AND e.event_id=m.event_id WHERE e.commit_seq IS NULL OR m.status NOT IN ('pending','applied','indexed','failed','recovered')").get() as { count: number }).count);
    if (invalidMarkers > 0) errors.push(`${invalidMarkers} operation marker(s) reference missing events or have an invalid status`);
    const inconsistentMarkers = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM operation_markers m JOIN outbox o ON o.commit_seq=m.commit_seq WHERE (m.status='pending' AND o.status!='pending') OR (m.status IN ('applied','indexed','recovered') AND o.status!='applied')").get() as { count: number }).count);
    if (inconsistentMarkers > 0) errors.push(`${inconsistentMarkers} operation marker(s) disagree with their outbox state`);
    const markerRows = this.#db.prepare("SELECT m.commit_seq,m.kind,m.input_hash,e.event_type,e.subject_id,e.payload FROM operation_markers m JOIN events e ON e.commit_seq=m.commit_seq").all() as Array<{ commit_seq: number; kind: string; input_hash: string; event_type: string; subject_id: string | null; payload: string }>;
    for (const row of markerRows) {
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        if (row.kind !== row.event_type || row.input_hash !== hash(json({ event_type: row.event_type, subject_id: row.subject_id ?? undefined, payload }))) errors.push(`operation marker input drift at sequence ${row.commit_seq}`);
      } catch { errors.push(`operation marker payload is invalid at sequence ${row.commit_seq}`); }
    }
    return { errors, missingOutbox, missingMarkers };
  }
  private assertAuthorityWritable(): void {
    const errors = this.authorityDrift();
    if (errors.length > 0) throw new ContractValidationError("conflict", `authority drift blocks writes: ${errors.join("; ")}`);
  }
  private projectedSequence(): number {
    const rows = this.#db.prepare("SELECT commit_seq,status FROM outbox ORDER BY commit_seq").all() as Array<{ commit_seq: number; status: string }>;
    let projected = 0;
    for (const row of rows) {
      if (Number(row.commit_seq) !== projected + 1 || row.status !== "applied") break;
      projected = Number(row.commit_seq);
    }
    return projected;
  }
  private isRecalled(record: CanonicalRecord): boolean {
    const status = String(record.status ?? "active");
    if (["stale", "retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(status) || record.recall_excluded === true) return true;
    const now = Date.now();
    return (typeof record.expires_at === "string" && Date.parse(record.expires_at) <= now)
      || (typeof record.review_after === "string" && Date.parse(record.review_after) <= now);
  }
  private evidenceSnapshotHash(proposal: Proposal): string {
    const references = [...new Set([
      ...(Array.isArray(proposal.content.evidence_refs) ? proposal.content.evidence_refs as string[] : []),
      ...(Array.isArray(proposal.content.claim_refs) ? proposal.content.claim_refs as string[] : []),
      ...(Array.isArray(proposal.content.counter_evidence_refs) ? proposal.content.counter_evidence_refs as string[] : []),
      ...(typeof proposal.content.applicable_scope_ref === "string" ? [proposal.content.applicable_scope_ref] : []),
    ])].sort();
    const snapshot = references.map((id) => {
      const row = this.#db.prepare("SELECT engagement_id,version,body FROM records WHERE id=?").get(id) as { engagement_id?: string; version?: number; body?: string } | undefined;
      if (!row || row.engagement_id !== proposal.engagement_id) throw new ContractValidationError("validation_error", `review evidence is missing or outside the engagement: ${id}`);
      const record = JSON.parse(row.body!) as CanonicalRecord;
      if (this.isRecalled(record)) throw new ContractValidationError("validation_error", `review evidence is not current: ${id}`);
      return { id, version: row.version, hash: hash(json(stablePayload(record))) };
    });
    return hash(json({ proposal_hash: proposal.content_hash, snapshot }));
  }
  /**
   * Evidence snapshot digest that reports missing or recalled references instead of
   * throwing, so admission can return a structured reason rather than an exception
   * (task 1.2: invalid evidence must fail closed with an auditable cause).
   */
  private evidenceSnapshot(proposal: Proposal): { hash: string; errors: string[] } {
    try {
      return { hash: this.evidenceSnapshotHash(proposal), errors: [] };
    } catch (cause) {
      return { hash: hash(json({ proposal_hash: proposal.content_hash, snapshot: "unavailable" })), errors: [cause instanceof Error ? cause.message : "evidence snapshot is unavailable"] };
    }
  }
  private transaction<T>(operation: () => T): T {
    const nested = this.#transactionDepth > 0;
    if (!nested && this.#writeBlocked) this.assertAuthorityWritable();
    const savepoint = `authority_tx_${this.#transactionDepth}`;
    this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.#transactionDepth++;
    try {
      const result = operation();
      this.#db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.#db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth--;
    }
  }
  private readTransaction<T>(operation: () => T): T {
    const nested = this.#transactionDepth > 0;
    const savepoint = `authority_read_${this.#transactionDepth}`;
    this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN DEFERRED");
    this.#transactionDepth++;
    try {
      const result = operation();
      this.#db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.#db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth--;
    }
  }
  private nextEvent(eventType: string, payload: Record<string, unknown>, subjectId?: string): AuditEvent {
    // Every event carries attributable, content-free governance metadata. The
    // event payload remains extensible, while these fields make audit queries
    // deterministic across record, work, review, and action transitions.
    const metadata = {
      actor_id: String(payload.actor_id ?? "taric-core"),
      host_id: payload.host_id,
      worker_id: payload.worker_id ?? payload.agent_id,
      dispatch_id: payload.dispatch_id,
      work_item_id: payload.work_item_id,
      attempt_id: payload.attempt_id ?? payload.attempt_ref,
      proposal_id: payload.proposal_id,
      review_id: payload.review_id,
      entity_id: payload.entity_id ?? subjectId,
      policy_digest: payload.policy_digest,
      input_hash: payload.input_hash,
      evidence_refs: Array.isArray(payload.evidence_refs) ? payload.evidence_refs : undefined,
      idempotency_key: payload.idempotency_key,
      changed_fields: Array.isArray(payload.changed_fields) ? payload.changed_fields : undefined,
    };
    payload = { ...metadata, ...payload };
    const last = this.#db.prepare("SELECT hash FROM events ORDER BY commit_seq DESC LIMIT 1").get() as { hash?: string } | undefined;
    const created_at = new Date().toISOString();
    const prev_hash = last?.hash ?? null;
    const event_id = uuidv7();
    const canonical = json({ event_id, eventType, subjectId, payload, prev_hash, created_at });
    const event = { event_id, commit_seq: 0, event_type: eventType, subject_id: subjectId, payload, prev_hash, hash: hash(canonical), created_at, ...metadata } as AuditEvent;
    const result = this.#db.prepare("INSERT INTO events(event_id,event_type,subject_id,payload,prev_hash,hash,created_at) VALUES(?,?,?,?,?,?,?)").run(event_id, eventType, subjectId ?? null, json(payload), prev_hash, event.hash, created_at);
    event.commit_seq = Number(result.lastInsertRowid);
    this.#db.prepare("INSERT INTO outbox(commit_seq) VALUES(?)").run(event.commit_seq);
    const owner = subjectId ? this.#db.prepare("SELECT engagement_id FROM object_refs WHERE id=? UNION SELECT engagement_id FROM proposals WHERE id=? UNION SELECT engagement_id FROM work_runs WHERE run_id=? LIMIT 1").get(subjectId, subjectId, subjectId) as { engagement_id?: string } | undefined : undefined;
    const engagementId = typeof payload.engagement_id === "string" ? payload.engagement_id : owner?.engagement_id;
    this.#db.prepare("INSERT INTO operation_markers(operation_id,event_id,engagement_id,commit_seq,kind,input_hash,status,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(`operation:${event.event_id}`, event.event_id, engagementId ?? null, event.commit_seq, eventType, hash(json({ event_type: eventType, subject_id: subjectId, payload })), "pending", created_at);
    return event;
  }
  private normalizeRecord(record: CanonicalRecord, trustLevel: TrustLevel, internal = false): CanonicalRecord {
    if (record.trust_level !== undefined && record.trust_level !== trustLevel) throw new ContractValidationError("validation_error", "caller cannot set trust level");
    if (!internal && record.display_id !== undefined) throw new ContractValidationError("validation_error", "caller cannot set display id");
    const kind = String(record.kind ?? record.type ?? "record");
    const source = internal ? Object.fromEntries(Object.entries(record).filter(([key]) => !["version", "trust_level", "display_id", "commit_seq"].includes(key))) : record;
    const normalized = { schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" }, ...source } as unknown as CanonicalRecord;
    if (record.schema_version !== undefined && record.schema_version !== SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "record schema version is not supported");
    // 声明了 schema_version 的 Phase 1 领域记录必须通过共享 JSON Schema 合同，不允许只做形状检查。
    // Internal updates originate from a previously validated canonical record. They still
    // pass cross-field validation below, while ordinary caller writes that declare a schema
    // version must satisfy the complete strict contract.
    if (!internal && record.schema_version !== undefined && (phaseOneContracts.has(kind) || recordContractNames[kind])) validateContract((recordContractNames[kind] ?? kind) as ContractName, normalized);
    // 跨字段安全护栏对每一条写入都生效，包括内部 writer 调用。
    validateCanonicalRecord(normalized, trustLevel);
    return normalized;
  }
  commit(record: CanonicalRecord, trustLevel: TrustLevel = "L1", idempotencyKey?: string, context?: Partial<IdempotencyContext>, internal = false, expectedVersion?: number, importedDisplayId?: string, referencesValidated = false): CanonicalRecord {
    this.assertAuthorityWritable();
    expectedVersion ??= context?.expected_version;
    const normalized = this.normalizeRecord(record, trustLevel, internal);
    const operation = context?.operation ?? "record.commit";
    const principal = context?.principal ?? "core";
    const engagementId = context?.engagement_id ?? normalized.engagement_id;
    const requestHash = hash(json(stablePayload(record)));
    return this.transaction(() => {
      if (idempotencyKey) {
        const prior = this.#db.prepare("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?").get(idempotencyKey) as { result?: string; operation?: string; principal?: string; engagement_id?: string; request_hash?: string } | undefined;
        if (prior) {
          if (prior.request_hash !== requestHash || prior.operation !== operation || prior.principal !== principal || prior.engagement_id !== engagementId) throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
          return JSON.parse(prior.result!) as CanonicalRecord;
        }
      }
      const now = new Date().toISOString();
      const existing = this.#db.prepare("SELECT version,body,display_id FROM records WHERE id=?").get(normalized.id) as { version?: number; body?: string; display_id?: string } | undefined;
      if (existing) {
        if (["resource_revision", "relation", "test_hypothesis", "attack_path", "protective_control_revision"].includes(String(normalized.kind ?? normalized.type))) throw new ContractValidationError("conflict", "immutable revision records must be appended, not overwritten");
        if (expectedVersion === undefined || Number(existing.version) !== expectedVersion) throw new ContractValidationError("stale_version", "canonical update requires the current expected version");
        const prior = JSON.parse(existing.body!) as CanonicalRecord;
        const nextKind = String(normalized.kind ?? normalized.type ?? "record");
        if (prior.engagement_id !== normalized.engagement_id || String(prior.kind ?? prior.type ?? "record") !== nextKind) throw new ContractValidationError("conflict", "canonical engagement ownership and kind are immutable");
      } else if (expectedVersion !== undefined && expectedVersion !== 0) {
        throw new ContractValidationError("stale_version", "canonical create expected version must be zero");
      }
      const version = (existing?.version ?? 0) + 1;
      const aliasSequence = existing || importedDisplayId ? undefined : Number((this.#db.prepare("SELECT value FROM metadata WHERE key='display_sequence'").get() as { value: string }).value);
      if (aliasSequence !== undefined) this.#db.prepare("UPDATE metadata SET value=? WHERE key='display_sequence'").run(String(aliasSequence + 1));
      const old = existing?.body ? JSON.parse(existing.body) as CanonicalRecord : undefined;
      const committed = { ...normalized, version, trust_level: trustLevel, display_id: existing?.display_id ?? importedDisplayId ?? (aliasSequence === undefined ? undefined : `TAR-${String(aliasSequence).padStart(6, "0")}`) };
      const rows = this.#db.prepare("SELECT id,engagement_id,kind FROM object_refs").all() as Array<{id:string;engagement_id:string;kind:string}>;
      const statusRows = this.#db.prepare("SELECT id,body FROM records").all() as Array<{id:string;body:string}>;
      if (!referencesValidated) validateAuthorityReferences(committed, {
        engagement: new Map(rows.map((row) => [row.id, row.engagement_id])),
        kind: new Map(rows.map((row) => [row.id, row.kind])),
        status: new Map(statusRows.map((row) => [row.id, String((JSON.parse(row.body) as CanonicalRecord).status ?? "active")])),
      }, normalized.engagement_id);
      this.#db.prepare("INSERT INTO records(id,engagement_id,kind,trust_level,version,display_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,trust_level=excluded.trust_level,version=excluded.version,updated_at=excluded.updated_at").run(normalized.id, normalized.engagement_id, String(normalized.kind ?? normalized.type ?? "record"), trustLevel, version, committed.display_id ?? null, json(committed), now, now);
      this.#db.prepare("INSERT OR REPLACE INTO object_refs(id,engagement_id,kind) VALUES(?,?,?)").run(normalized.id, normalized.engagement_id, String(normalized.kind ?? normalized.type ?? "record"));
      const event = this.nextEvent("record.commit", { version, trust_level: trustLevel, before_hash: old ? hash(json(old)) : null, after_hash: hash(json(committed)), changed_fields: Object.keys(committed).filter((key) => !old || json(old[key]) !== json((committed as Record<string, unknown>)[key])) }, normalized.id);
      this.#db.prepare("INSERT INTO record_versions(id,commit_seq,engagement_id,trust_level,body) VALUES(?,?,?,?,?)").run(normalized.id, event.commit_seq, normalized.engagement_id, trustLevel, json(committed));
      const result = { ...committed, commit_seq: event.commit_seq };
      if (idempotencyKey) this.#db.prepare("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(idempotencyKey, operation, principal, engagementId, requestHash, json(result));
      return result;
    });
  }
  get(id: string): CanonicalRecord | undefined {
    const row = this.#db.prepare("SELECT body FROM records WHERE id=?").get(id) as { body?: string } | undefined;
    return row ? JSON.parse(row.body!) : undefined;
  }
  list(engagementId: string, options: { trustLevel?: TrustLevel; includeCandidates?: boolean; includeRecalled?: boolean } = {}): CanonicalRecord[] {
    const rows = this.#db.prepare("SELECT body,trust_level FROM records WHERE engagement_id=? ORDER BY updated_at,id").all(engagementId) as Array<{ body: string; trust_level: TrustLevel }>;
    return rows.filter((row) => {
      const body = JSON.parse(row.body) as CanonicalRecord;
      return row.trust_level !== "L0" && (options.includeRecalled || !this.isRecalled(body)) && (options.includeCandidates || row.trust_level !== "L1" || options.trustLevel === "L1") && (!options.trustLevel || row.trust_level === options.trustLevel);
    }).map((row) => JSON.parse(row.body));
  }
  snapshot(engagementId: string, options: { trustLevel?: TrustLevel; includeCandidates?: boolean; asOf?: number } = {}): ReadSnapshot {
    return this.readTransaction(() => {
    const current = Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as { seq: number }).seq);
    const seq = options.asOf ?? current;
    if (!Number.isInteger(seq) || seq < 0 || seq > current) throw new ContractValidationError("conflict", `unsupported authority sequence: ${seq}`);
    const rows = this.#db.prepare("SELECT body,trust_level FROM record_versions WHERE engagement_id=? AND commit_seq<=? ORDER BY commit_seq DESC").all(engagementId, seq) as Array<{ body: string; trust_level: TrustLevel }>;
    const asOfTime = options.asOf === undefined ? Date.now() : Date.parse(String((this.#db.prepare("SELECT created_at FROM events WHERE commit_seq<=? ORDER BY commit_seq DESC LIMIT 1").get(seq) as { created_at?: string } | undefined)?.created_at ?? "1970-01-01T00:00:00.000Z"));
    const seen = new Set<string>();
    const records = rows.filter((row) => { const body = JSON.parse(row.body) as CanonicalRecord; if (seen.has(body.id)) return false; seen.add(body.id); const recalled = ["stale", "retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(String(body.status ?? "active")) || body.recall_excluded === true || (typeof body.expires_at === "string" && Date.parse(body.expires_at) <= asOfTime) || (typeof body.review_after === "string" && Date.parse(body.review_after) <= asOfTime); return row.trust_level !== "L0" && !recalled && (options.includeCandidates || row.trust_level !== "L1" || options.trustLevel === "L1") && (!options.trustLevel || row.trust_level === options.trustLevel); }).map((row) => JSON.parse(row.body) as CanonicalRecord).sort((a, b) => a.id.localeCompare(b.id));
    const projected = this.projectedSequence();
    return { read_seq: seq, committed_seq: current, projected_seq: Math.min(projected, seq), records };
    });
  }

  doctor(): DoctorReport {
    const schema = (this.#db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as { value?: string } | undefined)?.value ?? "missing";
    const pending = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status != 'applied'").get() as { count: number }).count);
    const committed = Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as { seq: number }).seq);
    const projected = this.projectedSequence();
    const markerRows = this.#db.prepare("SELECT status,COUNT(*) AS count FROM operation_markers GROUP BY status").all() as Array<{ status: OperationMarker["status"]; count: number }>;
    const operation_markers = { pending: 0, applied: 0, indexed: 0, failed: 0, recovered: 0 } as Record<OperationMarker["status"], number>;
    for (const row of markerRows) if (row.status in operation_markers) operation_markers[row.status] = Number(row.count);
    const audit = this.verifyAudit();
    const authorityErrors = [...this.authorityDrift()];
    if (schema !== SCHEMA_VERSION) authorityErrors.push(`unsupported schema version: ${schema}`);
    if (!audit.valid) authorityErrors.push(...audit.errors);
    this.#writeBlocked = authorityErrors.length > 0;
    const derivedState = this.derivedDrift();
    const derivedErrors = [...derivedState.errors];
    if (pending > 0) derivedErrors.push(`${pending} operation(s) remain pending in the outbox`);
    if (projected < committed) derivedErrors.push(`projection watermark is behind authority: ${projected} < ${committed}`);
    if (operation_markers.failed > 0) derivedErrors.push(`${operation_markers.failed} operation marker(s) failed and require recovery`);
    const errors = [...authorityErrors, ...derivedErrors];
    return {
      valid: errors.length === 0,
      schema_version: schema,
      committed_seq: committed,
      projected_seq: projected,
      pending_outbox: pending,
      operation_markers,
      authority: { valid: authorityErrors.length === 0, errors: authorityErrors },
      derived: { valid: derivedErrors.length === 0, errors: derivedErrors, repair_actions: derivedErrors.length > 0 ? ["run operator reconcile with action=preview, then action=replay or action=rebuild"] : [] },
      audit,
      errors,
    };
  }

  operationMarkers(): OperationMarker[] {
    return (this.#db.prepare("SELECT operation_id,event_id,engagement_id,commit_seq,kind,input_hash,status,error,retry_owner,updated_at FROM operation_markers ORDER BY commit_seq").all() as Array<Record<string, unknown>>)
      .map((row) => ({ ...row, engagement_id: row.engagement_id ?? undefined, error: row.error ?? undefined, retry_owner: row.retry_owner ?? undefined, commit_seq: Number(row.commit_seq) }) as OperationMarker);
  }

  previewRecovery(): OperationRecoveryPreview {
    const drift = this.derivedDrift();
    const failed = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM operation_markers WHERE status='failed'").get() as { count: number }).count);
    const authorityValid = this.authorityDrift().length === 0 && this.verifyAudit().valid;
    const writable = this.#filename === ":memory:" || (() => { try { const mode = statSync(this.#filename).mode; return (mode & 0o200) !== 0 && (mode & 0o022) === 0; } catch { return false; } })();
    const repair_actions: string[] = [];
    if (drift.missingOutbox || drift.missingMarkers) repair_actions.push("rebuild derived outbox and operation markers from authority events");
    if (failed > 0) repair_actions.push("replay failed operations with an operator retry owner");
    if (!authorityValid) repair_actions.push("block authority writes and restore verified authority state before derived recovery");
    if (!writable) repair_actions.push("restore write permission for the authority store");
    return {
      action: "preview",
      committed_seq: Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as { seq: number }).seq),
      pending_outbox: Number((this.#db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'").get() as { count: number }).count),
      failed_markers: failed,
      missing_outbox: drift.missingOutbox,
      missing_markers: drift.missingMarkers,
      authority_valid: authorityValid,
      authority_writable: writable,
      repair_actions,
    };
  }

  exportSnapshot(engagementId: string, asOf?: number): { schema_version: string; engagement_id: string; read_seq: number; committed_seq: number; projected_seq: number; records: CanonicalRecord[]; hash: string } {
    const snapshot = this.snapshot(engagementId, { asOf, includeCandidates: true });
    const sensitive = /(?:token|secret|credential|private_path|artifact_body|draft_body|raw_artifact|host_ref|location|summary|url|header|cookie|body|packet)/i;
    // Export is an authority migration boundary, so retain L0 and recalled history
    // that the ordinary recall API intentionally hides.
    const rows = this.#db.prepare("SELECT body FROM record_versions WHERE engagement_id=? AND commit_seq<=? ORDER BY commit_seq DESC").all(engagementId, snapshot.read_seq) as Array<{ body: string }>;
    const seen = new Set<string>();
    const records = rows.map((row) => JSON.parse(row.body) as CanonicalRecord).filter((record) => { if (seen.has(record.id)) return false; seen.add(record.id); return true; }).map((record) => sanitizeSnapshotRecord(record, sensitive)).map((record) => record as CanonicalRecord);
    const payload = { schema_version: SCHEMA_VERSION, core_version: "1.0.0", engagement_id: engagementId, read_seq: snapshot.read_seq, committed_seq: snapshot.committed_seq, projected_seq: snapshot.projected_seq, format: "taric-native-json", records };
    return { ...payload, hash: hash(json(payload)) };
  }

  exportSnapshotJsonl(engagementId: string, asOf?: number): string {
    const snapshot = this.exportSnapshot(engagementId, asOf);
    const header = { format: "taric-native-jsonl", schema_version: snapshot.schema_version, engagement_id: snapshot.engagement_id, read_seq: snapshot.read_seq, committed_seq: snapshot.committed_seq, projected_seq: snapshot.projected_seq, integrity_hash: snapshot.hash };
    return [json({ type: "manifest", ...header }), ...snapshot.records.map((record) => json({ type: "record", record }))].join("\n") + "\n";
  }

  importSnapshot(snapshotInput: unknown): { engagement_id: string; recovered_sequence: number; imported_records: number; integrity_verified: true; display_sequence: number } {
    const snapshot = (typeof snapshotInput === "string"
      ? (snapshotInput.trim().includes("\n") ? { format: "taric-native-jsonl" } : JSON.parse(snapshotInput))
      : snapshotInput) as Record<string, unknown>;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new ContractValidationError("validation_error", "snapshot must be an object or JSONL string");
    let normalized: Record<string, unknown>;
    if (snapshot.format === "taric-native-jsonl") {
      const lines = (typeof snapshotInput === "string" ? snapshotInput : "").trim().split(/\r?\n/);
      if (lines.length < 1) throw new ContractValidationError("validation_error", "snapshot JSONL is empty");
      const manifest = JSON.parse(lines[0]) as Record<string, unknown>;
      if (manifest.type !== "manifest" || lines.slice(1).some((line) => !line.trim())) throw new ContractValidationError("validation_error", "snapshot JSONL has an invalid manifest or empty row");
      const records = lines.slice(1).map((line) => {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.type !== "record" || !row.record || typeof row.record !== "object") throw new ContractValidationError("validation_error", "snapshot JSONL contains an invalid record row");
        return row.record;
      });
      normalized = { schema_version: manifest.schema_version, core_version: "1.0.0", engagement_id: manifest.engagement_id, read_seq: manifest.read_seq, committed_seq: manifest.committed_seq, projected_seq: manifest.projected_seq, format: "taric-native-json", records, hash: manifest.integrity_hash };
    } else normalized = snapshot;
    const { hash: suppliedHash, records, ...payload } = normalized;
    if (payload.schema_version !== SCHEMA_VERSION || payload.format !== "taric-native-json" || typeof payload.engagement_id !== "string" || !Number.isSafeInteger(payload.read_seq) || !Array.isArray(records) || typeof suppliedHash !== "string") throw new ContractValidationError("unsupported_schema_version", "snapshot metadata is incomplete or incompatible");
    if (hash(json(payloadWithRecords(payload, records))) !== suppliedHash) throw new ContractValidationError("validation_error", "snapshot integrity hash mismatch");
    const engagementId = String(payload.engagement_id);
    const candidates = records as CanonicalRecord[];
    if (!candidates.length || !candidates.some((record) => record.id === engagementId && String(record.kind) === "engagement")) throw new ContractValidationError("validation_error", "snapshot must contain its Engagement record");
    if (candidates.some((record) => !record || record.engagement_id !== engagementId || typeof record.id !== "string" || !/^TAR-[0-9]{6,}$/.test(String(record.display_id ?? "")))) throw new ContractValidationError("validation_error", "snapshot record ownership or display alias is invalid");
    const ids = new Set<string>(); const aliases = new Set<string>();
    for (const record of candidates) {
      if (ids.has(record.id) || aliases.has(String(record.display_id))) throw new ContractValidationError("conflict", "snapshot contains duplicate record or display identity");
      ids.add(record.id); aliases.add(String(record.display_id));
      validateCanonicalRecord(record, record.trust_level);
      if (record.schema_version !== SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "snapshot record schema version is incompatible");
      const kind = String(record.kind ?? "record");
      if (phaseOneContracts.has(kind) || recordContractNames[kind]) validateContract((recordContractNames[kind] ?? kind) as ContractName, record);
    }
    return this.transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM records WHERE engagement_id=? LIMIT 1").get(engagementId)) throw new ContractValidationError("conflict", "snapshot destination Engagement already contains records");
      const extant = this.#db.prepare("SELECT id,engagement_id,kind FROM object_refs").all() as Array<{ id: string; engagement_id: string; kind: string }>;
      const allOwners = new Map(extant.map((record) => [record.id, record.engagement_id]));
      const allKinds = new Map(extant.map((record) => [record.id, record.kind]));
      for (const record of candidates) { allOwners.set(record.id, engagementId); allKinds.set(record.id, String(record.kind ?? "record")); }
      const statuses = new Map<string, string>(extant.map((row) => [row.id, String(this.get(row.id)?.status ?? "active")]));
      for (const record of candidates) statuses.set(record.id, String(record.status ?? "active"));
      for (const record of candidates) validateAuthorityReferences(record, { engagement: allOwners, kind: allKinds, status: statuses }, engagementId);
      let maxAlias = 0;
      for (const record of candidates) maxAlias = Math.max(maxAlias, Number(String(record.display_id).slice(4)));
      this.#db.prepare("UPDATE metadata SET value=? WHERE key='display_sequence'").run(String(maxAlias + 1));
      const importOrder = [...candidates].sort((a, b) => Number(a.kind !== "engagement") - Number(b.kind !== "engagement"));
      for (const record of importOrder) this.commit(record, (record.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, 0, String(record.display_id), true);
      const event = this.nextEvent("snapshot.import", { engagement_id: engagementId, source_sequence: payload.read_seq, imported_count: candidates.length, snapshot_hash: suppliedHash });
      return { engagement_id: engagementId, recovered_sequence: event.commit_seq, imported_records: candidates.length, integrity_verified: true as const, display_sequence: maxAlias + 1 };
    });
  }

  importSnapshotJsonl(source: string): ReturnType<AuthorityStore["importSnapshot"]> { return this.importSnapshot(source); }

  unsupported(operation: "snapshot.import" | "migration" | "backup.restore" | "remote.push"): never {
    throw new ContractValidationError("unsupported_capability", `unsupported capability: ${operation}`);
  }

  createResourceRevision(input: ResourceRevisionInput): { resource: CanonicalRecord; revision: CanonicalRecord } {
    if (!/^sha256:[a-f0-9]{64}$/i.test(input.content_hash)) throw new ContractValidationError("validation_error", "resource revision requires a sha256 content hash");
    if (input.valid_from && input.valid_until && Date.parse(input.valid_from) > Date.parse(input.valid_until)) throw new ContractValidationError("validation_error", "valid_from must not be after valid_until");
    return this.transaction(() => {
      let resource = input.resource_id ? this.get(input.resource_id) : undefined;
      if (resource && (resource.engagement_id !== input.engagement_id || resource.kind !== "resource")) throw new ContractValidationError("validation_error", "resource identity is unavailable in this Engagement");
      const identity = input.identity ?? (resource?.identity as Record<string, unknown> | undefined);
      if (!resource) {
        if (!input.asset_type || !identity || Object.values(identity).every((value) => value === undefined)) throw new ContractValidationError("validation_error", "new Resource requires asset_type and stable logical identity separate from its variant");
        const id = input.resource_id ?? uuidv7();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new ContractValidationError("validation_error", "Resource identity must be UUIDv7");
        const resourceBody = { id, schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), engagement_id: input.engagement_id, kind: "resource", asset_type: input.asset_type, identity, revision: 1, provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "host" } } as CanonicalRecord;
        validateContract("resource", resourceBody);
        resource = this.commit(resourceBody, "L1");
      }
      const prior = this.#db.prepare("SELECT COUNT(*) AS count FROM records WHERE engagement_id=? AND kind='resource_revision' AND json_extract(body,'$.resource_ref')=?").get(input.engagement_id, resource.id) as { count: number };
      const revisionNumber = Number(prior.count) + 1;
      const sourceRefs = input.source_observation_refs ?? [];
      if (!sourceRefs.length) throw new ContractValidationError("validation_error", "ResourceRevision requires at least one source observation");
      const variant = Object.fromEntries(Object.entries({ method: input.method, path_template: input.path, parameters: input.parameter ? [input.parameter] : undefined, content_type: input.content_type, principal_ref: input.principal_ref, tenant_ref: input.tenant_ref }).filter(([, value]) => value !== undefined));
      const revisionBody = {
        id: uuidv7(), schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), engagement_id: input.engagement_id,
        provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "import", source_refs: sourceRefs },
        kind: "resource_revision", resource_ref: resource.id,
        revision: revisionNumber, logical_identity: identity, variant: input.variant ?? variant,
        content_hash: input.content_hash, source_observation_refs: sourceRefs, valid_from: input.valid_from ?? new Date().toISOString(), valid_until: input.valid_until,
        supersedes: prior.count ? this.#db.prepare("SELECT id FROM records WHERE engagement_id=? AND kind='resource_revision' AND json_extract(body,'$.resource_ref')=? ORDER BY version DESC,created_at DESC LIMIT 1").get(input.engagement_id, resource.id)?.id : undefined,
      } as CanonicalRecord;
      validateContract("resourceRevision", revisionBody);
      const revision = this.commit(revisionBody, "L1", undefined, undefined, true, 0);
      const currentResource = this.get(resource.id)!;
      resource = this.commit({ ...currentResource, revision: revisionNumber, content_hash: input.content_hash }, (currentResource.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, Number(currentResource.version));
      this.impact(revision.id, { engagement_id: input.engagement_id, limit: 100 });
      return { resource, revision };
    });
  }

  reviseProtectiveControl(input: { engagement_id: string; control_ref: string; layer: "edge" | "network" | "origin" | "unknown"; protected_resource_revision_refs: string[]; identity_conditions: string[]; network_conditions: string[]; source_observation_refs: string[]; policy_snapshot_hash?: string | null; principal?: string }): { revision: CanonicalRecord; applicability_event: CanonicalRecord } {
    if (!input.source_observation_refs.length || !input.protected_resource_revision_refs.length) throw new ContractValidationError("validation_error", "control revision requires source observations and protected resource revisions");
    return this.transaction(() => {
      const control = this.get(input.control_ref);
      if (!control || control.kind !== "protective_control" || control.engagement_id !== input.engagement_id) throw new ContractValidationError("validation_error", "ProtectiveControl is unavailable in this Engagement");
      const priorRows = this.#db.prepare("SELECT body FROM records WHERE engagement_id=? AND kind='protective_control_revision' AND json_extract(body,'$.control_ref')=? ORDER BY version DESC").all(input.engagement_id, input.control_ref) as Array<{ body: string }>;
      const prior = priorRows[0] ? JSON.parse(priorRows[0].body) as CanonicalRecord : undefined;
      const revisionBody = { id: uuidv7(), schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), engagement_id: input.engagement_id, provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "host", source_refs: input.source_observation_refs }, kind: "protective_control_revision", control_ref: input.control_ref, revision: priorRows.length + 1, layer: input.layer, policy_snapshot_hash: input.policy_snapshot_hash ?? null, protected_resource_revision_refs: input.protected_resource_revision_refs, identity_conditions: input.identity_conditions, network_conditions: input.network_conditions, valid_from: new Date().toISOString(), source_observation_refs: input.source_observation_refs, supersedes: prior?.id ?? null } as CanonicalRecord;
      validateContract("protectiveControlRevision", revisionBody);
      const revision = this.commit(revisionBody, "L1", undefined, undefined, true, 0);
      const applicability = this.commit({ id: uuidv7(), schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), engagement_id: input.engagement_id, provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "host", source_refs: input.source_observation_refs }, kind: "control_applicability_event", subject_refs: [input.control_ref], changed_dependency_ref: revision.id, previous_policy_hash: prior?.policy_snapshot_hash ?? null, current_policy_hash: input.policy_snapshot_hash ?? null, affected_current_view_refs: [], disposition: "requires_revalidation", reason_code: "control_changed", committed_at: new Date().toISOString() } as CanonicalRecord, "L1", undefined, undefined, true, 0);
      this.impact(revision.id, { engagement_id: input.engagement_id, limit: 100 });
      return { revision, applicability_event: applicability };
    });
  }

  addRelation(input: Omit<CanonicalRecord, "id" | "schema_version" | "created_at" | "provenance"> & { id?: string; source_observation_refs?: string[]; valid_from?: string; valid_until?: string; criticality?: string }): CanonicalRecord {
    const body = input as Record<string, unknown>;
    if (typeof body.from_ref !== "string" || typeof body.to_ref !== "string" || typeof body.predicate !== "string") throw new ContractValidationError("validation_error", "typed Relation requires from_ref, predicate and to_ref");
    if (body.from_ref === body.to_ref && body.predicate !== "depends_on") throw new ContractValidationError("validation_error", "self relation is not allowed");
    const from = this.get(String(body.from_ref)); const to = this.get(String(body.to_ref));
    if (!from || !to || from.engagement_id !== input.engagement_id || to.engagement_id !== input.engagement_id) throw new ContractValidationError("validation_error", "relation endpoints must belong to the same Engagement");
    const sourceRefs = Array.isArray(body.source_observation_refs) ? body.source_observation_refs : [];
    if (!sourceRefs.length) throw new ContractValidationError("validation_error", "typed Relation requires source observation references");
    const relation = { ...body, id: input.id ?? uuidv7(), kind: "relation", version: 1, engagement_id: input.engagement_id, from_type: body.from_type ?? from.kind, to_type: body.to_type ?? to.kind, source_observation_refs: sourceRefs, valid_from: body.valid_from ?? new Date().toISOString(), criticality: body.criticality ?? "medium", provenance: (body.provenance as Record<string, unknown>) ?? { host_id: "taric-core", producer_id: "taric-core", source_kind: "import", source_refs: sourceRefs } } as CanonicalRecord;
    validateContract("relation", { schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), ...relation });
    return this.commit(relation, "L1");
  }

  applyPatchSet(input: PatchSetInput): PatchSetResult {
    if (!Number.isSafeInteger(input.base_generation) || input.base_generation < 0 || !Array.isArray(input.read_set) || !Array.isArray(input.write_set) || !Array.isArray(input.operations) || input.operations.length === 0) throw new ContractValidationError("validation_error", "PatchSet requires base generation, read_set, write_set and operations");
    if (!input.source_observation_refs?.length) throw new ContractValidationError("validation_error", "PatchSet requires source observation references");
    return this.transaction(() => {
      const readEntries = input.read_set!.map((entry) => typeof entry === "string" ? { entity_ref: entry, version: Number(input.base_versions?.[entry] ?? 0) } : entry);
      const writeEntries = input.write_set!.map((entry) => typeof entry === "string" ? { entity_ref: entry, base_version: Number(input.base_versions?.[entry] ?? 0) } : entry);
      const baseVersions = input.base_versions ?? Object.fromEntries(readEntries.map((entry) => [entry.entity_ref, entry.version]));
      const writeIds = writeEntries.map((entry) => entry.entity_ref);
      const currentSeq = this.snapshot(input.engagement_id, { includeCandidates: true }).committed_seq;
      if (input.base_generation > currentSeq) throw new ContractValidationError("stale_version", "PatchSet base generation is ahead of authority");
      const runScoped = input.work_run_id !== undefined || input.attempt_ref !== undefined || input.generation !== undefined;
      if (runScoped) {
        if (!input.work_run_id || !input.attempt_ref || !Number.isSafeInteger(input.generation)) throw new ContractValidationError("validation_error", "run-scoped PatchSet requires WorkRun, Attempt and generation attribution");
        const run = this.#db.prepare("SELECT engagement_id,generation,lease_expires_at,status,body FROM work_runs WHERE run_id=?").get(input.work_run_id) as { engagement_id?: string; generation?: number; lease_expires_at?: string; status?: string; body?: string } | undefined;
        const runBody = run?.body ? JSON.parse(run.body) as Record<string, unknown> : undefined;
        if (!run || run.engagement_id !== input.engagement_id || run.generation !== input.generation || run.lease_expires_at! <= new Date().toISOString() || ["completed", "failed", "cancelled", "lost"].includes(String(run.status)) || runBody?.attempt_ref !== input.attempt_ref) throw new ContractValidationError("stale_version", "PatchSet belongs to a stale or inactive Attempt");
      }
      const patchId = input.id ?? uuidv7(); const changed: CanonicalRecord[] = []; const conflicts: CanonicalRecord[] = [];
      const allowedWriteIds = new Set(writeIds);
      for (const rawOperation of input.operations) {
        const op = typeof rawOperation === "string" ? { op: rawOperation === "upsert_resource" || rawOperation === "upsert_relation" ? "upsert" : rawOperation === "add_relation" ? "add_relation" : rawOperation === "remove_relation" ? "remove_relation" : "replace" } as PatchOperation : rawOperation;
        const operation = op.op ?? "replace";
        if (operation === "add_relation") {
          const relation = op.relation ?? op.record;
          if (!relation) throw new ContractValidationError("validation_error", "add_relation requires a Relation record");
          const from = String(relation.from_ref ?? ""); const to = String(relation.to_ref ?? ""); const predicate = String(relation.predicate ?? "");
          const prior = this.#db.prepare("SELECT body FROM records WHERE engagement_id=? AND kind='relation'").all(input.engagement_id) as Array<{ body: string }>;
          const matching = prior.map((row) => JSON.parse(row.body) as CanonicalRecord).find((item) => item.from_ref === from && item.to_ref === to && item.predicate === predicate && String(item.status ?? "active") === "active");
          if (matching) { changed.push(matching); continue; }
          changed.push(this.addRelation({ ...relation, engagement_id: input.engagement_id, id: typeof relation.id === "string" ? relation.id : uuidv7() } as never));
          continue;
        }
        if (operation === "remove_relation") {
          const relationId = op.entity_id ?? op.id;
          if (!relationId || !Number.isInteger(op.expected_version)) throw new ContractValidationError("validation_error", "relation removal requires an entity id and explicit expected_version CAS");
          const relation = this.get(relationId);
          if (!relation || relation.engagement_id !== input.engagement_id || relation.kind !== "relation") throw new ContractValidationError("validation_error", "relation is unavailable in this Engagement");
          if (Number(relation.version) !== op.expected_version) throw new ContractValidationError("stale_version", "relation removal CAS failed");
          changed.push(this.transitionRecall(relationId, "stale", `removed by PatchSet ${patchId}`));
          continue;
        }
        const entityId = op.entity_id ?? op.id ?? op.record?.id;
        if (!entityId) throw new ContractValidationError("validation_error", "PatchSet operation requires an entity id");
        if (input.write_set && !allowedWriteIds.has(entityId)) throw new ContractValidationError("validation_error", "PatchSet write_set does not contain the mutated entity");
        const existing = this.get(entityId); const body = op.record ?? op.patch ?? op.changes;
        if (!body || typeof body !== "object") throw new ContractValidationError("validation_error", "PatchSet operation requires record or changes");
        if (!existing) {
          if (operation !== "upsert" || body.id !== entityId || body.engagement_id !== input.engagement_id) throw new ContractValidationError("conflict", "PatchSet cannot create this object");
          changed.push(this.commit(body as CanonicalRecord, "L1", undefined, undefined, true, 0));
          continue;
        }
        if (existing.engagement_id !== input.engagement_id) throw new ContractValidationError("validation_error", "PatchSet entity is unavailable in this Engagement");
        const baseVersion = input.base_versions?.[entityId] ?? op.expected_version;
        if (!Number.isInteger(baseVersion) || Number(baseVersion) > Number(existing.version)) throw new ContractValidationError("stale_version", "PatchSet requires the base version of each entity");
        const versionNumber = Number(baseVersion);
        const historical = this.#db.prepare("SELECT body FROM record_versions WHERE id=? AND json_extract(body,'$.version')=? ORDER BY commit_seq DESC LIMIT 1").get(entityId, versionNumber) as { body?: string } | undefined;
        const base = historical ? JSON.parse(historical.body!) as CanonicalRecord : op.base;
        if (!base) throw new ContractValidationError("conflict", "three-way merge requires base field values for a stale object");
        if (base.id !== entityId || base.engagement_id !== input.engagement_id || Number(base.version) !== Number(baseVersion)) throw new ContractValidationError("validation_error", "PatchSet base record does not match its declared identity/version");
        const changes = (operation === "replace" && op.patch === undefined && op.changes === undefined ? body : (op.patch ?? op.changes ?? body)) as Record<string, unknown>;
        const forbidden = new Set(["id", "engagement_id", "kind", "version", "trust_level", "display_id", "commit_seq", "schema_version"]);
        if (Object.keys(changes).some((field) => forbidden.has(field))) throw new ContractValidationError("validation_error", "PatchSet cannot write Core-managed identity fields");
        const merged: Record<string, unknown> = { ...existing }; const fieldConflicts: Record<string, unknown> = {};
        const casFields = new Set(["status", "scope_ref", "applicable_scope_ref", "asset_type", "identity", "revision", "deleted", "recall_excluded"]);
        for (const [field, candidate] of Object.entries(changes)) {
          const priorValue = existing[field]; const baseValue = base[field];
          if (json(priorValue) === json(candidate)) continue;
          if (json(priorValue) !== json(baseValue)) {
            if (!casFields.has(field) && json(candidate) === json(baseValue)) continue;
            fieldConflicts[field] = { base: baseValue, current: priorValue, candidate };
            continue;
          }
          if (casFields.has(field) && Number(baseVersion) !== Number(existing.version)) {
            fieldConflicts[field] = { base: baseValue, current: priorValue, candidate, requires_cas: true };
            continue;
          }
          merged[field] = candidate;
        }
        if (Object.keys(fieldConflicts).length) {
          const conflictId = uuidv7();
          const sourceRefs = [...new Set([...(input.source_observation_refs ?? []), entityId])];
          const candidateValues = Object.entries(fieldConflicts).flatMap(([field, value]) => {
            const details = value as Record<string, unknown>;
            return [{ value: details.current, source_refs: sourceRefs }, { value: details.candidate, source_refs: input.source_observation_refs }];
          });
          const conflictBody = { id: conflictId, schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), engagement_id: input.engagement_id, kind: "conflict", provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "import", source_refs: sourceRefs }, subject_ref: entityId, field_path: Object.keys(fieldConflicts).join(","), base_version: baseVersion, current_version: Number(existing.version), base_value: base, candidates: candidateValues, source_refs: sourceRefs, diff: changes, merge_status: "open" } as CanonicalRecord;
          validateContract("conflict", conflictBody);
          const conflict = this.commit(conflictBody, "L1", undefined, undefined, true, 0);
          conflicts.push(conflict);
        }
        if (Object.keys(merged).some((field) => json(merged[field]) !== json(existing[field]))) changed.push(this.commit(merged as CanonicalRecord, (existing.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, Number(existing.version)));
      }
      const status = conflicts.length ? "conflict" : "merged";
      const patchSourceRefs = [...new Set(input.source_observation_refs)];
      const patchOperations = input.operations.map((operation) => typeof operation === "string" ? operation : operation.op === "add_relation" ? "add_relation" : operation.op === "remove_relation" ? "remove_relation" : operation.op === "upsert" ? "upsert_resource" : "replace_property");
      const patchBody = { id: patchId, schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), engagement_id: input.engagement_id, kind: "patch_set", provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "import", source_refs: patchSourceRefs }, base_generation: input.base_generation, read_set: readEntries, write_set: writeEntries, operations: patchOperations, source_refs: patchSourceRefs, content_hash: hash(json(input.operations)), merge_status: status === "conflict" ? "conflict" : "merged" } as CanonicalRecord;
      validateContract("patchSet", patchBody);
      const patch = this.commit(patchBody, "L1", undefined, undefined, true, 0);
      this.nextEvent("patch.merge", { patch_id: patch.id, base_generation: input.base_generation, read_set: input.read_set ?? [], write_set: input.write_set ?? [], merge_status: status, merge_result_refs: changed.map((record) => record.id), conflict_refs: conflicts.map((record) => record.id) }, patch.id);
      return { patch_id: patch.id, status, generation: Number(this.snapshot(input.engagement_id, { includeCandidates: true }).committed_seq), records: changed, conflicts };
    });
  }

  impact(sourceId: string, options: { engagement_id: string; limit?: number; continuation?: string } ): ImpactResult {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ContractValidationError("validation_error", "impact limit must be between 1 and 1000");
    let state: { v: 1; engagement_id: string; source_id: string; queue: string[]; visited: string[]; event_id: string };
    if (options.continuation) {
      const [payload, signature] = options.continuation.split(".");
      const expected = createHmac("sha256", impactCursorKey).update(payload ?? "").digest("base64url");
      if (!payload || !signature || Buffer.byteLength(expected) !== Buffer.byteLength(signature) || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new ContractValidationError("validation_error", "invalid ImpactEvent continuation");
      state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof state;
      if (state.v !== 1 || state.engagement_id !== options.engagement_id || state.source_id !== sourceId) throw new ContractValidationError("validation_error", "ImpactEvent continuation binding mismatch");
    } else state = { v: 1, engagement_id: options.engagement_id, source_id: sourceId, queue: [sourceId], visited: [], event_id: uuidv7() };
    const processed: string[] = [];
    return this.transaction(() => {
      const event = this.get(state.event_id);
      if (options.continuation && (!event || event.continuation !== options.continuation)) throw new ContractValidationError("stale_version", "ImpactEvent continuation is stale or already consumed");
      if (!event) {
        const source = this.get(state.source_id)!;
        const reasonCode = String(source.kind).includes("control") ? "control_changed" : source.kind === "claim" ? "claim_withdrawn" : "resource_changed";
        const body = { id: state.event_id, schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), engagement_id: state.engagement_id, kind: "impact_event", source_ref: state.source_id, changed_dependency_ref: state.source_id, affected_refs: [], criticality: (source.criticality as string) ?? "high", disposition: "requires_revalidation", reason_code: reasonCode, provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" } } as CanonicalRecord;
        validateContract("impactEvent", body);
        this.commit(body, "L1", undefined, undefined, true, 0);
      }
      while (state.queue.length && processed.length < limit) {
        const premise = state.queue.shift()!;
        if (state.visited.includes(premise)) continue;
        const initialPremiseRecord = this.get(premise);
        if (!initialPremiseRecord || initialPremiseRecord.engagement_id !== state.engagement_id) throw new ContractValidationError("validation_error", "impact source is unavailable in this Engagement");
        state.visited.push(premise); processed.push(premise);
        const rows = this.#db.prepare("SELECT id,body FROM records WHERE engagement_id=?").all(state.engagement_id) as Array<{ id: string; body: string }>;
        const premiseRecord = this.get(premise)!;
        const premiseAliases = new Set([premise, ...["resource_ref", "control_ref"].map((field) => premiseRecord[field]).filter((value): value is string => typeof value === "string")]);
        for (const row of rows) {
          const candidate = JSON.parse(row.body) as CanonicalRecord;
          const dependsByField = Object.entries(candidate).some(([field, value]) => ["depends_on", "derived_from", "source_refs", "claim_refs", "evidence_refs", "observation_refs", "resource_ref", "resource_revision_ref", "control_ref", "control_observation_ref", "checkpoint_ref", "finding_refs", "hypothesis_refs", "attack_path_refs"].includes(field) && ([...premiseAliases].includes(value as string) || Array.isArray(value) && value.some((item) => premiseAliases.has(String(item)))));
          const relationRows = this.#db.prepare("SELECT body FROM records WHERE engagement_id=? AND kind='relation'").all(state.engagement_id) as Array<{ body: string }>;
          const relationDependent = relationRows.some((edgeRow) => { const edge = JSON.parse(edgeRow.body) as CanonicalRecord; return ["depends_on", "derived_from"].includes(String(edge.predicate)) && premiseAliases.has(String(edge.to_ref)) && edge.from_ref === candidate.id; });
          if ((dependsByField || relationDependent) && !state.visited.includes(candidate.id) && !state.queue.includes(candidate.id)) state.queue.push(candidate.id);
        }
      }
      const affected = processed.filter((id) => id !== state.source_id);
      const workItems: string[] = [];
      for (const id of affected) {
        const record = this.get(id); if (!record) continue;
        if (["claim", "test_hypothesis", "finding", "coverage_cell", "checkpoint", "context_pack", "attack_path", "action_intent"].includes(String(record.kind))) {
          let stale = record;
          if (["checkpoint", "action_intent", "coverage_cell"].includes(String(record.kind))) {
            const applicability = this.commit({ id: uuidv7(), engagement_id: state.engagement_id, kind: "control_applicability_event", subject_refs: [id], changed_dependency_ref: state.source_id, affected_current_view_refs: [id], disposition: "requires_revalidation", reason_code: "control_changed", committed_at: new Date().toISOString(), provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" } }, "L1");
            stale = { ...record, applicability_event_ref: applicability.id, applicability_status: "stale" };
          } else stale = this.markStale(id, `dependency ${state.source_id} changed; ImpactEvent ${state.event_id}`);
          if (["claim", "test_hypothesis", "finding", "attack_path", "action_intent"].includes(String(stale.kind))) {
            const work = this.commit({ id: uuidv7(), engagement_id: state.engagement_id, kind: "work_item", title: `Revalidate ${String(stale.display_id ?? stale.id)}`, status: "queued", acceptance_criteria: [`Revalidate dependency ${state.source_id}`, "Record updated evidence and applicability"], related_entity_ref: id, impact_event_ref: state.event_id, risk_class: "informational", provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" } }, "L1");
            workItems.push(work.id);
          }
        }
      }
      const done = state.queue.length === 0;
      const continuation = done ? undefined : (() => { const payload = Buffer.from(json(state)).toString("base64url"); const signature = createHmac("sha256", impactCursorKey).update(payload).digest("base64url"); return `${payload}.${signature}`; })();
      const eventRecord = this.get(state.event_id)!;
      const impactBody = { ...eventRecord, affected_refs: [...new Set([...(eventRecord.affected_refs as string[] ?? []), ...affected])], continuation, pending_watermark: done ? undefined : this.snapshot(state.engagement_id, { includeCandidates: true }).committed_seq } as CanonicalRecord;
      validateContract("impactEvent", impactBody);
      const updated = this.commit(impactBody, "L1", undefined, undefined, true, Number(eventRecord.version), undefined, true);
      return { event_id: updated.id, affected_ids: affected, revalidation_work_item_ids: workItems, continuation, pending_watermark: this.snapshot(state.engagement_id, { includeCandidates: true }).committed_seq };
    });
  }

  markDependentsStale(sourceId: string, engagementId: string, limit = 100): ImpactResult { return this.impact(sourceId, { engagement_id: engagementId, limit }); }

  submitProposal(proposal: Omit<Proposal, "id" | "content_hash" | "status"> & Partial<Pick<Proposal, "id" | "status">>, options: GovernanceWriteOptions = {}): Proposal {
    if (proposal.status && proposal.status !== "pending") throw new ContractValidationError("validation_error", "proposal status is assigned by Core");
    if (proposal.content.trust_level !== undefined || proposal.content.display_id !== undefined || proposal.content.admission_status !== undefined || proposal.content.policy_result !== undefined) throw new ContractValidationError("validation_error", "proposal contains privileged fields");
    if (typeof proposal.content?.id !== "string" || typeof proposal.engagement_id !== "string" || proposal.content.engagement_id !== proposal.engagement_id) throw new ContractValidationError("validation_error", "proposal content must belong to the proposal engagement");
    return this.transaction(() => {
      if (!proposal.subject_type || !Number.isInteger(proposal.base_version) || proposal.base_version < 0) throw new ContractValidationError("validation_error", "proposal subject_type and non-negative base_version are required");
      const id = proposal.id ?? uuidv7();
      const inputProvenance = proposal.content.provenance as Record<string, unknown> | undefined;
      const content = {
        created_at: typeof proposal.content.created_at === "string" ? proposal.content.created_at : new Date().toISOString(),
        provenance: { host_id: String(inputProvenance?.host_id ?? options.principal ?? "taric-core"), producer_id: String(inputProvenance?.producer_id ?? options.principal ?? "taric-core"), source_kind: String(inputProvenance?.source_kind ?? "host"), ...inputProvenance },
        ...proposal.content,
      } as CanonicalRecord;
      const content_hash = hash(json(stablePayload(content)));
      const result: Proposal = { id, engagement_id: proposal.engagement_id, subject_type: proposal.subject_type, base_version: proposal.base_version, content, content_hash, status: "pending" };
      const requestHash = hash(json(stablePayload({ engagement_id: proposal.engagement_id, subject_type: proposal.subject_type, base_version: proposal.base_version, content })));
      if (options.idempotencyKey) {
        const prior = this.#db.prepare("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?").get(options.idempotencyKey) as any;
        if (prior) {
          if (prior.request_hash !== requestHash || prior.operation !== (options.operation ?? "proposal.submit") || prior.principal !== (options.principal ?? "core") || prior.engagement_id !== proposal.engagement_id) throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
          return JSON.parse(prior.result) as Proposal;
        }
      }
      const runId = options.workRunId ?? (typeof content.work_run_ref === "string" ? content.work_run_ref : undefined);
      const generation = options.generation ?? (typeof content.generation === "number" ? content.generation : undefined);
      const hasRunAttribution = runId !== undefined || generation !== undefined || content.attempt_ref !== undefined;
      let staleAttemptReason: string | undefined;
      if (hasRunAttribution) {
        if (!runId || !Number.isInteger(generation) || typeof proposal.content.attempt_ref !== "string") {
          staleAttemptReason = "run-scoped proposal requires WorkRun, Attempt, and generation attribution";
        } else {
          const run = this.#db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
          const runBody = run ? JSON.parse(run.body) as Record<string, unknown> : undefined;
          const actorMatches = options.principalRole === "host"
            ? run?.owner_host === options.principal
            : options.principalRole === "model"
              ? run?.owner_agent === options.principal
              : !options.principalRole && (run?.owner_host === options.principal || run?.owner_agent === options.principal);
          if (!run || run.engagement_id !== proposal.engagement_id || Number(run.generation) !== generation || run.lease_expires_at <= new Date().toISOString() || ["completed", "failed", "cancelled", "lost"].includes(String(run.status)) || runBody?.attempt_ref !== content.attempt_ref || !actorMatches) {
            staleAttemptReason = "proposal is not bound to the active WorkRun Attempt and owner";
          }
        }
      }
      const now = new Date().toISOString();
      if (staleAttemptReason) {
        const quarantined: Proposal = { ...result, status: "rejected" };
        this.#db.prepare("INSERT INTO proposals(id,engagement_id,subject_type,base_version,status,content_hash,body,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, proposal.engagement_id, proposal.subject_type, proposal.base_version, quarantined.status, content_hash, json(content), now);
        this.nextEvent("proposal.stale_attempt_quarantine", { input_hash: content_hash, work_run_id: runId, attempt_ref: content.attempt_ref, generation, actor_id: options.principal, reason: staleAttemptReason }, id);
        if (options.idempotencyKey) this.#db.prepare("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(options.idempotencyKey, options.operation ?? "proposal.submit", options.principal ?? "core", proposal.engagement_id, requestHash, json(quarantined));
        return quarantined;
      }
      this.#db.prepare("INSERT INTO proposals(id,engagement_id,subject_type,base_version,status,content_hash,body,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, proposal.engagement_id, proposal.subject_type, proposal.base_version, result.status, content_hash, json(content), now);
      this.nextEvent("proposal.submit", { input_hash: content_hash, subject_type: proposal.subject_type, actor_id: options.principal ?? "core", idempotency_key: options.idempotencyKey }, id);
      if (options.idempotencyKey) this.#db.prepare("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(options.idempotencyKey, options.operation ?? "proposal.submit", options.principal ?? "core", proposal.engagement_id, requestHash, json(result));
      return result;
    });
  }
  proposals(engagementId: string): Proposal[] { return (this.#db.prepare("SELECT * FROM proposals WHERE engagement_id=? ORDER BY created_at").all(engagementId) as any[]).map((row) => ({ id: row.id, engagement_id: row.engagement_id, subject_type: row.subject_type, base_version: row.base_version, status: row.status, content_hash: row.content_hash, content: JSON.parse(row.body) })); }
  admitProposal(id: string, policyDigest: string, options: { expectedBaseVersion?: number; validate?: (content: CanonicalRecord) => string | undefined } & GovernanceWriteOptions = {}): AdmissionResult {
    return this.transaction(() => {
    const row = this.#db.prepare("SELECT * FROM proposals WHERE id=?").get(id) as any;
    if (!row) throw new Error(`proposal not found: ${id}`);
    const proposal: Proposal = { id: row.id, engagement_id: row.engagement_id, subject_type: row.subject_type, base_version: row.base_version, status: row.status, content_hash: row.content_hash, content: JSON.parse(row.body) };
    const requestHash = hash(json(stablePayload({ proposal_id: id, policy_digest: policyDigest, expected_base_version: options.expectedBaseVersion })));
    if (options.idempotencyKey) {
      const prior = this.#db.prepare("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?").get(options.idempotencyKey) as any;
      if (prior) {
        if (prior.request_hash !== requestHash || prior.operation !== (options.operation ?? "admission.evaluate") || prior.principal !== (options.principal ?? "core") || prior.engagement_id !== proposal.engagement_id) throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
        return JSON.parse(prior.result) as AdmissionResult;
      }
    }
    const finalize = (result: AdmissionResult): AdmissionResult => {
      if (options.idempotencyKey) this.#db.prepare("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(options.idempotencyKey, options.operation ?? "admission.evaluate", options.principal ?? "core", proposal.engagement_id, requestHash, json(result));
      return result;
    };
    if (row.status !== "pending") return finalize(this.rejectProposal(proposal, "proposal is not pending"));
    if (!policyDigest) return finalize(this.rejectProposal(proposal, "policy digest is required"));
    const current = this.#db.prepare("SELECT version FROM records WHERE id=?").get(proposal.content.id) as { version?: number } | undefined;
    const currentVersion = current?.version ?? 0;
    if (options.expectedBaseVersion !== undefined && options.expectedBaseVersion !== currentVersion) return finalize(this.rejectProposal(proposal, "base version mismatch"));
    if (proposal.base_version !== currentVersion) return finalize(this.rejectProposal(proposal, "proposal base version is stale"));
    const candidate = { ...proposal.content, provenance: { host_id: String((proposal.content.provenance as Record<string, unknown> | undefined)?.host_id ?? "taric-core"), ...(proposal.content.provenance as Record<string, unknown> ?? {}), producer_id: String((proposal.content.provenance as Record<string, unknown> | undefined)?.producer_id ?? "taric-core"), source_kind: String((proposal.content.provenance as Record<string, unknown> | undefined)?.source_kind ?? "host") } };
    try {
      validateCanonicalRecord(candidate, "L1");
      const refs = this.#db.prepare("SELECT id,engagement_id,kind FROM object_refs").all() as Array<{id:string;engagement_id:string;kind:string}>;
      const statuses = this.#db.prepare("SELECT id,body FROM records").all() as Array<{id:string;body:string}>;
      validateAuthorityReferences(candidate, { engagement: new Map(refs.map((item) => [item.id, item.engagement_id])), kind: new Map(refs.map((item) => [item.id, item.kind])), status: new Map(statuses.map((item) => [item.id, String((JSON.parse(item.body) as CanonicalRecord).status ?? "active")])) }, proposal.engagement_id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "deterministic admission check failed";
      return finalize(this.rejectProposal(proposal, reason));
    }
    const reason = options.validate?.(candidate);
    if (reason) return finalize(this.rejectProposal(proposal, reason));
    const record = this.commit({ ...proposal.content, policy_digest: policyDigest, provenance: { ...(candidate.provenance as Record<string, unknown>), producer_id: options.principal ?? "taric-core", source_kind: "host" } }, "L1", undefined, undefined, false, currentVersion);
    this.#db.prepare("UPDATE proposals SET status='admitted' WHERE id=?").run(id);
    this.nextEvent("proposal.admit", { input_hash: proposal.content_hash, policy_digest: policyDigest, actor_id: options.principal ?? "core", idempotency_key: options.idempotencyKey }, id);
    return finalize({ ok: true, proposal: { ...proposal, status: "admitted" }, record });
    });
  }
  private rejectProposal(proposal: Proposal, reason: string): AdmissionResult {
    this.#db.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(proposal.id);
    this.nextEvent("proposal.reject", { input_hash: proposal.content_hash, reason, actor_id: "core" }, proposal.id);
    return { ok: false, reason, proposal: { ...proposal, status: "rejected" } };
  }

  claimWorkRun(input: { run_id?: string; work_item_id: string; engagement_id: string; host_id: string; agent_id: string; ttl_ms?: number; task_session_ref?: string }): Record<string, unknown> {
    if (input.ttl_ms !== undefined && (!Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1)) throw new ContractValidationError("validation_error", "lease ttl must be a positive integer");
    const runId = input.run_id ?? uuidv7(); const now = new Date(); const expiry = new Date(now.getTime() + (input.ttl_ms ?? 60_000)).toISOString();
    return this.transaction(() => {
      const prior = this.#db.prepare("SELECT generation,status,lease_expires_at,engagement_id,work_item_id,body FROM work_runs WHERE run_id=?").get(runId) as any;
      if (prior && prior.engagement_id !== input.engagement_id) throw new ContractValidationError("authorization_error", "work run belongs to another engagement");
      if (prior && prior.work_item_id !== input.work_item_id) throw new ContractValidationError("conflict", "work item cannot change for an existing run");
      const workItemRow = this.#db.prepare("SELECT engagement_id,version,body FROM records WHERE id=? AND kind='work_item'").get(input.work_item_id) as { engagement_id?: string; version?: number; body?: string } | undefined;
      if (!workItemRow || workItemRow.engagement_id !== input.engagement_id) throw new ContractValidationError("validation_error", "work_item_id must reference a WorkItem in the engagement");
      const item = JSON.parse(workItemRow.body!) as Record<string, unknown>;
      if (["completed", "failed", "cancelled", "lost", "stale", "retracted", "superseded", "archived", "expired"].includes(String(item.status))) throw new ContractValidationError("conflict", "terminal or recalled WorkItem cannot be claimed");
      const active = this.#db.prepare("SELECT run_id FROM work_runs WHERE work_item_id=? AND run_id<>? AND lease_expires_at>? AND status NOT IN ('completed','failed','cancelled','lost') LIMIT 1").get(input.work_item_id, runId, now.toISOString()) as { run_id?: string } | undefined;
      if (active) throw new ContractValidationError("conflict", "WorkItem already has an active leased WorkRun");
      if (prior?.lease_expires_at && prior.lease_expires_at <= now.toISOString()) {
        this.#db.prepare("UPDATE attempts SET status='lost',updated_at=? WHERE run_id=? AND generation=? AND status NOT IN ('completed','failed','cancelled','lost')").run(now.toISOString(), runId, Number(prior.generation));
        const oldAttempt = this.#db.prepare("SELECT attempt_id,body FROM attempts WHERE run_id=? AND generation=?").get(runId, Number(prior.generation)) as {attempt_id?:string;body?:string}|undefined;
        if (oldAttempt?.body) {
          const body = JSON.parse(oldAttempt.body) as Record<string, unknown>;
          body.status = "lost";
          body.ended_at = now.toISOString();
          this.#db.prepare("UPDATE attempts SET body=? WHERE attempt_id=?").run(json(body), oldAttempt.attempt_id ?? "");
        }
        this.sealExecutionSidecars(runId, Number(prior.generation), "attempt_lost");
      }
      if (prior && ["completed", "failed", "cancelled"].includes(String(prior.status))) throw new ContractValidationError("conflict", "terminal work run cannot be reclaimed");
      if (prior && prior.lease_expires_at > now.toISOString() && !["lost", "completed", "failed", "cancelled"].includes(String(prior.status))) throw new ContractValidationError("conflict", "work run lease is still active");
      const generation = Number(prior?.generation ?? 0) + 1;
      const previousAttempt = prior ? this.#db.prepare("SELECT attempt_id FROM attempts WHERE run_id=? AND generation=?").get(runId, Number(prior.generation)) as { attempt_id?: string } | undefined : undefined;
      const previousAttemptRef = previousAttempt?.attempt_id;
      const owner = { host_id: input.host_id, agent_id: input.agent_id };
      const priorBody = prior?.body ? JSON.parse(prior.body) as Record<string, unknown> : {};
      const taskSessionRef = input.task_session_ref ?? (typeof priorBody.task_session_ref === "string" ? priorBody.task_session_ref : undefined);
      if (taskSessionRef && !this.#db.prepare("SELECT 1 FROM artifact_sessions WHERE engagement_id=? AND session_id=?").get(input.engagement_id, taskSessionRef)) throw new ContractValidationError("authorization_error", "WorkRun task session is not registered in this Engagement");
      const body: Record<string, unknown> = { run_id: runId, work_item_id: input.work_item_id, engagement_id: input.engagement_id, status: "claimed", owner, generation, lease_expires_at: expiry, heartbeat_at: now.toISOString(), read_seq: Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as any).seq), work_item_version: Number(workItemRow.version), target_version: Number(item.target_version ?? workItemRow.version) };
      if (taskSessionRef) body.task_session_ref = taskSessionRef;
      const engagementBody = this.#db.prepare("SELECT body FROM records WHERE id=? AND kind='engagement'").get(input.engagement_id) as { body?: string } | undefined;
      const engagement = engagementBody?.body ? JSON.parse(engagementBody.body) as Record<string, unknown> : {};
      const scopeRef = typeof item.scope_ref === "string" ? item.scope_ref : typeof engagement.scope_ref === "string" ? engagement.scope_ref : undefined;
      const scopeVersion = scopeRef ? Number((this.#db.prepare("SELECT version FROM records WHERE id=? AND kind='scope' AND engagement_id=?").get(scopeRef, input.engagement_id) as { version?: number } | undefined)?.version ?? -1) : 0;
      if (scopeVersion < 0) throw new ContractValidationError("validation_error", "WorkItem scope must reference a Scope in the engagement");
      body.scope_ref = scopeRef;
      body.scope_version = scopeVersion;
      const attemptId = uuidv7();
      const attempt = { attempt_id: attemptId, run_id: runId, work_item_id: input.work_item_id, engagement_id: input.engagement_id, status: "claimed", generation, owner, lease_expires_at: expiry, heartbeat_at: now.toISOString(), ...(taskSessionRef ? { task_session_ref: taskSessionRef } : {}) };
      const provenance = { host_id: input.host_id, producer_id: input.agent_id, source_kind: "host" };
      const recordBase = { schema_version: SCHEMA_VERSION, engagement_id: input.engagement_id, created_at: now.toISOString(), provenance };
      validateContract("workRun", { ...recordBase, id: runId, kind: "work_run", work_item_ref: input.work_item_id, status: "claimed", generation, attempt_ref: attemptId, owner: body.owner, lease_expires_at: expiry, heartbeat_at: now.toISOString(), read_seq: body.read_seq });
      validateContract("attempt", { ...recordBase, id: attemptId, kind: "attempt", work_item_ref: input.work_item_id, work_run_ref: runId, status: "claimed", generation, owner: body.owner, lease_expires_at: expiry, heartbeat_at: now.toISOString(), started_at: now.toISOString() });
      this.#db.prepare("INSERT INTO work_runs(run_id,work_item_id,engagement_id,status,owner_host,owner_agent,generation,lease_expires_at,heartbeat_at,read_seq,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,owner_host=excluded.owner_host,owner_agent=excluded.owner_agent,generation=excluded.generation,lease_expires_at=excluded.lease_expires_at,heartbeat_at=excluded.heartbeat_at,read_seq=excluded.read_seq,body=excluded.body,updated_at=excluded.updated_at").run(runId, input.work_item_id, input.engagement_id, "claimed", input.host_id, input.agent_id, generation, expiry, now.toISOString(), body.read_seq as number, json(body), now.toISOString(), now.toISOString());
      this.#db.prepare("INSERT INTO attempts(attempt_id,run_id,work_item_id,engagement_id,status,generation,owner_host,owner_agent,lease_expires_at,heartbeat_at,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(attemptId, runId, input.work_item_id, input.engagement_id, "claimed", generation, input.host_id, input.agent_id, expiry, now.toISOString(), json(attempt), now.toISOString(), now.toISOString());
      body.attempt_ref = attemptId;
      this.#db.prepare("UPDATE work_runs SET body=? WHERE run_id=?").run(json(body), runId);
      this.#db.prepare("INSERT OR REPLACE INTO object_refs(id,engagement_id,kind) VALUES(?,?,?)").run(runId, input.engagement_id, "work_run");
      this.#db.prepare("INSERT OR REPLACE INTO object_refs(id,engagement_id,kind) VALUES(?,?,?)").run(attemptId, input.engagement_id, "attempt");
      this.nextEvent("work_run.claim", { generation, host_id: input.host_id, agent_id: input.agent_id, attempt_id: attemptId, previous_attempt_ref: previousAttemptRef }, runId);
      return body;
    });
  }
  renewWorkRun(runId: string, generation: number, hostId: string, ttlMs = 60_000): Record<string, unknown> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ContractValidationError("validation_error", "lease ttl must be a positive integer");
    return this.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
      const now = new Date();
      if (!row || row.owner_host !== hostId || Number(row.generation) !== generation || !row.lease_expires_at || row.lease_expires_at <= now.toISOString() || ["completed", "failed", "cancelled", "lost"].includes(String(row.status))) throw new ContractValidationError("stale_version", "work run lease is expired or fenced");
      const expiry = new Date(now.getTime() + ttlMs).toISOString();
      const updated = this.#db.prepare("UPDATE work_runs SET lease_expires_at=?,heartbeat_at=?,updated_at=? WHERE run_id=? AND generation=? AND owner_host=? AND lease_expires_at>? AND status NOT IN ('completed','failed','cancelled','lost')").run(expiry, now.toISOString(), now.toISOString(), runId, generation, hostId, now.toISOString());
      if (Number(updated.changes) !== 1) throw new ContractValidationError("stale_version", "work run lease changed before renewal");
      const attemptRow = this.#db.prepare("SELECT attempt_id,body FROM attempts WHERE run_id=? AND generation=? AND owner_host=? AND status NOT IN ('completed','failed','cancelled','lost')").get(runId, generation, hostId) as { attempt_id?: string; body?: string } | undefined;
      if (!attemptRow?.attempt_id || !attemptRow.body) throw new ContractValidationError("stale_version", "active Attempt is unavailable for lease renewal");
      const attempt = JSON.parse(attemptRow.body) as Record<string, unknown>;
      attempt.lease_expires_at = expiry;
      attempt.heartbeat_at = now.toISOString();
      this.#db.prepare("UPDATE attempts SET lease_expires_at=?,heartbeat_at=?,body=?,updated_at=? WHERE attempt_id=? AND run_id=? AND generation=? AND owner_host=?").run(expiry, now.toISOString(), json(attempt), now.toISOString(), attemptRow.attempt_id, runId, generation, hostId);
      const body = { ...JSON.parse(row.body), lease_expires_at: expiry, heartbeat_at: now.toISOString() };
      this.#db.prepare("UPDATE work_runs SET body=? WHERE run_id=?").run(json(body), runId);
      this.nextEvent("work_run.renew", { generation, host_id: hostId, lease_expires_at: expiry }, runId);
      return body;
    });
  }
  reclaimWorkRun(runId: string, hostId: string, agentId: string, ttlMs = 60_000): Record<string, unknown> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ContractValidationError("validation_error", "lease ttl must be a positive integer");
    return this.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
      if (!row) throw new ContractValidationError("conflict", "work run not found");
      if (row.lease_expires_at > new Date().toISOString()) throw new ContractValidationError("conflict", "work run lease is still active");
      const previousGeneration = Number(row.generation);
      const reclaimed = this.claimWorkRun({ run_id: runId, work_item_id: row.work_item_id, engagement_id: row.engagement_id, host_id: hostId, agent_id: agentId, ttl_ms: ttlMs });
      this.sealExecutionSidecars(runId, previousGeneration);
      return reclaimed;
    });
  }
  commitCheckpoint(runId: string, generation: number, hostId: string, checkpoint: Record<string, unknown>): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
      if (!row || row.owner_host !== hostId || Number(row.generation) !== generation || row.lease_expires_at <= new Date().toISOString() || ["completed", "failed", "cancelled", "lost"].includes(String(row.status))) throw new ContractValidationError("stale_version", "invalid or expired work run lease");
      const checkpointId = uuidv7();
      const runBody = JSON.parse(row.body) as Record<string, unknown>;
      if (typeof runBody.attempt_ref !== "string") throw new ContractValidationError("stale_version", "active Attempt reference is missing");
      const activeAttempt = this.#db.prepare("SELECT * FROM attempts WHERE attempt_id=? AND run_id=? AND generation=?").get(runBody.attempt_ref, runId, generation) as any;
      if (!activeAttempt || activeAttempt.owner_host !== row.owner_host || activeAttempt.owner_agent !== row.owner_agent || activeAttempt.lease_expires_at !== row.lease_expires_at || !attemptTransitions[String(activeAttempt.status)]?.includes("checkpointed")) throw new ContractValidationError("stale_version", "active Attempt is missing, expired, or fenced");
      const workItemRow = this.#db.prepare("SELECT engagement_id,version,body FROM records WHERE id=? AND kind='work_item'").get(row.work_item_id) as { engagement_id?: string; version?: number; body?: string } | undefined;
      if (!workItemRow || workItemRow.engagement_id !== row.engagement_id) throw new ContractValidationError("validation_error", "active WorkItem is unavailable");
      const workItem = JSON.parse(workItemRow.body!) as Record<string, unknown>;
      if (["completed", "failed", "cancelled", "lost", "stale", "retracted", "superseded", "archived", "expired"].includes(String(workItem.status))) throw new ContractValidationError("conflict", "active WorkItem is terminal or recalled");
      const engagementRow = this.#db.prepare("SELECT body FROM records WHERE id=? AND kind='engagement'").get(row.engagement_id) as { body?: string } | undefined;
      const engagement = engagementRow?.body ? JSON.parse(engagementRow.body) as Record<string, unknown> : {};
      const expectedScope = typeof workItem.scope_ref === "string" ? workItem.scope_ref : typeof engagement.scope_ref === "string" ? engagement.scope_ref : undefined;
      const currentSeq = Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as any).seq);
      const required = ["work_item_ref", "work_run_ref", "attempt_ref", "generation", "target_version", "work_item_version", "scope_version", "owner", "lease_expires_at", "source_read_seq", "completed_steps", "next_steps", "observation_refs", "evidence_refs", "negative_results", "unresolved_work", "host_decision_refs", "external_action_state", "budget", "draft_refs", "handoff_refs", "action_refs", "tool_result_refs", "context_manifest"];
      if (required.some((field) => checkpoint[field] === undefined)) throw new ContractValidationError("validation_error", "checkpoint is missing required fields; empty outcomes must be explicit");
      const containsHiddenReasoning = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(containsHiddenReasoning);
        if (!value || typeof value !== "object") return false;
        return Object.entries(value as Record<string, unknown>).some(([key, item]) => checkpointForbiddenFields.has(key) || containsHiddenReasoning(item));
      };
      if (containsHiddenReasoning(checkpoint)) throw new ContractValidationError("validation_error", "checkpoint cannot contain hidden reasoning");
      const owner = checkpoint.owner as Record<string, unknown>;
      const contextManifest = checkpoint.context_manifest as Record<string, unknown>;
      if (checkpoint.work_item_ref !== row.work_item_id || checkpoint.work_run_ref !== runId || checkpoint.attempt_ref !== runBody.attempt_ref || Number(checkpoint.generation) !== generation) throw new ContractValidationError("conflict", "checkpoint must reference the active WorkItem, WorkRun, Attempt, and generation");
      if (Number(checkpoint.target_version) !== Number(workItem.target_version ?? workItemRow.version)) throw new ContractValidationError("stale_version", "checkpoint target version is stale");
      if (Number(checkpoint.work_item_version) !== Number(workItemRow.version)) throw new ContractValidationError("stale_version", "checkpoint WorkItem version is stale");
      if (expectedScope && checkpoint.scope_ref !== expectedScope) throw new ContractValidationError("stale_version", "checkpoint scope does not match the current WorkItem scope");
      if (!expectedScope && checkpoint.scope_ref !== undefined) throw new ContractValidationError("validation_error", "checkpoint declares a scope not present on the current WorkItem or Engagement");
      const currentScopeVersion = expectedScope ? Number((this.#db.prepare("SELECT version FROM records WHERE id=? AND kind='scope' AND engagement_id=?").get(expectedScope, row.engagement_id) as { version?: number } | undefined)?.version ?? -1) : 0;
      if (currentScopeVersion < 0 || Number(checkpoint.scope_version) !== currentScopeVersion) throw new ContractValidationError("stale_version", "checkpoint Scope version is stale");
      if (owner?.host_id !== row.owner_host || owner?.agent_id !== row.owner_agent || checkpoint.lease_expires_at !== row.lease_expires_at) throw new ContractValidationError("authorization_error", "checkpoint owner and lease must match the active host attestation");
      if (Number(checkpoint.source_read_seq) > currentSeq || Number(contextManifest.read_seq) !== Number(checkpoint.source_read_seq) || typeof contextManifest.context_snapshot_id !== "string" || typeof contextManifest.builder_version !== "string") throw new ContractValidationError("validation_error", "checkpoint requires a verifiable fixed context snapshot manifest");
      const saved: Record<string, unknown> = { ...checkpoint, checkpoint_id: checkpointId, run_id: runId, base_read_seq: row.read_seq };
      const checkpointRecord: Record<string, unknown> = {
        ...checkpoint,
        id: checkpointId,
        schema_version: SCHEMA_VERSION,
        engagement_id: row.engagement_id,
        created_at: new Date().toISOString(),
        provenance: { host_id: hostId, producer_id: String(row.owner_agent), source_kind: "host" },
        kind: "checkpoint",
      };
      validateContract("checkpoint", checkpointRecord);
      const objectRefs = this.#db.prepare("SELECT id,engagement_id,kind FROM object_refs").all() as Array<{ id: string; engagement_id: string; kind: string }>;
      const referenceIndex = {
        engagement: new Map(objectRefs.map((ref) => [ref.id, ref.engagement_id])),
        kind: new Map(objectRefs.map((ref) => [ref.id, ref.kind])),
      };
      // Use the shared cross-reference guard first, then tighten fields whose
      // generic reference contract intentionally permits more than a checkpoint.
      validateAuthorityReferences(checkpointRecord, referenceIndex, row.engagement_id);
      const exactKinds: Array<[string, string]> = [
        ["work_item_ref", "work_item"],
        ["work_run_ref", "work_run"],
        ["attempt_ref", "attempt"],
        ["scope_ref", "scope"],
      ];
      for (const [field, expectedKind] of exactKinds) {
        const ref = checkpointRecord[field];
        if (ref === undefined) continue;
        if (typeof ref !== "string" || referenceIndex.kind.get(ref) !== expectedKind) {
          throw new ContractValidationError("validation_error", `checkpoint ${field} must reference a ${expectedKind}`);
        }
      }
      for (const ref of checkpointRecord.action_refs as unknown[]) {
        if (typeof ref !== "string" || referenceIndex.kind.get(ref) !== "action_intent") {
          throw new ContractValidationError("validation_error", `checkpoint action_refs must reference action_intent records`);
        }
      }
      const currentActions = this.#db.prepare("SELECT action_id,body FROM action_intents WHERE run_id=? AND generation=?").all(runId, generation) as Array<{ action_id: string; body: string }>;
      const actions = new Map(currentActions.map((entry) => [entry.action_id, JSON.parse(entry.body) as Record<string, unknown>]));
      for (const ref of checkpoint.action_refs as string[]) if (!actions.has(ref)) throw new ContractValidationError("validation_error", `checkpoint action reference is not current: ${ref}`);
      const hostDecisionRefs = currentActions.flatMap((entry) => { const body = JSON.parse(entry.body) as Record<string, unknown>; return typeof body.host_decision_ref === "string" ? [body.host_decision_ref] : []; });
      for (const ref of checkpoint.host_decision_refs as string[]) if (!hostDecisionRefs.includes(ref)) throw new ContractValidationError("validation_error", `checkpoint host decision reference cannot be verified: ${ref}`);
      const toolResultRefs = currentActions.flatMap((entry) => { const body = JSON.parse(entry.body) as Record<string, unknown>; return typeof body.result_ref === "string" ? [body.result_ref] : []; });
      for (const ref of checkpoint.tool_result_refs as string[]) if (!toolResultRefs.includes(ref)) throw new ContractValidationError("validation_error", `checkpoint tool result reference cannot be verified: ${ref}`);
      this.#db.prepare("INSERT INTO checkpoints(checkpoint_id,run_id,generation,body,created_at) VALUES(?,?,?,?,?)").run(checkpointId, runId, generation, json(saved), new Date().toISOString());
      const body = { ...JSON.parse(row.body), checkpoint_id: checkpointId, status: "checkpointed" };
      this.#db.prepare("UPDATE work_runs SET status='checkpointed',checkpoint_id=?,body=?,updated_at=? WHERE run_id=?").run(checkpointId, json(body), new Date().toISOString(), runId);
      const attempt = JSON.parse(activeAttempt.body) as Record<string, unknown>;
      attempt.status = "checkpointed";
      this.#db.prepare("UPDATE attempts SET status='checkpointed',body=?,updated_at=? WHERE attempt_id=? AND generation=?").run(json(attempt), new Date().toISOString(), activeAttempt.attempt_id, generation);
      const taskSessionRef = typeof runBody.task_session_ref === "string" ? runBody.task_session_ref : undefined;
      this.writeExecutionSidecar({ engagement_id: row.engagement_id, session_id: taskSessionRef, work_run_id: runId, attempt_id: activeAttempt.attempt_id, generation, kind: "checkpoint", reference_id: checkpointId, metadata: { checkpoint_id: checkpointId, artifact_refs: Array.isArray(checkpoint.artifact_refs) ? checkpoint.artifact_refs : [], action_refs: Array.isArray(checkpoint.action_refs) ? checkpoint.action_refs : [], source_read_seq: checkpoint.source_read_seq, status: "checkpointed" } });
      this.nextEvent("work_run.checkpoint", { checkpoint_id: checkpointId, generation }, runId);
      return saved;
    });
  }
  reconcileAction(runId: string, generation: number, resultRef: string, status: "executed" | "failed", actionId: string, hostId: string): Record<string, unknown> {
    return this.transaction(() => {
      const run = this.#db.prepare("SELECT owner_host,generation,lease_expires_at,status FROM work_runs WHERE run_id=?").get(runId) as { owner_host?:string; generation?:number; lease_expires_at?:string; status?:string } | undefined;
      if (!run || Number(run.generation) !== generation || !run.lease_expires_at || run.lease_expires_at <= new Date().toISOString() || ["completed", "failed", "cancelled", "lost"].includes(String(run.status))) throw new ContractValidationError("stale_version", "action reconciliation is fenced by an expired or stale run");
      if (run.owner_host !== hostId) throw new ContractValidationError("authorization_error", "action reconciliation host is not the current owner");
      const action = this.#db.prepare("SELECT body FROM action_intents WHERE action_id=? AND run_id=? AND generation=? AND status='unknown'").get(actionId, runId, generation) as { body?: string } | undefined;
      if (!action) throw new ContractValidationError("conflict", "no unknown action requires reconciliation");
      const body = JSON.parse(action.body!);
      return this.recordActionIntent({ ...body, generation, run_id: runId, action_id: actionId, status, result_ref: resultRef, host_decision_ref: body.host_decision_ref, mode: body.mode, host_id: hostId }, true);
    });
  }
  consumeOutbox(limit = 100): Array<Record<string, unknown>> {
    return this.transaction(() => {
      this.assertAuthorityWritable();
      const rows = this.#db.prepare("SELECT id,commit_seq,status FROM outbox WHERE status='pending' ORDER BY id LIMIT ?").all(limit) as Array<{ id:number; commit_seq:number; status:string }>;
      for (const row of rows) {
        this.#db.prepare("UPDATE outbox SET status='applied' WHERE id=? AND status='pending'").run(row.id);
        this.#db.prepare("UPDATE operation_markers SET status=CASE WHEN status='pending' THEN 'applied' ELSE status END,updated_at=? WHERE commit_seq=?").run(new Date().toISOString(), row.commit_seq);
        this.#db.prepare("UPDATE operation_markers SET status='indexed',updated_at=? WHERE commit_seq=? AND status='applied'").run(new Date().toISOString(), row.commit_seq);
      }
      return rows.map((row) => ({ ...row, status: "applied" }));
    });
  }

  markOperationFailed(operationId: string, error: string, retryOwner = "operator"): OperationMarker {
    if (!operationId || !error) throw new ContractValidationError("validation_error", "operation failure requires an operation id and error");
    return this.transaction(() => {
      this.assertAuthorityWritable();
      const result = this.#db.prepare("UPDATE operation_markers SET status='failed',error=?,retry_owner=?,updated_at=? WHERE operation_id=?").run(error.slice(0, 1024), retryOwner, new Date().toISOString(), operationId);
      if (Number(result.changes) !== 1) throw new ContractValidationError("conflict", `operation marker not found: ${operationId}`);
      return this.operationMarkers().find((marker) => marker.operation_id === operationId)!;
    });
  }

  replayDerived(): { action: "replay"; recovered: number; applied: number; event_id: string; commit_seq: number; doctor: DoctorReport } {
    return this.transaction(() => {
      this.assertAuthorityWritable();
      const drift = this.derivedDrift();
      if (drift.errors.length > 0) throw new ContractValidationError("conflict", "derived view drift requires explicit rebuild before replay", drift.errors);
      const now = new Date().toISOString();
      const failed = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM operation_markers WHERE status='failed'").get() as { count: number }).count);
      const pending = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM operation_markers WHERE status='pending'").get() as { count: number }).count);
      this.#db.prepare("UPDATE outbox SET status='applied' WHERE status='pending'").run();
      this.#db.prepare("UPDATE operation_markers SET status=CASE WHEN status='failed' THEN 'recovered' WHEN status='pending' THEN 'applied' ELSE status END,error=NULL,retry_owner='operator',updated_at=? WHERE status IN ('failed','pending')").run(now);
      const event = this.nextEvent("operation.recovered", { actor_id: "operator", recovered_markers: failed, applied_markers: pending });
      this.#db.prepare("UPDATE outbox SET status='applied' WHERE commit_seq=?").run(event.commit_seq);
      this.#db.prepare("UPDATE operation_markers SET status='indexed',retry_owner='operator',updated_at=? WHERE commit_seq=?").run(new Date().toISOString(), event.commit_seq);
      return { action: "replay", recovered: failed, applied: pending, event_id: event.event_id, commit_seq: event.commit_seq, doctor: this.doctor() };
    });
  }

  rebuildDerived(): { action: "rebuild"; rebuilt_outbox: number; rebuilt_markers: number; event_id: string; commit_seq: number; doctor: DoctorReport } {
    return this.transaction(() => {
      this.assertAuthorityWritable();
      const events = this.#db.prepare("SELECT commit_seq,event_id,event_type,subject_id,payload,created_at FROM events ORDER BY commit_seq").all() as Array<{ commit_seq: number; event_id: string; event_type: string; subject_id: string | null; payload: string; created_at: string }>;
      let rebuiltOutbox = 0; let rebuiltMarkers = 0;
      for (const event of events) {
        const outbox = this.#db.prepare("SELECT id FROM outbox WHERE commit_seq=?").get(event.commit_seq);
        if (!outbox) { this.#db.prepare("INSERT INTO outbox(commit_seq,status) VALUES(?,?)").run(event.commit_seq, "applied"); rebuiltOutbox++; }
        const marker = this.#db.prepare("SELECT operation_id FROM operation_markers WHERE commit_seq=?").get(event.commit_seq);
        if (!marker) {
          const payload = JSON.parse(event.payload) as Record<string, unknown>;
          const owner = event.subject_id ? this.#db.prepare("SELECT engagement_id FROM object_refs WHERE id=?").get(event.subject_id) as { engagement_id?: string } | undefined : undefined;
          const engagementId = typeof payload.engagement_id === "string" ? payload.engagement_id : owner?.engagement_id;
          this.#db.prepare("INSERT INTO operation_markers(operation_id,event_id,engagement_id,commit_seq,kind,input_hash,status,updated_at) VALUES(?,?,?,?,?,?,?,?)")
            .run(`operation:${event.event_id}`, event.event_id, engagementId ?? null, event.commit_seq, event.event_type, hash(json({ event_type: event.event_type, subject_id: event.subject_id ?? undefined, payload })), "indexed", new Date().toISOString());
          rebuiltMarkers++;
        } else this.#db.prepare("UPDATE operation_markers SET status=CASE WHEN status='failed' THEN 'recovered' ELSE 'indexed' END,error=NULL,retry_owner='operator',updated_at=? WHERE commit_seq=?").run(new Date().toISOString(), event.commit_seq);
        this.#db.prepare("UPDATE outbox SET status='applied' WHERE commit_seq=?").run(event.commit_seq);
      }
      const recovery = this.nextEvent("operation.rebuilt", { actor_id: "operator", rebuilt_outbox: rebuiltOutbox, rebuilt_markers: rebuiltMarkers });
      this.#db.prepare("UPDATE outbox SET status='applied' WHERE commit_seq=?").run(recovery.commit_seq);
      this.#db.prepare("UPDATE operation_markers SET status='indexed',retry_owner='operator',updated_at=? WHERE commit_seq=?").run(new Date().toISOString(), recovery.commit_seq);
      return { action: "rebuild", rebuilt_outbox: rebuiltOutbox, rebuilt_markers: rebuiltMarkers, event_id: recovery.event_id, commit_seq: recovery.commit_seq, doctor: this.doctor() };
    });
  }

  reconcileDerived(action: "preview" | "replay" | "rebuild" | "reconcile" = "preview"): OperationRecoveryPreview | ReturnType<AuthorityStore["replayDerived"]> | ReturnType<AuthorityStore["rebuildDerived"]> {
    if (action === "preview") return this.previewRecovery();
    if (action === "replay") return this.replayDerived();
    if (action === "reconcile") {
      const drift = this.derivedDrift();
      if (drift.errors.length > 0) return this.rebuildDerived();
      return this.replayDerived();
    }
    return this.rebuildDerived();
  }
  recordHostError(input: { engagement_id: string; host_id: string; work_run_id?: string; generation?: number; error_ref?: string; message?: string }): Record<string, unknown> {
    return this.transaction(() => {
      if (input.message && input.message.length > 512) throw new ContractValidationError("validation_error", "host error message is too long");
      if (input.message && /(?:password|secret|token|bearer|credential|private key)/i.test(input.message)) throw new ContractValidationError("validation_error", "host error message contains prohibited secret material");
      const body = { engagement_id: input.engagement_id, host_id: input.host_id, work_run_id: input.work_run_id, generation: input.generation, error_ref: input.error_ref, message: input.message, recorded_at: new Date().toISOString() };
      let taskSessionRef: string | undefined; let attemptId: string | undefined;
      if (input.work_run_id) { const run = this.#db.prepare("SELECT body FROM work_runs WHERE run_id=?").get(input.work_run_id) as { body?: string } | undefined; if (run?.body) { const runBody = JSON.parse(run.body) as Record<string, unknown>; taskSessionRef = typeof runBody.task_session_ref === "string" ? runBody.task_session_ref : undefined; attemptId = typeof runBody.attempt_ref === "string" ? runBody.attempt_ref : undefined; } }
      this.writeExecutionSidecar({ engagement_id: input.engagement_id, session_id: taskSessionRef, work_run_id: input.work_run_id, attempt_id: attemptId, generation: input.generation, kind: "error", reference_id: input.error_ref ?? uuidv7(), metadata: { error_ref: input.error_ref, status: "error", artifact_refs: [] } });
      const event = this.nextEvent("host.error", body, input.work_run_id);
      return { ...body, event_id: event.event_id, commit_seq: event.commit_seq };
    });
  }
  getWorkRun(runId: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare("SELECT body FROM work_runs WHERE run_id=?").get(runId) as { body?: string } | undefined;
    return row ? JSON.parse(row.body!) : undefined;
  }
  sealExecutionSidecars(runId: string, generation: number, reason = "attempt_lost"): number {
    return this.transaction(() => {
      const rows = this.#db.prepare("SELECT execution_id,body FROM execution_catalog WHERE work_run_id=?").all(runId) as Array<{ execution_id: string; body: string }>;
      let changed = 0;
      for (const row of rows) {
        const body = JSON.parse(row.body) as Record<string, unknown>;
        if (Number(body.generation) !== generation || body.sealed === true) continue;
        body.sealed = true; body.sealed_reason = reason; body.sealed_at = new Date().toISOString();
        this.#db.prepare("UPDATE execution_catalog SET body=? WHERE execution_id=?").run(json(body), row.execution_id); changed++;
      }
      return changed;
    });
  }
  validateArtifactFence(input: { engagement_id: string; session_id: string; work_run_id: string; attempt_id: string; generation: number; principal: string }): void {
    const row = this.#db.prepare("SELECT engagement_id,status,owner_host,generation,lease_expires_at,body FROM work_runs WHERE run_id=?").get(input.work_run_id) as { engagement_id?: string; status?: string; owner_host?: string; generation?: number; lease_expires_at?: string; body?: string } | undefined;
    if (!row || row.engagement_id !== input.engagement_id) throw new ContractValidationError("authorization_error", "WorkRun is not in this Engagement");
    let body: Record<string, unknown>; try { body = JSON.parse(row.body ?? "{}"); } catch { throw new ContractValidationError("conflict", "WorkRun state is invalid"); }
    if (body.task_session_ref !== input.session_id) throw new ContractValidationError("authorization_error", "Artifact does not match the registered WorkRun session");
    if (row.owner_host !== input.principal || Number(row.generation) !== input.generation || !row.lease_expires_at || row.lease_expires_at <= new Date().toISOString() || !["claimed", "running", "checkpointed", "blocked"].includes(String(row.status))) throw new ContractValidationError("stale_version", "Artifact write is fenced by an expired or stale WorkRun");
    if (body.attempt_ref !== input.attempt_id) throw new ContractValidationError("stale_version", "Artifact Attempt is stale");
    const attempt = this.#db.prepare("SELECT engagement_id,status,generation,owner_host,lease_expires_at,body FROM attempts WHERE attempt_id=? AND run_id=?").get(input.attempt_id,input.work_run_id) as { engagement_id?: string; status?: string; generation?: number; owner_host?: string; lease_expires_at?: string; body?: string } | undefined;
    const attemptBody = attempt?.body ? JSON.parse(attempt.body) as Record<string, unknown> : {};
    if (!attempt || attempt.engagement_id !== input.engagement_id || attempt.owner_host !== input.principal || Number(attempt.generation) !== input.generation || attempt.lease_expires_at !== row.lease_expires_at || !["claimed", "running", "checkpointed", "blocked"].includes(String(attempt.status)) || attemptBody.task_session_ref !== input.session_id) throw new ContractValidationError("stale_version", "Artifact Attempt is missing, expired, or fenced");
  }
  transitionWorkRun(runId: string, generation: number, hostId: string, status: "running" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled"): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
      const now = new Date().toISOString();
      if (!row || row.owner_host !== hostId || Number(row.generation) !== generation || !row.lease_expires_at || row.lease_expires_at <= now) {
        throw new ContractValidationError("stale_version", "work run transition is fenced by an expired lease, owner, or generation");
      }
      const priorStatus = String(row.status);
      if (!workTransitions[priorStatus]?.includes(status)) throw new ContractValidationError("conflict", `illegal work run transition: ${priorStatus} -> ${status}`);
      const body = JSON.parse(row.body) as Record<string, unknown>;
      body.status = status;
      const attemptId = String(body.attempt_ref ?? "");
      const attemptRow = attemptId ? this.#db.prepare("SELECT status,body FROM attempts WHERE attempt_id=? AND run_id=? AND generation=?").get(attemptId, runId, generation) as { status?: string; body?: string } | undefined : undefined;
      if (!attemptRow || !attemptTransitions[String(attemptRow.status)]?.includes(status)) throw new ContractValidationError("conflict", "active Attempt cannot make the requested transition");
      const attempt = JSON.parse(attemptRow.body!) as Record<string, unknown>;
      attempt.status = status;
      if (["completed", "failed", "cancelled"].includes(status)) attempt.ended_at = now;
      this.#db.prepare("UPDATE attempts SET status=?,body=?,updated_at=? WHERE attempt_id=? AND run_id=? AND generation=?").run(status, json(attempt), now, attemptId, runId, generation);
      this.#db.prepare("UPDATE work_runs SET status=?,body=?,updated_at=? WHERE run_id=? AND generation=? AND owner_host=?").run(status, json(body), now, runId, generation, hostId);
      this.nextEvent("work_run.transition", { attempt_id: attemptId, generation, from: priorStatus, to: status, host_id: hostId }, runId);
      return body;
    });
  }
  recordActionIntent(input: { action_id?: string; run_id: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; target?: string; method?: string; rationale?: string; uncertainty?: string; scope?: string; constraints?: string[]; limitations?: string[]; memory_refs?: string[]; evidence_refs?: string[]; host_decision_ref?: string; status: "recommended" | "authorized" | "denied" | "executed" | "failed" | "unknown"; result_ref?: string; host_id: string; actor_role?: "host" | "model" }, reconciliation = false): Record<string, unknown> {
    const actionId = input.action_id ?? uuidv7();
    return this.transaction(() => {
      const run = this.#db.prepare("SELECT generation,status,owner_host,owner_agent,engagement_id,lease_expires_at FROM work_runs WHERE run_id=?").get(input.run_id) as { generation?: number; status?: string; owner_host?: string; owner_agent?: string; engagement_id?: string; lease_expires_at?: string } | undefined;
      if (!run || Number(run.generation) !== input.generation) throw new ContractValidationError("stale_version", "stale action intent generation");
      const actorMatches = run.owner_host === input.host_id || (input.status === "recommended" && input.actor_role === "model" && run.owner_agent === input.host_id);
      if (!actorMatches) throw new ContractValidationError("authorization_error", "action actor is not the current owner");
      if (!run.lease_expires_at || run.lease_expires_at <= new Date().toISOString()) throw new ContractValidationError("stale_version", "action intent lease is expired");
      if (["completed", "failed", "cancelled", "lost"].includes(String(run.status))) throw new ContractValidationError("conflict", "action intent is not writable for a terminal work run");
      const prior = this.#db.prepare("SELECT status,generation,run_id,body FROM action_intents WHERE action_id=?").get(actionId) as { status?: string; generation?: number; run_id?: string; body?: string } | undefined;
      const priorBody = prior?.body ? JSON.parse(prior.body) as Record<string, unknown> : {};
      const body = { ...priorBody, ...input, action_id: actionId, engagement_id: run.engagement_id, owner: { host_id: run.owner_host, agent_id: run.owner_agent }, recorded_at: priorBody.recorded_at ?? new Date().toISOString() };
      if (prior) {
        if (prior.run_id !== input.run_id || Number(prior.generation) !== input.generation) throw new ContractValidationError("conflict", "action intent belongs to another WorkRun or generation");
        if (prior.status === input.status) {
          const same = ["mode", "target", "method", "host_decision_ref", "result_ref"].every((field) => (priorBody as Record<string, unknown>)[field] === (body as Record<string, unknown>)[field]);
          if (same) return priorBody;
          throw new ContractValidationError("idempotency_conflict", "action intent retry changed its outcome payload");
        }
        if (prior.status === "unknown" && ["executed", "failed"].includes(input.status) && !reconciliation) throw new ContractValidationError("conflict", "unknown action results require explicit host reconciliation");
        if (!actionTransitions[String(prior.status)]?.includes(input.status)) throw new ContractValidationError("conflict", `illegal action intent transition: ${prior.status} -> ${input.status}`);
      } else if (input.status !== "recommended") {
        throw new ContractValidationError("conflict", "action intent must start in recommended state");
      }
      if (!prior && (!input.target?.trim() || !input.method?.trim())) throw new ContractValidationError("validation_error", "recommended action requires target and method");
      if (["authorized", "denied"].includes(input.status) && !input.host_decision_ref) throw new ContractValidationError("validation_error", "host decision reference is required for host decisions");
      if (["executed", "failed"].includes(input.status) && !input.result_ref) throw new ContractValidationError("validation_error", "resolved action requires a host result reference");
      const attempt = this.#db.prepare("SELECT * FROM attempts WHERE run_id=? AND generation=?").get(input.run_id, input.generation) as { attempt_id?: string; status?: string; owner_host?: string; owner_agent?: string; lease_expires_at?: string } | undefined;
      if (!attempt?.attempt_id || attempt.owner_host !== run.owner_host || attempt.owner_agent !== run.owner_agent || attempt.lease_expires_at !== run.lease_expires_at || ["completed", "failed", "cancelled", "lost"].includes(String(attempt.status))) throw new ContractValidationError("conflict", "ActionIntent requires the active Attempt");
      const actionRecord = {
        id: actionId,
        schema_version: SCHEMA_VERSION,
        engagement_id: run.engagement_id,
        created_at: body.recorded_at,
        provenance: { host_id: input.host_id, producer_id: String(run.owner_agent), source_kind: "host" },
        kind: "action_intent",
        target: body.target,
        method: body.method,
        rationale: body.rationale,
        scope: body.scope,
        uncertainty: body.uncertainty,
        constraints: body.constraints ?? [],
        limitations: body.limitations ?? [],
        memory_refs: body.memory_refs ?? [],
        evidence_refs: body.evidence_refs ?? [],
        status: input.status,
        mode: input.mode,
        work_run_ref: input.run_id,
        attempt_ref: attempt.attempt_id,
        generation: input.generation,
        owner: { host_id: run.owner_host, agent_id: run.owner_agent },
        host_decision_ref: input.host_decision_ref,
        result_ref: input.result_ref,
        idempotency_key: actionId,
      };
      validateContract("actionIntent", actionRecord);
      const refs = this.#db.prepare("SELECT id,engagement_id,kind FROM object_refs").all() as Array<{id:string;engagement_id:string;kind:string}>;
      validateAuthorityReferences(actionRecord, { engagement: new Map(refs.map((ref) => [ref.id, ref.engagement_id])), kind: new Map(refs.map((ref) => [ref.id, ref.kind])) }, String(run.engagement_id));
      this.#db.prepare("INSERT INTO action_intents(action_id,run_id,generation,status,body,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET status=excluded.status,body=excluded.body,updated_at=excluded.updated_at").run(actionId, input.run_id, input.generation, input.status, json(body), new Date().toISOString());
      this.#db.prepare("INSERT OR REPLACE INTO object_refs(id,engagement_id,kind) VALUES(?,?,?)").run(actionId, String(run.engagement_id), "action_intent");
      const runRow = this.#db.prepare("SELECT body FROM work_runs WHERE run_id=?").get(input.run_id) as { body?: string } | undefined;
      const runBody = runRow?.body ? JSON.parse(runRow.body) as Record<string, unknown> : {};
      this.writeExecutionSidecar({ engagement_id: String(run.engagement_id), session_id: typeof runBody.task_session_ref === "string" ? runBody.task_session_ref : undefined, work_run_id: input.run_id, attempt_id: attempt.attempt_id, generation: input.generation, kind: input.status === "recommended" || input.status === "authorized" || input.status === "denied" ? "action" : "result", reference_id: actionId, metadata: { action_id: actionId, status: input.status, mode: input.mode, host_decision_ref: input.host_decision_ref, result_ref: input.result_ref, artifact_refs: [] } });
      this.nextEvent(`action_intent.${input.status}`, { mode: input.mode, status: input.status, host_id: input.host_id, agent_id: run.owner_agent, work_run_id: input.run_id, generation: input.generation, host_decision_ref: input.host_decision_ref, result_ref: input.result_ref }, actionId);
      return body;
    });
  }
  pendingActionIntents(runId: string): Array<Record<string, unknown>> {
    return (this.#db.prepare("SELECT body FROM action_intents WHERE run_id=? AND status IN ('unknown','authorized')").all(runId) as Array<{body:string}>).map((row) => JSON.parse(row.body));
  }
  getActionIntent(actionId: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare("SELECT body FROM action_intents WHERE action_id=?").get(actionId) as { body?: string } | undefined;
    return row?.body ? JSON.parse(row.body) : undefined;
  }
  resumePacket(runId: string, hostId: string): Record<string, unknown> {
    const row = this.#db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
    if (!row) throw new ContractValidationError("conflict", "work run not found");
    if (row.owner_host !== hostId) throw new ContractValidationError("authorization_error", "host does not own work run");
    const run = JSON.parse(row.body) as Record<string, unknown>;
    const checkpoint = row.checkpoint_id ? JSON.parse((this.#db.prepare("SELECT body FROM checkpoints WHERE checkpoint_id=?").get(row.checkpoint_id) as any).body) : null;
    const currentReadSeq = Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as any).seq);
    const checkpointReadSeq = checkpoint && typeof checkpoint.source_read_seq === "number" ? checkpoint.source_read_seq : undefined;
    const workItemRow = this.#db.prepare("SELECT engagement_id,version,body FROM records WHERE id=? AND kind='work_item'").get(row.work_item_id) as { engagement_id?: string; version?: number; body?: string } | undefined;
    const workItem = workItemRow?.body ? JSON.parse(workItemRow.body) as Record<string, unknown> : undefined;
    const engagementRow = this.#db.prepare("SELECT body FROM records WHERE id=? AND kind='engagement'").get(row.engagement_id) as { body?: string } | undefined;
    const engagement = engagementRow?.body ? JSON.parse(engagementRow.body) as Record<string, unknown> : undefined;
    const currentScopeRef = typeof workItem?.scope_ref === "string" ? workItem.scope_ref : typeof engagement?.scope_ref === "string" ? engagement.scope_ref : undefined;
    const scopeRow = currentScopeRef ? this.#db.prepare("SELECT engagement_id,version,body FROM records WHERE id=? AND kind='scope'").get(currentScopeRef) as { engagement_id?: string; version?: number; body?: string } | undefined : undefined;
    const pendingActions = this.pendingActionIntents(runId);
    const artifactRows = this.#db.prepare("SELECT body FROM artifact_catalog WHERE engagement_id=? AND session_id=? ORDER BY stored_at,content_ref").all(row.engagement_id, String(run.task_session_ref ?? "")) as Array<{ body: string }>;
    const artifact_refs = artifactRows.map((item) => { const artifact = JSON.parse(item.body) as Record<string, unknown>; const { relative_dir: _dir, manifest_path: _manifest, host_ref: _hostRef, ...metadata } = artifact; return metadata; });
    const currentActions = this.#db.prepare("SELECT action_id,body FROM action_intents WHERE run_id=? AND generation=?").all(runId, Number(row.generation)) as Array<{ action_id: string; body: string }>;
    const currentActionBodies = currentActions.map((item) => JSON.parse(item.body) as Record<string, unknown>);
    const verifiedDecisions = currentActionBodies.flatMap((item) => typeof item.host_decision_ref === "string" ? [item.host_decision_ref] : []);
    const verifiedResults = currentActionBodies.flatMap((item) => typeof item.result_ref === "string" ? [item.result_ref] : []);
    const actionRefsValid = !checkpoint || ((checkpoint.action_refs as unknown[]).every((ref) => typeof ref === "string" && currentActions.some((item) => item.action_id === ref)) && (checkpoint.tool_result_refs as unknown[]).every((ref) => typeof ref === "string" && verifiedResults.includes(ref)));
    const scopeValid = currentScopeRef === (checkpoint?.scope_ref as string | undefined)
      && (!currentScopeRef || Boolean(scopeRow?.body && scopeRow.engagement_id === row.engagement_id && !this.isRecalled(JSON.parse(scopeRow.body) as CanonicalRecord)));
    const premiseChecks = {
      engagement: run.engagement_id === row.engagement_id,
      work_item: Boolean(workItem && workItemRow && workItemRow.engagement_id === row.engagement_id && !this.isRecalled(workItem as CanonicalRecord) && run.work_item_id === row.work_item_id && (!checkpoint || (checkpoint.work_item_ref === row.work_item_id && Number(checkpoint.work_item_version) === Number(workItemRow.version) && Number(checkpoint.target_version) === Number(workItem.target_version ?? workItemRow.version)))),
      scope: scopeValid && Boolean(!currentScopeRef || Number(checkpoint?.scope_version) === Number(scopeRow?.version)),
      checkpoint: Boolean(checkpoint),
      attempt: !checkpoint || (checkpoint.attempt_ref === run.attempt_ref && checkpoint.generation === row.generation),
      source_sequence: checkpointReadSeq === undefined || checkpointReadSeq <= currentReadSeq,
      lease: typeof row.lease_expires_at === "string" && row.lease_expires_at > new Date().toISOString(),
      context_manifest: !checkpoint || (checkpoint.context_manifest?.read_seq === checkpointReadSeq && typeof checkpoint.context_manifest?.context_snapshot_id === "string"),
      host_authorization_refs: !checkpoint || (checkpoint.host_decision_refs as unknown[]).every((ref) => typeof ref === "string" && verifiedDecisions.includes(ref)),
      action_results: actionRefsValid && pendingActions.length === 0,
    };
    const replanRequired = Object.values(premiseChecks).some((valid) => !valid);
    return {
      run,
      checkpoint,
      pending_actions: pendingActions,
      task_session_ref: run.task_session_ref,
      artifact_refs,
      checkpoint_read_seq: checkpointReadSeq,
      current_read_seq: currentReadSeq,
      premise_checks: premiseChecks,
      blocked: replanRequired,
      replan_required: replanRequired,
      resume_advice: replanRequired ? "replan_required" : "resume_allowed",
    };
  }
  recordLateResult(input: { run_id: string; generation: number; result_ref: string; result: Record<string, unknown> }): Record<string, unknown> {
    const forbidden = /(?:token|secret|credential|password|cookie|authorization|bearer|body|packet|hidden_reasoning|chain_of_thought)/i;
    const result = Object.fromEntries(Object.entries(input.result ?? {}).filter(([key]) => !forbidden.test(key)).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 512) : value]));
    const late = { late_result_id: uuidv7(), run_id: input.run_id, generation: input.generation, result_ref: input.result_ref, result, status: "late_result_quarantine", recorded_at: new Date().toISOString() };
    return this.transaction(() => {
      const run = this.#db.prepare("SELECT body,engagement_id FROM work_runs WHERE run_id=?").get(input.run_id) as { body?: string; engagement_id?: string } | undefined;
      const runBody = run?.body ? JSON.parse(run.body) as Record<string, unknown> : {};
      this.writeExecutionSidecar({ engagement_id: String(run?.engagement_id ?? ""), session_id: typeof runBody.task_session_ref === "string" ? runBody.task_session_ref : undefined, work_run_id: input.run_id, attempt_id: typeof runBody.attempt_ref === "string" ? runBody.attempt_ref : undefined, generation: input.generation, kind: "result", reference_id: late.late_result_id, metadata: { status: late.status, result_ref: input.result_ref, quarantine: true, artifact_refs: [] } });
      this.#db.prepare("INSERT INTO action_intents(action_id,run_id,generation,status,body,updated_at) VALUES(?,?,?,?,?,?)").run(late.late_result_id, input.run_id, input.generation, late.status, json(late), new Date().toISOString());
      this.nextEvent("action_intent.late_result_quarantine", { generation: input.generation, result_ref: input.result_ref }, late.late_result_id);
      return late;
    });
  }
  submitReview(input: { id?: string; proposal_id: string; reviewer_id: string; reviewer_kind: "deterministic" | "model" | "reviewer"; input_hash: string; verdict: "pass" | "reject" | "needs_evidence" | "defer"; policy_digest?: string; rubric_hash?: string; evidence_snapshot_hash?: string; limitations?: string[]; idempotencyKey?: string; principal?: string; reviewer_capability?: AdmissionReview["reviewer_kind"]; reviewer_model?: string; prompt_digest?: string; ruleset_digest?: string }): { id: string; accepted: boolean; reason?: string; proposal_hash?: string; evidence_snapshot_hash?: string; review_hash?: string } {
    return this.transaction(() => {
      const proposalRow = this.#db.prepare("SELECT * FROM proposals WHERE id=?").get(input.proposal_id) as any;
      if (!proposalRow) throw new ContractValidationError("conflict", "proposal not found");
      const proposal: Proposal = { id: proposalRow.id, engagement_id: proposalRow.engagement_id, subject_type: proposalRow.subject_type, base_version: proposalRow.base_version, status: proposalRow.status, content_hash: proposalRow.content_hash, content: JSON.parse(proposalRow.body) };
      const rejectedId = input.id ?? uuidv7();
      const expectedEvidenceSnapshotHash = this.evidenceSnapshotHash(proposal);
      const evidenceSnapshotHash = input.evidence_snapshot_hash ?? expectedEvidenceSnapshotHash;
      const requestHash = hash(json(stablePayload({ proposal_id: input.proposal_id, reviewer_id: input.reviewer_id, reviewer_kind: input.reviewer_kind, input_hash: input.input_hash, verdict: input.verdict, policy_digest: input.policy_digest, rubric_hash: input.rubric_hash, evidence_snapshot_hash: evidenceSnapshotHash, limitations: input.limitations, reviewer_capability: input.reviewer_capability, reviewer_model: input.reviewer_model, prompt_digest: input.prompt_digest, ruleset_digest: input.ruleset_digest })));
      if (input.idempotencyKey) {
        const prior = this.#db.prepare("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?").get(input.idempotencyKey) as any;
        if (prior) {
          if (prior.request_hash !== requestHash || prior.operation !== "review.submit" || prior.principal !== (input.principal ?? input.reviewer_id) || prior.engagement_id !== proposal.engagement_id) throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
          return JSON.parse(prior.result);
        }
      }
      const finalize = (result: { id: string; accepted: boolean; reason?: string; proposal_hash?: string; evidence_snapshot_hash?: string; review_hash?: string }) => {
        if (input.idempotencyKey) this.#db.prepare("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(input.idempotencyKey, "review.submit", input.principal ?? input.reviewer_id, proposal.engagement_id, requestHash, json(result));
        return result;
      };
      const rejectReview = (reason: string) => {
        const rejected = { id: rejectedId, accepted: false, reason, proposal_hash: proposal.content_hash, evidence_snapshot_hash: evidenceSnapshotHash };
        this.nextEvent("review.reject", { reviewer_id: input.reviewer_id, input_hash: input.input_hash, proposal_hash: proposal.content_hash, evidence_snapshot_hash: evidenceSnapshotHash, reason, policy_digest: input.policy_digest }, rejectedId);
        return finalize(rejected);
      };
      if (input.input_hash !== proposal.content_hash) {
        return rejectReview("review input hash mismatch");
      }
      const provenance = (proposal.content.provenance ?? {}) as Record<string, unknown>;
      const author = String(provenance.producer_id ?? "");
      const worker = String(provenance.worker_id ?? provenance.author_id ?? "");
      if (input.reviewer_kind === "reviewer" && [author, worker].includes(input.reviewer_id)) return rejectReview("reviewer is not independent from the proposal author or validating worker");
      if (input.reviewer_kind === "reviewer" && !input.policy_digest) return rejectReview("reviewer policy digest is required");
      const expectedEvidenceHash = this.evidenceSnapshotHash(proposal);
      if (input.evidence_snapshot_hash && input.evidence_snapshot_hash !== expectedEvidenceHash) {
        return rejectReview("review evidence snapshot mismatch");
      }
      const reviewBody = { ...input, proposal_hash: proposal.content_hash, evidence_snapshot_hash: expectedEvidenceHash, rubric_hash: input.rubric_hash ?? hash("taric:l2:minimal-rubric"), limitations: input.limitations ?? proposal.content.limitations ?? [] };
      const reviewHash = hash(json(stablePayload(reviewBody)));
      this.#db.prepare("INSERT INTO reviews(id,proposal_id,reviewer_id,reviewer_kind,input_hash,verdict,body,created_at) VALUES(?,?,?,?,?,?,?,?)").run(rejectedId, input.proposal_id, input.reviewer_id, input.reviewer_kind, input.input_hash, input.verdict, json({ ...reviewBody, review_hash: reviewHash }), new Date().toISOString());
      // Register the accepted review so a later L2 promotion can anchor review_ref
      // to a real object. Without this the reference check rejects every promotion.
      this.#db.prepare("INSERT OR REPLACE INTO object_refs(id,engagement_id,kind) VALUES(?,?,?)").run(rejectedId, proposal.engagement_id, "review");
      this.nextEvent("review.submit", { reviewer_kind: input.reviewer_kind, reviewer_id: input.reviewer_id, input_hash: input.input_hash, proposal_hash: proposal.content_hash, evidence_snapshot_hash: evidenceSnapshotHash, review_hash: reviewHash, verdict: input.verdict, policy_digest: input.policy_digest, idempotency_key: input.idempotencyKey }, rejectedId);
      const accepted = { id: rejectedId, accepted: true, proposal_hash: proposal.content_hash, evidence_snapshot_hash: evidenceSnapshotHash, review_hash: reviewHash };
      return finalize(accepted);
    });
  }
  /**
   * Deterministic admission evaluation for a proposal. Advisory review verdicts,
   * a caller-declared trust level and an `accept: true` payload are never inputs:
   * the non-LLM policy engine recomputes every hard gate (tasks 1.1, 1.2).
   */
  evaluateAdmission(proposalId: string, input: { policyDigest?: string; policy?: AdmissionPolicy; now?: string } = {}): AdmissionDecision & { proposal_id: string } {
    const proposalRow = this.#db.prepare("SELECT * FROM proposals WHERE id=?").get(proposalId) as any;
    if (!proposalRow) throw new ContractValidationError("conflict", "proposal not found");
    const proposal: Proposal = { id: proposalRow.id, engagement_id: proposalRow.engagement_id, subject_type: proposalRow.subject_type, base_version: proposalRow.base_version, status: proposalRow.status, content_hash: proposalRow.content_hash, content: JSON.parse(proposalRow.body) };
    const policy = input.policy ?? DEFAULT_ADMISSION_POLICY;
    const digest = input.policyDigest ?? policyDigest(policy);
    const content = proposal.content as Record<string, unknown>;
    const provenance = (content.provenance ?? {}) as Record<string, unknown>;
    const evidenceRefs = [...new Set([
      ...(Array.isArray(content.evidence_refs) ? content.evidence_refs as string[] : []),
      ...(Array.isArray(content.counter_evidence_refs) ? content.counter_evidence_refs as string[] : []),
      ...(typeof content.applicable_scope_ref === "string" ? [content.applicable_scope_ref] : []),
    ])].sort();
    const evidence: PinnedEvidence[] = evidenceRefs.map((id) => {
      const row = this.#db.prepare("SELECT version,body FROM records WHERE id=? AND engagement_id=?").get(id, proposal.engagement_id) as { version?: number; body?: string } | undefined;
      const record = row?.body ? JSON.parse(row.body) as CanonicalRecord : undefined;
      return { id, version: Number(row?.version ?? 0), observed_at: typeof record?.observed_at === "string" ? record.observed_at : typeof record?.tested_at === "string" ? record.tested_at : undefined, status: String(record?.status ?? "missing") };
    });
    const reviewRows = this.#db.prepare("SELECT id,body FROM reviews WHERE proposal_id=? ORDER BY created_at").all(proposalId) as Array<{ id: string; body: string }>;
    const reviews: AdmissionReview[] = reviewRows.map((row) => {
      const body = JSON.parse(row.body) as Record<string, unknown>;
      return {
        review_id: row.id,
        reviewer_id: String(body.reviewer_id ?? ""),
        reviewer_kind: (typeof body.reviewer_capability === "string" ? body.reviewer_capability : body.reviewer_kind === "reviewer" ? "model" : String(body.reviewer_kind ?? "model")) as AdmissionReview["reviewer_kind"],
        verdict: String(body.verdict ?? "defer") as AdmissionReview["verdict"],
        input_hash: String(body.input_hash ?? ""),
        evidence_snapshot_hash: String(body.evidence_snapshot_hash ?? ""),
        policy_digest: String(body.policy_digest ?? ""),
        reviewer_model: typeof body.reviewer_model === "string" ? body.reviewer_model : undefined,
        prompt_digest: typeof body.prompt_digest === "string" ? body.prompt_digest : undefined,
        ruleset_digest: typeof body.ruleset_digest === "string" ? body.ruleset_digest : undefined,
      };
    });
    const snapshot = this.evidenceSnapshot(proposal);
    const decision = evaluateAdmission({
        subject: {
          id: String(content.id ?? proposalId),
          kind: String(content.kind ?? proposal.subject_type),
          author_ids: [String(provenance.producer_id ?? "")].filter(Boolean),
          worker_ids: [String(provenance.worker_id ?? "")].filter(Boolean),
          claim_refs: Array.isArray(content.claim_refs) ? content.claim_refs as string[] : undefined,
          evidence_refs: Array.isArray(content.evidence_refs) ? content.evidence_refs as string[] : undefined,
          counter_evidence_refs: Array.isArray(content.counter_evidence_refs) ? content.counter_evidence_refs as string[] : undefined,
          applicable_scope_ref: typeof content.applicable_scope_ref === "string" ? content.applicable_scope_ref : undefined,
          allowed_targets: Array.isArray(content.allowed_targets) ? content.allowed_targets as string[] : undefined,
          excluded_targets: Array.isArray(content.excluded_targets) ? content.excluded_targets as string[] : undefined,
          target: typeof content.target === "string" ? content.target : undefined,
          reproducibility: typeof content.reproducibility === "string" ? content.reproducibility : undefined,
          limitations: Array.isArray(content.limitations) ? content.limitations as string[] : undefined,
          review_after: typeof content.review_after === "string" ? content.review_after : undefined,
          expires_at: typeof content.expires_at === "string" ? content.expires_at : undefined,
          risk_class: riskClassOf(content),
        },
        policy,
        policy_digest: digest,
        evidence,
        reviews,
        input_hash: proposal.content_hash,
        evidence_snapshot_hash: snapshot.hash,
        now: input.now,
      });
    if (snapshot.errors.length) {
      // The pinned snapshot could not be computed; fail closed on every gate it feeds.
      for (const gate of decision.gates) {
        if (gate.gate === "evidence" || gate.gate === "freshness" || gate.gate === "independence") {
          gate.passed = false;
          gate.reasons.push(...snapshot.errors);
        }
      }
      decision.admitted = false;
      decision.promotable = false;
      decision.reasons.push(...snapshot.errors);
    }
    return { proposal_id: proposalId, ...decision };
  }
  promoteFinding(proposalId: string, input: { expectedBaseVersion: number; policyDigest: string; idempotencyKey?: string; principal?: string; policy?: AdmissionPolicy; now?: string }): AdmissionResult {
    return this.transaction(() => {
      const proposalRow = this.#db.prepare("SELECT * FROM proposals WHERE id=?").get(proposalId) as any;
      if (!proposalRow) throw new ContractValidationError("conflict", "proposal not found");
      const proposal: Proposal = { id: proposalRow.id, engagement_id: proposalRow.engagement_id, subject_type: proposalRow.subject_type, base_version: proposalRow.base_version, status: proposalRow.status, content_hash: proposalRow.content_hash, content: JSON.parse(proposalRow.body) };
      const requestHash = hash(json(stablePayload({ proposal_id: proposalId, expected_base_version: input.expectedBaseVersion, policy_digest: input.policyDigest })));
      if (input.idempotencyKey) {
        const prior = this.#db.prepare("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?").get(input.idempotencyKey) as any;
        if (prior) {
          if (prior.request_hash !== requestHash || prior.operation !== "admission.promote_l2" || prior.principal !== (input.principal ?? "core") || prior.engagement_id !== proposal.engagement_id) throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
          return JSON.parse(prior.result) as AdmissionResult;
        }
      }
      const finalize = (result: AdmissionResult) => {
        if (input.idempotencyKey) this.#db.prepare("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)").run(input.idempotencyKey, "admission.promote_l2", input.principal ?? "core", proposal.engagement_id, requestHash, json(result));
        return result;
      };
      if (proposal.status !== "pending") return finalize(this.rejectProposal(proposal, "proposal is not pending"));
      if (proposal.subject_type !== "finding") return finalize(this.rejectProposal(proposal, "proposal is not a finding"));
      if (!input.policyDigest) return finalize(this.rejectProposal(proposal, "policy digest is required"));
      if (proposal.base_version !== input.expectedBaseVersion) return finalize(this.rejectProposal(proposal, "base version mismatch"));
      const currentVersion = (this.#db.prepare("SELECT version FROM records WHERE id=?").get(proposal.content.id) as { version?: number } | undefined)?.version ?? 0;
      if (currentVersion !== input.expectedBaseVersion) return finalize(this.rejectProposal(proposal, "proposal base version is stale"));
      if (proposal.content.status && !["draft", "proposed"].includes(String(proposal.content.status))) return finalize(this.rejectProposal(proposal, "finding has an illegal promotion state"));
      // Every hard gate is recomputed by the non-LLM policy engine. Advisory review
      // verdicts and caller-supplied trust fields never decide the outcome (tasks 1.1, 1.3).
      const decision = this.evaluateAdmission(proposalId, { policyDigest: input.policyDigest, policy: input.policy, now: input.now });
      if (!decision.admitted) {
        const failed = decision.gates.filter((gate) => !gate.passed).map((gate) => gate.gate);
        const reason = `policy gate ${failed.join(",")} rejected promotion: ${decision.reasons.join("; ")}`;
        // A shortfall that only an additional independent review can repair leaves the
        // proposal pending: heterogeneous A/B review is a sequence, not one attempt.
        if (failed.every((gate) => gate === "independence")) {
          this.nextEvent("proposal.promotion_deferred", { reason, input_hash: proposal.content_hash, policy_digest: input.policyDigest, risk_class: decision.risk_class, gate_results: decision.gates }, proposalId);
          return finalize({ ok: false, reason, proposal: { ...proposal, status: "pending" } });
        }
        return finalize(this.rejectProposal(proposal, reason));
      }
      const reviewRows = this.#db.prepare("SELECT id,body FROM reviews WHERE proposal_id=? AND verdict='pass' AND input_hash=? ORDER BY created_at DESC").all(proposalId, proposal.content_hash) as Array<{ id: string; body: string }>;
      const reviewRow = reviewRows.find((row) => (JSON.parse(row.body) as Record<string, unknown>).evidence_snapshot_hash === this.evidenceSnapshotHash(proposal) && (JSON.parse(row.body) as Record<string, unknown>).policy_digest === input.policyDigest);
      if (!reviewRow) return finalize(this.rejectProposal(proposal, "independent review missing"));
      const review = JSON.parse(reviewRow.body!) as Record<string, unknown>;
      if (review.proposal_hash !== proposal.content_hash) return finalize(this.rejectProposal(proposal, "review proposal snapshot mismatch"));
      const expectedEvidenceHash = this.evidenceSnapshotHash(proposal);
      if (review.evidence_snapshot_hash !== expectedEvidenceHash) return finalize(this.rejectProposal(proposal, "review evidence snapshot mismatch"));
      if (review.policy_digest !== input.policyDigest) return finalize(this.rejectProposal(proposal, "review policy digest mismatch"));
      const supportingReviewRefs = reviewRows
        .filter((row) => (JSON.parse(row.body) as Record<string, unknown>).evidence_snapshot_hash === expectedEvidenceHash && (JSON.parse(row.body) as Record<string, unknown>).policy_digest === input.policyDigest)
        .map((row) => row.id);
      const record = this.commit({ ...proposal.content, review_ref: reviewRow.id, review_refs: supportingReviewRefs, risk_class: decision.risk_class, policy_digest: input.policyDigest, status: "verified", provenance: { ...(proposal.content.provenance as Record<string, unknown> ?? {}), producer_id: input.principal ?? "taric-core", source_kind: "reviewer" } }, "L2", undefined, undefined, false, input.expectedBaseVersion);
      this.#db.prepare("UPDATE proposals SET status='admitted' WHERE id=?").run(proposalId);
      this.nextEvent("proposal.promote_l2", { review_ref: reviewRow.id, review_refs: supportingReviewRefs, review_hash: review.review_hash, input_hash: proposal.content_hash, evidence_snapshot_hash: expectedEvidenceHash, policy_digest: input.policyDigest, risk_class: decision.risk_class, policy_version: input.policy?.version ?? DEFAULT_ADMISSION_POLICY.version, gate_results: decision.gates }, proposalId);
      return finalize({ ok: true, proposal: { ...proposal, status: "admitted" }, record });
    });
  }
  compareAndSet(id: string, expectedVersion: number, patch: Record<string, unknown>, trustLevel?: TrustLevel): CanonicalRecord {
    return this.transaction(() => {
      const current = this.get(id);
      if (!current || current.version !== expectedVersion) throw new ContractValidationError("conflict", "version conflict");
      const privileged = ["version", "trust_level", "display_id", "commit_seq", "engagement_id"];
      if (privileged.some((field) => field in patch)) throw new ContractValidationError("validation_error", "compare-and-set patch cannot set privileged fields");
      return this.commit({ ...current, ...patch, id, engagement_id: current.engagement_id, schema_version: SCHEMA_VERSION, display_id: current.display_id }, trustLevel ?? (current.trust_level ?? "L1"), `cas:${id}:${expectedVersion}:${hash(json(stablePayload(patch)))}`, undefined, true, expectedVersion);
    });
  }
  transitionRecall(subjectId: string, status: "stale" | "retracted" | "superseded" | "archived" | "expired", reason: string, options: { supersededBy?: string; reviewAfter?: string } = {}): CanonicalRecord {
    return this.transaction(() => {
      const current = this.get(subjectId);
      if (!current) throw new ContractValidationError("conflict", `record not found: ${subjectId}`);
      if (!reason || typeof reason !== "string") throw new ContractValidationError("validation_error", "recall reason is required");
      if (options.supersededBy) {
        const replacement = this.get(options.supersededBy);
        if (!replacement || replacement.engagement_id !== current.engagement_id) throw new ContractValidationError("validation_error", "superseded_by must reference a record in the same engagement");
      }
      const body: CanonicalRecord = { ...current, status, recall_excluded: true, recall_reason: reason, schema_version: SCHEMA_VERSION, display_id: current.display_id };
      if (options.supersededBy) body.superseded_by = options.supersededBy;
      if (options.reviewAfter) body.review_after = options.reviewAfter;
      const committed = this.commit(body, (current.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, Number(current.version));
      this.nextEvent(`record.${status}`, { reason, before_hash: hash(json(current)), after_hash: hash(json(committed)), superseded_by: options.supersededBy, review_after: options.reviewAfter }, subjectId);
      return committed;
    });
  }
  markStale(subjectId: string, reason: string): CanonicalRecord {
    return this.transitionRecall(subjectId, "stale", reason);
  }
  retract(subjectId: string, reason: string): CanonicalRecord { return this.transitionRecall(subjectId, "retracted", reason); }
  supersede(subjectId: string, supersededBy: string, reason: string): CanonicalRecord { return this.transitionRecall(subjectId, "superseded", reason, { supersededBy }); }
  archive(subjectId: string, reason: string): CanonicalRecord { return this.transitionRecall(subjectId, "archived", reason); }
  expire(subjectId: string, reason = "record expired"): CanonicalRecord { return this.transitionRecall(subjectId, "expired", reason); }
  /**
   * Contradictory evidence is a revalidation event, never a silent overwrite.
   * The current view becomes inconclusive/stale while the previous observation
   * remains available through an as-of snapshot (task 2.3).
   */
  contradict(subjectId: string, evidenceRefs: string[], reason = "contradictory evidence"): CanonicalRecord {
    if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) throw new ContractValidationError("validation_error", "contradiction requires evidence references");
    return this.transaction(() => {
      const current = this.get(subjectId);
      if (!current) throw new ContractValidationError("conflict", "record not found: " + subjectId);
      const updated = this.commit({ ...current, status: "inconclusive", recall_excluded: true, recall_reason: reason, counter_evidence_refs: [...new Set([...(Array.isArray(current.counter_evidence_refs) ? current.counter_evidence_refs as string[] : []), ...evidenceRefs])], schema_version: SCHEMA_VERSION, display_id: current.display_id }, (current.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, Number(current.version));
      this.nextEvent("record.contradicted", { reason, counter_evidence_refs: evidenceRefs, before_hash: hash(json(current)), after_hash: hash(json(updated)) }, subjectId);
      const work = this.commit({ id: uuidv7(), engagement_id: current.engagement_id, kind: "work_item", title: "Revalidate " + String(current.display_id ?? subjectId), status: "queued", related_entity_ref: subjectId, acceptance_criteria: ["Resolve contradictory evidence", "Record updated evidence"], risk_class: String(current.risk_class ?? "medium"), provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" } }, "L1");
      this.nextEvent("record.revalidation_queued", { subject_ref: subjectId, work_item_id: work.id, counter_evidence_refs: evidenceRefs }, work.id);
      return updated;
    });
  }
  /** 只读审计事件列表，供 doctor 与测试使用，不暴露数据库句柄。 */
  events(): AuditEvent[] {
    const rows = this.#db.prepare("SELECT commit_seq,event_id,event_type,subject_id,payload,prev_hash,hash,created_at FROM events ORDER BY commit_seq").all() as Array<{ commit_seq: number; event_id: string; event_type: string; subject_id: string | null; payload: string; prev_hash: string | null; hash: string; created_at: string }>;
    return rows.map((row) => ({ commit_seq: row.commit_seq, event_id: row.event_id, event_type: row.event_type, subject_id: row.subject_id ?? undefined, payload: JSON.parse(row.payload) as Record<string, unknown>, prev_hash: row.prev_hash, hash: row.hash, created_at: row.created_at }));
  }
  verifyAudit(): { valid: boolean; errors: string[] } {
    const events = this.#db.prepare("SELECT * FROM events ORDER BY commit_seq").all() as any[];
    const errors: string[] = []; let prev: string | null = null;
    for (const [index, event] of events.entries()) {
      if (Number(event.commit_seq) !== index + 1) errors.push(`event ${event.event_id}: sequence gap, expected ${index + 1}, found ${event.commit_seq}`);
      if (event.prev_hash !== prev) errors.push(`event ${event.event_id}: previous hash mismatch`);
      try {
        const expected = hash(json({ event_id: event.event_id, eventType: event.event_type, subjectId: event.subject_id ?? undefined, payload: JSON.parse(event.payload), prev_hash: event.prev_hash, created_at: event.created_at }));
        if (event.hash !== expected) errors.push(`event ${event.event_id}: hash mismatch`);
      } catch { errors.push(`event ${event.event_id}: invalid payload JSON`); }
      prev = event.hash;
    }
    return { valid: errors.length === 0, errors };
  }
}
