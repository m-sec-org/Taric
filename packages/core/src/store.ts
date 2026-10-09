import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { uuidv7 } from "./identity.js";

export type TrustLevel = "L0" | "L1" | "L2";
export interface CanonicalRecord { id: string; engagement_id: string; trust_level?: TrustLevel; version?: number; [key: string]: unknown }
export interface Proposal { id: string; engagement_id: string; subject_type: string; content: CanonicalRecord; base_version: number; status: "pending" | "rejected" | "admitted" | "needs_evidence"; content_hash: string; }
export interface AuditEvent { event_id: string; commit_seq: number; event_type: string; subject_id?: string; payload: Record<string, unknown>; prev_hash: string | null; hash: string; created_at: string; }
export interface AdmissionResult { ok: boolean; reason?: string; record?: CanonicalRecord; proposal: Proposal; }
export interface ReadSnapshot { read_seq: number; records: CanonicalRecord[]; }

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (value: unknown) => JSON.stringify(value);

/** SQLite WAL authority store. Node 22+ supplies the synchronous sqlite binding. */
export class AuthorityStore {
  readonly db: DatabaseSync;
  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, kind TEXT NOT NULL, trust_level TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, subject_type TEXT NOT NULL, base_version INTEGER NOT NULL, status TEXT NOT NULL, content_hash TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (commit_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, event_type TEXT NOT NULL, subject_id TEXT, payload TEXT NOT NULL, prev_hash TEXT, hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, commit_seq INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, reviewer_kind TEXT NOT NULL, input_hash TEXT NOT NULL, verdict TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS object_refs (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_runs (run_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, engagement_id TEXT NOT NULL, status TEXT NOT NULL, owner_host TEXT, owner_agent TEXT, generation INTEGER NOT NULL, lease_expires_at TEXT, heartbeat_at TEXT, checkpoint_id TEXT, read_seq INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (checkpoint_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_intents (action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('display_sequence','1')").run();
  }
  close(): void { this.db.close(); }
  private nextEvent(eventType: string, payload: Record<string, unknown>, subjectId?: string): AuditEvent {
    const last = this.db.prepare("SELECT hash FROM events ORDER BY commit_seq DESC LIMIT 1").get() as { hash?: string } | undefined;
    const created_at = new Date().toISOString();
    const prev_hash = last?.hash ?? null;
    const event_id = uuidv7();
    const canonical = json({ event_id, eventType, subjectId, payload, prev_hash, created_at });
    const event = { event_id, commit_seq: 0, event_type: eventType, subject_id: subjectId, payload, prev_hash, hash: hash(canonical), created_at };
    const result = this.db.prepare("INSERT INTO events(event_id,event_type,subject_id,payload,prev_hash,hash,created_at) VALUES(?,?,?,?,?,?,?)").run(event_id, eventType, subjectId ?? null, json(payload), prev_hash, event.hash, created_at);
    event.commit_seq = Number(result.lastInsertRowid);
    this.db.prepare("INSERT INTO outbox(commit_seq) VALUES(?)").run(event.commit_seq);
    return event;
  }
  commit(record: CanonicalRecord, trustLevel: TrustLevel = "L1", idempotencyKey?: string): CanonicalRecord {
    if (idempotencyKey) {
      const prior = this.db.prepare("SELECT result FROM idempotency WHERE key=?").get(idempotencyKey) as { result?: string } | undefined;
      if (prior) return JSON.parse(prior.result!);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const existing = this.db.prepare("SELECT version FROM records WHERE id=?").get(record.id) as { version?: number } | undefined;
      const version = (existing?.version ?? 0) + 1;
      const aliasValue = this.db.prepare("SELECT value FROM metadata WHERE key='display_sequence'").get() as { value: string };
      const aliasSequence = Number(aliasValue.value);
      this.db.prepare("UPDATE metadata SET value=? WHERE key='display_sequence'").run(String(aliasSequence + 1));
      const committed = { ...record, version, trust_level: trustLevel, display_id: (record as any).display_id ?? `TAR-${String(aliasSequence).padStart(6, "0")}` };
      for (const ref of this.referencedIds(committed)) {
        const target = this.db.prepare("SELECT engagement_id FROM records WHERE id=? UNION SELECT engagement_id FROM object_refs WHERE id=?").get(ref, ref) as { engagement_id?: string } | undefined;
        if (!target || target.engagement_id !== record.engagement_id) throw new Error(`invalid or cross-engagement reference: ${ref}`);
      }
      this.db.prepare("INSERT INTO records(id,engagement_id,kind,trust_level,version,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,trust_level=excluded.trust_level,version=excluded.version,updated_at=excluded.updated_at").run(record.id, record.engagement_id, String(record.kind ?? record.type ?? "record"), trustLevel, version, json(committed), now, now);
      this.db.prepare("INSERT OR REPLACE INTO object_refs(id,engagement_id,kind) VALUES(?,?,?)").run(record.id, record.engagement_id, String(record.kind ?? record.type ?? "record"));
      const event = this.nextEvent("record.commit", { version, trust_level: trustLevel, record: committed }, record.id);
      const result = { ...committed, commit_seq: event.commit_seq };
      if (idempotencyKey) this.db.prepare("INSERT INTO idempotency(key,result) VALUES(?,?)").run(idempotencyKey, json(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(id: string): CanonicalRecord | undefined {
    const row = this.db.prepare("SELECT body FROM records WHERE id=?").get(id) as { body?: string } | undefined;
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
    const rows = this.db.prepare("SELECT body,trust_level FROM records WHERE engagement_id=? ORDER BY updated_at,id").all(engagementId) as Array<{ body: string; trust_level: TrustLevel }>;
    return rows.filter((row) => row.trust_level !== "L0" && (options.includeCandidates || row.trust_level !== "L1" || options.trustLevel === "L1") && (!options.trustLevel || row.trust_level === options.trustLevel)).map((row) => JSON.parse(row.body));
  }
  snapshot(engagementId: string, options: { trustLevel?: TrustLevel; includeCandidates?: boolean } = {}): ReadSnapshot {
    const seq = Number((this.db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as { seq: number }).seq);
    return { read_seq: seq, records: this.list(engagementId, options) };
  }
  submitProposal(proposal: Omit<Proposal, "id" | "content_hash" | "status"> & Partial<Pick<Proposal, "id" | "status">>): Proposal {
    const id = proposal.id ?? uuidv7();
    const content_hash = hash(json(proposal.content));
    const result: Proposal = { ...proposal, id, content_hash, status: proposal.status ?? "pending" };
    this.db.prepare("INSERT INTO proposals(id,engagement_id,subject_type,base_version,status,content_hash,body,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, proposal.engagement_id, proposal.subject_type, proposal.base_version, result.status, content_hash, json(proposal.content), new Date().toISOString());
    return result;
  }
  proposals(engagementId: string): Proposal[] { return (this.db.prepare("SELECT * FROM proposals WHERE engagement_id=? ORDER BY created_at").all(engagementId) as any[]).map((row) => ({ id: row.id, engagement_id: row.engagement_id, subject_type: row.subject_type, base_version: row.base_version, status: row.status, content_hash: row.content_hash, content: JSON.parse(row.body) })); }
  admitProposal(id: string, policyDigest: string, options: { expectedBaseVersion?: number; validate?: (content: CanonicalRecord) => string | undefined } = {}): AdmissionResult {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id) as any;
    if (!row) throw new Error(`proposal not found: ${id}`);
    const proposal: Proposal = { id: row.id, engagement_id: row.engagement_id, subject_type: row.subject_type, base_version: row.base_version, status: row.status, content_hash: row.content_hash, content: JSON.parse(row.body) };
    const current = this.db.prepare("SELECT version FROM records WHERE id=?").get(proposal.content.id) as { version?: number } | undefined;
    const currentVersion = current?.version ?? 0;
    if (options.expectedBaseVersion !== undefined && options.expectedBaseVersion !== currentVersion) return this.rejectProposal(proposal, "base version mismatch");
    if (proposal.base_version !== currentVersion) return this.rejectProposal(proposal, "proposal base version is stale");
    const reason = options.validate?.(proposal.content);
    if (reason) return this.rejectProposal(proposal, reason);
    const record = this.commit({ ...proposal.content, policy_digest: policyDigest }, "L1");
    this.db.prepare("UPDATE proposals SET status='admitted' WHERE id=?").run(id);
    return { ok: true, proposal: { ...proposal, status: "admitted" }, record };
  }
  private rejectProposal(proposal: Proposal, reason: string): AdmissionResult {
    this.db.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(proposal.id);
    return { ok: false, reason, proposal: { ...proposal, status: "rejected" } };
  }

  claimWorkRun(input: { run_id?: string; work_item_id: string; engagement_id: string; host_id: string; agent_id: string; ttl_ms?: number }): Record<string, unknown> {
    const runId = input.run_id ?? uuidv7(); const now = new Date(); const expiry = new Date(now.getTime() + (input.ttl_ms ?? 60_000)).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT generation,status,lease_expires_at FROM work_runs WHERE run_id=?").get(runId) as any;
      if (prior && prior.status === "running" && prior.lease_expires_at > now.toISOString()) throw new Error("work run lease is still active");
      const generation = Number(prior?.generation ?? 0) + 1;
      const body = { run_id: runId, work_item_id: input.work_item_id, engagement_id: input.engagement_id, status: "running", owner: { host_id: input.host_id, agent_id: input.agent_id }, generation, lease_expires_at: expiry, heartbeat_at: now.toISOString(), read_seq: Number((this.db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as any).seq) };
      this.db.prepare("INSERT INTO work_runs(run_id,work_item_id,engagement_id,status,owner_host,owner_agent,generation,lease_expires_at,heartbeat_at,read_seq,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,owner_host=excluded.owner_host,owner_agent=excluded.owner_agent,generation=excluded.generation,lease_expires_at=excluded.lease_expires_at,heartbeat_at=excluded.heartbeat_at,read_seq=excluded.read_seq,body=excluded.body,updated_at=excluded.updated_at").run(runId, input.work_item_id, input.engagement_id, "running", input.host_id, input.agent_id, generation, expiry, now.toISOString(), body.read_seq, json(body), now.toISOString(), now.toISOString());
      this.nextEvent("work_run.claim", { generation, host_id: input.host_id, agent_id: input.agent_id }, runId);
      this.db.exec("COMMIT"); return body;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  commitCheckpoint(runId: string, generation: number, hostId: string, checkpoint: Record<string, unknown>): Record<string, unknown> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
      if (!row || row.owner_host !== hostId || Number(row.generation) !== generation || row.lease_expires_at <= new Date().toISOString()) throw new Error("invalid or expired work run lease");
      const checkpointId = uuidv7(); const saved = { ...checkpoint, checkpoint_id: checkpointId, run_id: runId, generation, base_read_seq: row.read_seq };
      this.db.prepare("INSERT INTO checkpoints(checkpoint_id,run_id,generation,body,created_at) VALUES(?,?,?,?,?)").run(checkpointId, runId, generation, json(saved), new Date().toISOString());
      const body = { ...JSON.parse(row.body), checkpoint_id: checkpointId, status: "checkpointed" };
      this.db.prepare("UPDATE work_runs SET status='checkpointed',checkpoint_id=?,body=?,updated_at=? WHERE run_id=?").run(checkpointId, json(body), new Date().toISOString(), runId);
      this.nextEvent("work_run.checkpoint", { checkpoint_id: checkpointId, generation }, runId);
      this.db.exec("COMMIT"); return saved;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getWorkRun(runId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT body FROM work_runs WHERE run_id=?").get(runId) as { body?: string } | undefined;
    return row ? JSON.parse(row.body!) : undefined;
  }
  recordActionIntent(input: { action_id?: string; run_id: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; host_decision_ref?: string; status: "recommended" | "authorized" | "denied" | "executed" | "failed" | "unknown"; result_ref?: string }): Record<string, unknown> {
    const run = this.db.prepare("SELECT generation FROM work_runs WHERE run_id=?").get(input.run_id) as { generation?: number } | undefined;
    if (!run || Number(run.generation) !== input.generation) throw new Error("stale action intent generation");
    const actionId = input.action_id ?? uuidv7(); const body = { ...input, action_id: actionId, recorded_at: new Date().toISOString() };
    this.db.exec("BEGIN IMMEDIATE");
    try { this.db.prepare("INSERT INTO action_intents(action_id,run_id,generation,status,body,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET status=excluded.status,body=excluded.body,updated_at=excluded.updated_at").run(actionId, input.run_id, input.generation, input.status, json(body), new Date().toISOString()); this.nextEvent("action_intent.host_result", { mode: input.mode, status: input.status, host_decision_ref: input.host_decision_ref, result_ref: input.result_ref }, actionId); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return body;
  }
  pendingActionIntents(runId: string): Array<Record<string, unknown>> {
    return (this.db.prepare("SELECT body FROM action_intents WHERE run_id=? AND status IN ('unknown','authorized')").all(runId) as Array<{body:string}>).map((row) => JSON.parse(row.body));
  }
  resumePacket(runId: string, hostId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM work_runs WHERE run_id=?").get(runId) as any;
    if (!row) throw new Error("work run not found");
    if (row.owner_host !== hostId) throw new Error("host does not own work run");
    const checkpoint = row.checkpoint_id ? JSON.parse((this.db.prepare("SELECT body FROM checkpoints WHERE checkpoint_id=?").get(row.checkpoint_id) as any).body) : null;
    return { run: JSON.parse(row.body), checkpoint, pending_actions: this.pendingActionIntents(runId), current_read_seq: Number((this.db.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get() as any).seq) };
  }
  recordLateResult(input: { run_id: string; generation: number; result_ref: string; result: Record<string, unknown> }): Record<string, unknown> {
    const late = { late_result_id: uuidv7(), ...input, status: "late_result_quarantine", recorded_at: new Date().toISOString() };
    this.db.prepare("INSERT INTO action_intents(action_id,run_id,generation,status,body,updated_at) VALUES(?,?,?,?,?,?)").run(late.late_result_id, input.run_id, input.generation, late.status, json(late), new Date().toISOString());
    return late;
  }
  submitReview(input: { id?: string; proposal_id: string; reviewer_id: string; reviewer_kind: "deterministic" | "model" | "reviewer"; input_hash: string; verdict: "pass" | "reject" | "needs_evidence" | "defer"; policy_digest?: string }): { id: string; accepted: boolean; reason?: string } {
    const proposalRow = this.db.prepare("SELECT * FROM proposals WHERE id=?").get(input.proposal_id) as any;
    if (!proposalRow) throw new Error("proposal not found");
    const proposal: Proposal = { id: proposalRow.id, engagement_id: proposalRow.engagement_id, subject_type: proposalRow.subject_type, base_version: proposalRow.base_version, status: proposalRow.status, content_hash: proposalRow.content_hash, content: JSON.parse(proposalRow.body) };
    if (input.input_hash !== proposal.content_hash) return { id: input.id ?? uuidv7(), accepted: false, reason: "review input hash mismatch" };
    const author = String((proposal.content.provenance as any)?.producer_id ?? "");
    if (input.reviewer_kind === "reviewer" && input.reviewer_id === author) return { id: input.id ?? uuidv7(), accepted: false, reason: "reviewer is proposal author" };
    const id = input.id ?? uuidv7();
    this.db.prepare("INSERT INTO reviews(id,proposal_id,reviewer_id,reviewer_kind,input_hash,verdict,body,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, input.proposal_id, input.reviewer_id, input.reviewer_kind, input.input_hash, input.verdict, json(input), new Date().toISOString());
    return { id, accepted: true };
  }
  promoteFinding(proposalId: string, input: { expectedBaseVersion: number; policyDigest: string }): AdmissionResult {
    const proposalRow = this.db.prepare("SELECT * FROM proposals WHERE id=?").get(proposalId) as any;
    if (!proposalRow) throw new Error("proposal not found");
    const proposal: Proposal = { id: proposalRow.id, engagement_id: proposalRow.engagement_id, subject_type: proposalRow.subject_type, base_version: proposalRow.base_version, status: proposalRow.status, content_hash: proposalRow.content_hash, content: JSON.parse(proposalRow.body) };
    if (proposal.subject_type !== "finding") return this.rejectProposal(proposal, "proposal is not a finding");
    if (proposal.base_version !== input.expectedBaseVersion) return this.rejectProposal(proposal, "base version mismatch");
    const currentVersion = (this.db.prepare("SELECT version FROM records WHERE id=?").get(proposal.content.id) as { version?: number } | undefined)?.version ?? 0;
    if (currentVersion !== input.expectedBaseVersion) return this.rejectProposal(proposal, "proposal base version is stale");
    if (!Array.isArray(proposal.content.evidence_refs) || proposal.content.evidence_refs.length === 0) return this.rejectProposal(proposal, "finding requires evidence");
    const review = this.db.prepare("SELECT id FROM reviews WHERE proposal_id=? AND reviewer_kind='reviewer' AND verdict='pass' AND input_hash=?").get(proposalId, proposal.content_hash);
    if (!review) return this.rejectProposal(proposal, "independent review missing");
    const record = this.commit({ ...proposal.content, policy_digest: input.policyDigest }, "L2");
    this.db.prepare("UPDATE proposals SET status='admitted' WHERE id=?").run(proposalId);
    return { ok: true, proposal: { ...proposal, status: "admitted" }, record };
  }
  compareAndSet(id: string, expectedVersion: number, patch: Record<string, unknown>, trustLevel?: TrustLevel): CanonicalRecord {
    const current = this.get(id);
    if (!current || current.version !== expectedVersion) throw new Error("version conflict");
    return this.commit({ ...current, ...patch, id, engagement_id: current.engagement_id }, trustLevel ?? (current.trust_level ?? "L1"), `cas:${id}:${expectedVersion}:${hash(json(patch))}`);
  }
  markStale(subjectId: string, reason: string): CanonicalRecord {
    const current = this.get(subjectId);
    if (!current) throw new Error(`record not found: ${subjectId}`);
    return this.commit({ ...current, status: "stale", stale_reason: reason }, (current.trust_level as TrustLevel) ?? "L1", `stale:${subjectId}:${current.version}:${reason}`);
  }
  verifyAudit(): { valid: boolean; errors: string[] } {
    const events = this.db.prepare("SELECT * FROM events ORDER BY commit_seq").all() as any[];
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
