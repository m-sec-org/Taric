import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { uuidv7 } from "./identity.js";
import { contractNames, SCHEMA_VERSION, type ContractName } from "@taric/schemas";
import { ContractValidationError, validateCanonicalRecord, validateContract } from "./validation.js";

export type TrustLevel = "L0" | "L1" | "L2";
export interface CanonicalRecord { id: string; engagement_id: string; trust_level?: TrustLevel; version?: number; [key: string]: unknown }
export interface Proposal { id: string; engagement_id: string; subject_type: string; content: CanonicalRecord; base_version: number; status: "pending" | "rejected" | "admitted" | "needs_evidence"; content_hash: string; }
export interface AuditEvent { event_id: string; commit_seq: number; event_type: string; subject_id?: string; payload: Record<string, unknown>; prev_hash: string | null; hash: string; created_at: string; }
export interface AdmissionResult { ok: boolean; reason?: string; record?: CanonicalRecord; proposal: Proposal; }
export interface ReadSnapshot { read_seq: number; records: CanonicalRecord[]; }
export interface IdempotencyContext { operation: string; principal: string; engagement_id: string; }
export interface DoctorReport { valid: boolean; schema_version: string; pending_outbox: number; audit: ReturnType<AuthorityStore["verifyAudit"]>; errors: string[]; }

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (value: unknown) => JSON.stringify(value);
/** 必须经过共享校验器的 Phase 1 领域合同 kind。 */
const phaseOneContracts = new Set<string>(contractNames.filter((name) => !["apiSuccess", "apiError", "auditEvent"].includes(name)));

/** ActionIntent 的合法状态迁移；denied 不得再进入执行态。 */
const actionTransitions: Record<string, string[]> = {
  recommended: ["authorized", "denied"],
  authorized: ["executed", "failed", "unknown"],
  unknown: ["executed", "failed"],
  executed: [],
  failed: [],
  denied: [],
};

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
  #transactionDepth = 0;
  constructor(filename = ":memory:") {
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
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, reviewer_kind TEXT NOT NULL, input_hash TEXT NOT NULL, verdict TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS object_refs (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_runs (run_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, engagement_id TEXT NOT NULL, status TEXT NOT NULL, owner_host TEXT, owner_agent TEXT, generation INTEGER NOT NULL, lease_expires_at TEXT, heartbeat_at TEXT, checkpoint_id TEXT, read_seq INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (checkpoint_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_intents (action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    this.#db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('schema_version',?)").run(SCHEMA_VERSION);
    this.#db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('display_sequence','1')").run();
  }
  close(): void { this.#db.close(); }
  private transaction<T>(operation: () => T): T {
    const nested = this.#transactionDepth > 0;
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
  private nextEvent(eventType: string, payload: Record<string, unknown>, subjectId?: string): AuditEvent {
    const last = this.#db.prepare("SELECT hash FROM events ORDER BY commit_seq DESC LIMIT 1").get() as { hash?: string } | undefined;
    const created_at = new Date().toISOString();
    const prev_hash = last?.hash ?? null;
    const event_id = uuidv7();
    const canonical = json({ event_id, eventType, subjectId, payload, prev_hash, created_at });
    const event = { event_id, commit_seq: 0, event_type: eventType, subject_id: subjectId, payload, prev_hash, hash: hash(canonical), created_at };
    const result = this.#db.prepare("INSERT INTO events(event_id,event_type,subject_id,payload,prev_hash,hash,created_at) VALUES(?,?,?,?,?,?,?)").run(event_id, eventType, subjectId ?? null, json(payload), prev_hash, event.hash, created_at);
    event.commit_seq = Number(result.lastInsertRowid);
    this.#db.prepare("INSERT INTO outbox(commit_seq) VALUES(?)").run(event.commit_seq);
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
    if (!internal && record.schema_version !== undefined && phaseOneContracts.has(kind)) validateContract(kind as ContractName, normalized);
    // 跨字段安全护栏对每一条写入都生效，包括内部 writer 调用。
    validateCanonicalRecord(normalized, trustLevel);
    return normalized;
  }
  commit(record: CanonicalRecord, trustLevel: TrustLevel = "L1", idempotencyKey?: string, context?: Partial<IdempotencyContext>, internal = false): CanonicalRecord {
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
      const version = (existing?.version ?? 0) + 1;
      const aliasSequence = existing ? undefined : Number((this.#db.prepare("SELECT value FROM metadata WHERE key='display_sequence'").get() as { value: string }).value);
      if (aliasSequence !== undefined) this.#db.prepare("UPDATE metadata SET value=? WHERE key='display_sequence'").run(String(aliasSequence + 1));
      const old = existing?.body ? JSON.parse(existing.body) as CanonicalRecord : undefined;
      const committed = { ...normalized, version, trust_level: trustLevel, display_id: existing?.display_id ?? (aliasSequence === undefined ? undefined : `TAR-${String(aliasSequence).padStart(6, "0")}`) };
      for (const ref of this.referencedIds(committed)) {
        const target = this.#db.prepare("SELECT engagement_id FROM records WHERE id=? UNION SELECT engagement_id FROM object_refs WHERE id=?").get(ref, ref) as { engagement_id?: string } | undefined;
        if (!target || target.engagement_id !== record.engagement_id) throw new ContractValidationError("validation_error", `invalid or cross-engagement reference: ${ref}`);
      }
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
  private referencedIds(record: CanonicalRecord): string[] {
    const fields = ["scope_ref", "resource_ref", "from_ref", "to_ref", "claim_refs", "evidence_refs", "review_ref", "depends_on", "work_item_ref"];
    const refs: string[] = [];
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "string") refs.push(value);
      else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") refs.push(item);
    }
    return refs;
  }
  list(engagementId: string, options: { trustLevel?: TrustLevel; includeCandidates?: boolean } = {}): CanonicalRecord[] {
    const rows = this.#db.prepare("SELECT body,trust_level FROM records WHERE engagement_id=? ORDER BY updated_at,id").all(engagementId) as Array<{ body: string; trust_level: TrustLevel }>;
    return rows.filter((row) => row.trust_level !== "L0" && (options.includeCandidates || row.trust_level !== "L1" || options.trustLevel === "L1") && (!options.trustLevel || row.trust_level === options.trustLevel)).map((row) => JSON.parse(row.body));
  }
  snapshot(engagementId: string, options: { trustLevel?: TrustLevel; includeCandidates?: boolean; asOf?: number } = {}): ReadSnapshot {
    const current = Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as { seq: number }).seq);
    const seq = options.asOf ?? current;
    if (!Number.isInteger(seq) || seq < 0 || seq > current) throw new ContractValidationError("conflict", `unsupported authority sequence: ${seq}`);
    const rows = this.#db.prepare("SELECT body,trust_level FROM record_versions WHERE engagement_id=? AND commit_seq<=? ORDER BY commit_seq DESC").all(engagementId, seq) as Array<{ body: string; trust_level: TrustLevel }>;
    const seen = new Set<string>();
    const records = rows.filter((row) => { const body = JSON.parse(row.body) as CanonicalRecord; if (seen.has(body.id)) return false; seen.add(body.id); return row.trust_level !== "L0" && (options.includeCandidates || row.trust_level !== "L1" || options.trustLevel === "L1") && (!options.trustLevel || row.trust_level === options.trustLevel); }).map((row) => JSON.parse(row.body) as CanonicalRecord).sort((a, b) => a.id.localeCompare(b.id));
    return { read_seq: seq, records };
  }

  doctor(): DoctorReport {
    const schema = (this.#db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as { value?: string } | undefined)?.value ?? "missing";
    const pending = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status != 'applied'").get() as { count: number }).count);
    const audit = this.verifyAudit();
    const errors = [...audit.errors];
    if (schema !== SCHEMA_VERSION) errors.push(`unsupported schema version: ${schema}`);
    return { valid: errors.length === 0, schema_version: schema, pending_outbox: pending, audit, errors };
  }

  exportSnapshot(engagementId: string, asOf?: number): { schema_version: string; engagement_id: string; read_seq: number; records: CanonicalRecord[]; hash: string } {
    const snapshot = this.snapshot(engagementId, { asOf, includeCandidates: true });
    const payload = { schema_version: SCHEMA_VERSION, core_version: "1.0.0", engagement_id: engagementId, read_seq: snapshot.read_seq, records: snapshot.records };
    return { ...payload, hash: hash(json(payload)) };
  }

  unsupported(operation: "snapshot.import" | "migration" | "backup.restore" | "remote.push"): never {
    throw new ContractValidationError("unsupported_capability", `unsupported capability: ${operation}`);
  }
  submitProposal(proposal: Omit<Proposal, "id" | "content_hash" | "status"> & Partial<Pick<Proposal, "id" | "status">>): Proposal {
    if (proposal.status && proposal.status !== "pending") throw new ContractValidationError("validation_error", "proposal status is assigned by Core");
    if (proposal.content.trust_level !== undefined || proposal.content.display_id !== undefined || proposal.content.admission_status !== undefined || proposal.content.policy_result !== undefined) throw new ContractValidationError("validation_error", "proposal contains privileged fields");
    if (typeof proposal.content?.id !== "string" || typeof proposal.engagement_id !== "string" || proposal.content.engagement_id !== proposal.engagement_id) throw new ContractValidationError("validation_error", "proposal content must belong to the proposal engagement");
    const id = proposal.id ?? uuidv7();
    const content_hash = hash(json(proposal.content));
    const result: Proposal = { ...proposal, id, content_hash, status: "pending" };
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.#db.prepare("INSERT INTO proposals(id,engagement_id,subject_type,base_version,status,content_hash,body,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, proposal.engagement_id, proposal.subject_type, proposal.base_version, result.status, content_hash, json(proposal.content), now);
      this.nextEvent("proposal.submit", { input_hash: content_hash, subject_type: proposal.subject_type, actor_id: "core" }, id);
      return result;
    });
  }
  proposals(engagementId: string): Proposal[] { return (this.#db.prepare("SELECT * FROM proposals WHERE engagement_id=? ORDER BY created_at").all(engagementId) as any[]).map((row) => ({ id: row.id, engagement_id: row.engagement_id, subject_type: row.subject_type, base_version: row.base_version, status: row.status, content_hash: row.content_hash, content: JSON.parse(row.body) })); }
  admitProposal(id: string, policyDigest: string, options: { expectedBaseVersion?: number; validate?: (content: CanonicalRecord) => string | undefined } = {}): AdmissionResult {
    return this.transaction(() => {
    const row = this.#db.prepare("SELECT * FROM proposals WHERE id=?").get(id) as any;
    if (!row) throw new Error(`proposal not found: ${id}`);
    const proposal: Proposal = { id: row.id, engagement_id: row.engagement_id, subject_type: row.subject_type, base_version: row.base_version, status: row.status, content_hash: row.content_hash, content: JSON.parse(row.body) };
    if (row.status !== "pending") return this.rejectProposal(proposal, "proposal is not pending");
    if (!policyDigest) return this.rejectProposal(proposal, "policy digest is required");
    const current = this.#db.prepare("SELECT version FROM records WHERE id=?").get(proposal.content.id) as { version?: number } | undefined;
    const currentVersion = current?.version ?? 0;
    if (options.expectedBaseVersion !== undefined && options.expectedBaseVersion !== currentVersion) return this.rejectProposal(proposal, "base version mismatch");
    if (proposal.base_version !== currentVersion) return this.rejectProposal(proposal, "proposal base version is stale");
    const reason = options.validate?.(proposal.content);
    if (reason) return this.rejectProposal(proposal, reason);
    const record = this.commit({ ...proposal.content, policy_digest: policyDigest }, "L1");
    this.#db.prepare("UPDATE proposals SET status='admitted' WHERE id=?").run(id);
    this.nextEvent("proposal.admit", { input_hash: proposal.content_hash, policy_digest: policyDigest, actor_id: "core" }, id);
    return { ok: true, proposal: { ...proposal, status: "admitted" }, record };
    });
  }
  private rejectProposal(proposal: Proposal, reason: string): AdmissionResult {
    this.#db.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(proposal.id);
    this.nextEvent("proposal.reject", { input_hash: proposal.content_hash, reason, actor_id: "core" }, proposal.id);
    return { ok: false, reason, proposal: { ...proposal, status: "rejected" } };
  }

  claimWorkRun(input: { run_id?: string; work_item_id: string; engagement_id: string; host_id: string; agent_id: string; ttl_ms?: number }): Record<string, unknown> {
    const runId = input.run_id ?? uuidv7(); const now = new Date(); const expiry = new Date(now.getTime() + (input.ttl_ms ?? 60_000)).toISOString();
    return this.transaction(() => {
      const prior = this.#db.prepare("SELECT generation,status,lease_expires_at FROM work_runs WHERE run_id=?").get(runId) as any;
      if (prior && prior.status === "running" && prior.lease_expires_at > now.toISOString()) throw new Error("work run lease is still active");
      const generation = Number(prior?.generation ?? 0) + 1;
      const body = { run_id: runId, work_item_id: input.work_item_id, engagement_id: input.engagement_id, status: "running", owner: { host_id: input.host_id, agent_id: input.agent_id }, generation, lease_expires_at: expiry, heartbeat_at: now.toISOString(), read_seq: Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as any).seq) };
      this.#db.prepare("INSERT INTO work_runs(run_id,work_item_id,engagement_id,status,owner_host,owner_agent,generation,lease_expires_at,heartbeat_at,read_seq,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,owner_host=excluded.owner_host,owner_agent=excluded.owner_agent,generation=excluded.generation,lease_expires_at=excluded.lease_expires_at,heartbeat_at=excluded.heartbeat_at,read_seq=excluded.read_seq,body=excluded.body,updated_at=excluded.updated_at").run(runId, input.work_item_id, input.engagement_id, "running", input.host_id, input.agent_id, generation, expiry, now.toISOString(), body.read_seq, json(body), now.toISOString(), now.toISOString());
      this.nextEvent("work_run.claim", { generation, host_id: input.host_id, agent_id: input.agent_id }, runId);
      return body;
    });
  }
  commitCheckpoint(runId: string, generation: number, hostId: string, checkpoint: Record<string, unknown>): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
      if (!row || row.owner_host !== hostId || Number(row.generation) !== generation || row.lease_expires_at <= new Date().toISOString()) throw new Error("invalid or expired work run lease");
      const checkpointId = uuidv7(); const saved = { ...checkpoint, checkpoint_id: checkpointId, run_id: runId, generation, base_read_seq: row.read_seq };
      this.#db.prepare("INSERT INTO checkpoints(checkpoint_id,run_id,generation,body,created_at) VALUES(?,?,?,?,?)").run(checkpointId, runId, generation, json(saved), new Date().toISOString());
      const body = { ...JSON.parse(row.body), checkpoint_id: checkpointId, status: "checkpointed" };
      this.#db.prepare("UPDATE work_runs SET status='checkpointed',checkpoint_id=?,body=?,updated_at=? WHERE run_id=?").run(checkpointId, json(body), new Date().toISOString(), runId);
      this.nextEvent("work_run.checkpoint", { checkpoint_id: checkpointId, generation }, runId);
      return saved;
    });
  }
  getWorkRun(runId: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare("SELECT body FROM work_runs WHERE run_id=?").get(runId) as { body?: string } | undefined;
    return row ? JSON.parse(row.body!) : undefined;
  }
  recordActionIntent(input: { action_id?: string; run_id: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; host_decision_ref?: string; status: "recommended" | "authorized" | "denied" | "executed" | "failed" | "unknown"; result_ref?: string }): Record<string, unknown> {
    const actionId = input.action_id ?? uuidv7(); const body = { ...input, action_id: actionId, recorded_at: new Date().toISOString() };
    return this.transaction(() => {
      const run = this.#db.prepare("SELECT generation,status,owner_host FROM work_runs WHERE run_id=?").get(input.run_id) as { generation?: number; status?: string; owner_host?: string } | undefined;
      if (!run || Number(run.generation) !== input.generation) throw new ContractValidationError("conflict", "stale action intent generation");
      if (["completed", "cancelled"].includes(String(run.status))) throw new ContractValidationError("conflict", "action intent is not writable for a terminal work run");
      const prior = this.#db.prepare("SELECT status,generation FROM action_intents WHERE action_id=?").get(actionId) as { status?: string; generation?: number } | undefined;
      if (prior) {
        if (Number(prior.generation) !== input.generation || prior.status === input.status) return body;
        if (!actionTransitions[String(prior.status)]?.includes(input.status)) throw new ContractValidationError("conflict", `illegal action intent transition: ${prior.status} -> ${input.status}`);
      }
      if (input.status === "authorized" && !input.host_decision_ref) throw new ContractValidationError("validation_error", "host decision reference is required for authorized actions");
      this.#db.prepare("INSERT INTO action_intents(action_id,run_id,generation,status,body,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET status=excluded.status,body=excluded.body,updated_at=excluded.updated_at").run(actionId, input.run_id, input.generation, input.status, json(body), new Date().toISOString());
      this.nextEvent("action_intent.host_result", { mode: input.mode, status: input.status, host_decision_ref: input.host_decision_ref, result_ref: input.result_ref, generation: input.generation }, actionId);
      return body;
    });
  }
  pendingActionIntents(runId: string): Array<Record<string, unknown>> {
    return (this.#db.prepare("SELECT body FROM action_intents WHERE run_id=? AND status IN ('unknown','authorized')").all(runId) as Array<{body:string}>).map((row) => JSON.parse(row.body));
  }
  resumePacket(runId: string, hostId: string): Record<string, unknown> {
    const row = this.#db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
    if (!row) throw new Error("work run not found");
    if (row.owner_host !== hostId) throw new Error("host does not own work run");
    const checkpoint = row.checkpoint_id ? JSON.parse((this.#db.prepare("SELECT body FROM checkpoints WHERE checkpoint_id=?").get(row.checkpoint_id) as any).body) : null;
    return { run: JSON.parse(row.body), checkpoint, pending_actions: this.pendingActionIntents(runId), current_read_seq: Number((this.#db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as any).seq) };
  }
  recordLateResult(input: { run_id: string; generation: number; result_ref: string; result: Record<string, unknown> }): Record<string, unknown> {
    const late = { late_result_id: uuidv7(), ...input, status: "late_result_quarantine", recorded_at: new Date().toISOString() };
    return this.transaction(() => {
      this.#db.prepare("INSERT INTO action_intents(action_id,run_id,generation,status,body,updated_at) VALUES(?,?,?,?,?,?)").run(late.late_result_id, input.run_id, input.generation, late.status, json(late), new Date().toISOString());
      this.nextEvent("action_intent.late_result_quarantine", { generation: input.generation, result_ref: input.result_ref }, late.late_result_id);
      return late;
    });
  }
  submitReview(input: { id?: string; proposal_id: string; reviewer_id: string; reviewer_kind: "deterministic" | "model" | "reviewer"; input_hash: string; verdict: "pass" | "reject" | "needs_evidence" | "defer"; policy_digest?: string }): { id: string; accepted: boolean; reason?: string } {
    return this.transaction(() => {
      const proposalRow = this.#db.prepare("SELECT * FROM proposals WHERE id=?").get(input.proposal_id) as any;
      if (!proposalRow) throw new ContractValidationError("conflict", "proposal not found");
      const proposal: Proposal = { id: proposalRow.id, engagement_id: proposalRow.engagement_id, subject_type: proposalRow.subject_type, base_version: proposalRow.base_version, status: proposalRow.status, content_hash: proposalRow.content_hash, content: JSON.parse(proposalRow.body) };
      const rejectedId = input.id ?? uuidv7();
      if (input.input_hash !== proposal.content_hash) return { id: rejectedId, accepted: false, reason: "review input hash mismatch" };
      const provenance = (proposal.content.provenance ?? {}) as Record<string, unknown>;
      const author = String(provenance.producer_id ?? "");
      const worker = String(provenance.worker_id ?? provenance.author_id ?? "");
      if (input.reviewer_kind === "reviewer" && [author, worker].includes(input.reviewer_id)) return { id: rejectedId, accepted: false, reason: "reviewer is not independent from the proposal author or validating worker" };
      if (input.reviewer_kind === "reviewer" && !input.policy_digest) return { id: rejectedId, accepted: false, reason: "reviewer policy digest is required" };
      this.#db.prepare("INSERT INTO reviews(id,proposal_id,reviewer_id,reviewer_kind,input_hash,verdict,body,created_at) VALUES(?,?,?,?,?,?,?,?)").run(rejectedId, input.proposal_id, input.reviewer_id, input.reviewer_kind, input.input_hash, input.verdict, json(input), new Date().toISOString());
      // Register the accepted review so a later L2 promotion can anchor review_ref
      // to a real object. Without this the reference check rejects every promotion.
      this.#db.prepare("INSERT OR REPLACE INTO object_refs(id,engagement_id,kind) VALUES(?,?,?)").run(rejectedId, proposal.engagement_id, "review");
      this.nextEvent("review.submit", { reviewer_kind: input.reviewer_kind, reviewer_id: input.reviewer_id, input_hash: input.input_hash, verdict: input.verdict, policy_digest: input.policy_digest }, rejectedId);
      return { id: rejectedId, accepted: true };
    });
  }
  promoteFinding(proposalId: string, input: { expectedBaseVersion: number; policyDigest: string }): AdmissionResult {
    return this.transaction(() => {
      const proposalRow = this.#db.prepare("SELECT * FROM proposals WHERE id=?").get(proposalId) as any;
      if (!proposalRow) throw new ContractValidationError("conflict", "proposal not found");
      const proposal: Proposal = { id: proposalRow.id, engagement_id: proposalRow.engagement_id, subject_type: proposalRow.subject_type, base_version: proposalRow.base_version, status: proposalRow.status, content_hash: proposalRow.content_hash, content: JSON.parse(proposalRow.body) };
      if (proposal.status !== "pending") return this.rejectProposal(proposal, "proposal is not pending");
      if (proposal.subject_type !== "finding") return this.rejectProposal(proposal, "proposal is not a finding");
      if (!input.policyDigest) return this.rejectProposal(proposal, "policy digest is required");
      if (proposal.base_version !== input.expectedBaseVersion) return this.rejectProposal(proposal, "base version mismatch");
      const currentVersion = (this.#db.prepare("SELECT version FROM records WHERE id=?").get(proposal.content.id) as { version?: number } | undefined)?.version ?? 0;
      if (currentVersion !== input.expectedBaseVersion) return this.rejectProposal(proposal, "proposal base version is stale");
      if (!Array.isArray(proposal.content.evidence_refs) || proposal.content.evidence_refs.length === 0) return this.rejectProposal(proposal, "finding requires evidence");
      const review = this.#db.prepare("SELECT id FROM reviews WHERE proposal_id=? AND reviewer_kind='reviewer' AND verdict='pass' AND input_hash=?").get(proposalId, proposal.content_hash) as { id?: string } | undefined;
      if (!review) return this.rejectProposal(proposal, "independent review missing");
      const record = this.commit({ ...proposal.content, review_ref: review.id, policy_digest: input.policyDigest }, "L2");
      this.#db.prepare("UPDATE proposals SET status='admitted' WHERE id=?").run(proposalId);
      this.nextEvent("proposal.promote_l2", { review_ref: review.id, input_hash: proposal.content_hash, policy_digest: input.policyDigest }, proposalId);
      return { ok: true, proposal: { ...proposal, status: "admitted" }, record };
    });
  }
  compareAndSet(id: string, expectedVersion: number, patch: Record<string, unknown>, trustLevel?: TrustLevel): CanonicalRecord {
    return this.transaction(() => {
      const current = this.get(id);
      if (!current || current.version !== expectedVersion) throw new ContractValidationError("conflict", "version conflict");
      const privileged = ["version", "trust_level", "display_id", "commit_seq", "engagement_id"];
      if (privileged.some((field) => field in patch)) throw new ContractValidationError("validation_error", "compare-and-set patch cannot set privileged fields");
      return this.commit({ ...current, ...patch, id, engagement_id: current.engagement_id, schema_version: SCHEMA_VERSION, display_id: current.display_id }, trustLevel ?? (current.trust_level ?? "L1"), `cas:${id}:${expectedVersion}:${hash(json(stablePayload(patch)))}`, undefined, true);
    });
  }
  markStale(subjectId: string, reason: string): CanonicalRecord {
    return this.transaction(() => {
      const current = this.get(subjectId);
      if (!current) throw new ContractValidationError("conflict", `record not found: ${subjectId}`);
      return this.commit({ ...current, status: "stale", recall_excluded: true, stale_reason: reason, schema_version: SCHEMA_VERSION, display_id: current.display_id }, (current.trust_level as TrustLevel) ?? "L1", `stale:${subjectId}:${current.version}:${reason}`, undefined, true);
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
    for (const event of events) {
      if (event.prev_hash !== prev) errors.push(`event ${event.event_id}: previous hash mismatch`);
      const expected = hash(json({ event_id: event.event_id, eventType: event.event_type, subjectId: event.subject_id ?? undefined, payload: JSON.parse(event.payload), prev_hash: event.prev_hash, created_at: event.created_at }));
      if (event.hash !== expected) errors.push(`event ${event.event_id}: hash mismatch`);
      prev = event.hash;
    }
    return { valid: errors.length === 0, errors };
  }
}
