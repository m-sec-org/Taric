import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AuthorityStore, CanonicalRecord, TrustLevel } from "./store.js";
import { InvalidCursorError, loadAuthorityCursorKey, rotateAuthorityCursorKey } from "./cursor-key.js";
import { ContractValidationError } from "./validation.js";

const BUILDER_VERSION = "context-builder/1";
const memoryKeyRoots = new WeakMap<AuthorityStore, string>();
function cursorRoot(store: AuthorityStore, configured?: string): string {
  if (configured) return configured;
  if (store.filename === ":postgresql:") throw new ContractValidationError("validation_error", "shared authority cursors require an explicit content root");
  if (store.filename && store.filename !== ":memory:") return join(dirname(store.filename), "content");
  let root = memoryKeyRoots.get(store);
  if (!root) { root = mkdtempSync(join(tmpdir(), "taric-context-")); memoryKeyRoots.set(store, root); }
  return root;
}
/** Rotate the persisted key. Existing cursors become invalid immediately. */
export function rotateContextCursorKey(root: string, authorityId: string): { version: number; key_id: string } { return rotateAuthorityCursorKey(root, authorityId); }
const modelFields = new Set([
  "id", "display_id", "kind", "engagement_id", "trust_level", "version", "status", "title", "name",
  "proposition", "statement", "limitations", "scope", "scope_ref", "resource_ref", "resource_revision_ref",
  "test_category", "identity_ref", "operation", "parameter", "conditions", "evidence_refs", "artifact_refs",
  "updated_at", "created_at", "provenance", "expires_at", "stale_reason", "coverage_status", "decision",
  "outcome", "decision_layer", "origin_reached", "origin_outcome", "control_ref", "control_observation_ref",
  "work_item_ref", "acceptance", "acceptance_criteria", "goal", "goals", "risk_budget", "budget",
  "worker_role", "owner_host", "owner_agent", "run_id", "generation", "host_decision_refs", "external_action_state",
  "draft_ref", "handoff_ref", "next_steps", "completed_steps", "pending_steps", "unresolved", "read_seq"
]);

// Context may carry references and locations, but never the referenced artifact
// body. Keep this list explicit so a newly added authority field cannot become a
// model-facing data leak by accident.
for (const field of [
  "rule_of_engagement", "scope_constraints", "scope_version", "target_version", "work_item_version",
  "conflict_refs", "conflict_ids", "stale_refs", "coverage_gaps", "coverage_gap_refs", "delta_refs",
  "impact_refs", "dependency_refs", "evidence_locations", "evidence_location", "byte_range", "line_range",
  "http_location", "source_hash", "source_revision", "source_time", "source_version", "permission",
  "permission_scope", "slice", "slice_metadata", "locator", "artifact_ref", "artifact_refs", "revision",
  "revision_id", "variant", "variant_id", "applicability", "replan_required", "blocked", "blocked_reason",
  "attempt_ref", "attempt_id", "work_run_ref", "work_run_id", "generation", "base_read_seq", "source_read_seq",
  "external_action_state", "action_refs", "tool_result_refs", "observation_refs", "negative_results",
  "unresolved_work", "budget_consumed", "draft_refs", "handoff_refs"
]) modelFields.add(field);

/** 强制信息优先级：scope/ROE -> WorkItem(目标/验收/风险预算) -> 最近 checkpoint。预算不足时这些必须先进包。 */
const mandatoryFields = ["scope", "scope_ref", "rule_of_engagement", "goal", "goals", "acceptance", "acceptance_criteria", "risk_budget", "budget", "limitations", "next_steps", "completed_steps", "pending_steps", "unresolved"];
export const CONTEXT_MINIMUM_BUDGET = 256;

export interface ContextSource {
  id: string;
  hash: string;
  source_hash?: string;
  version?: number;
  revision?: string | number;
  time?: string;
  trust_level?: TrustLevel;
  slice?: Record<string, unknown>;
  permission?: string;
  source_permission?: string;
  source_kind?: string;
}
export interface ContextPack {
  context_snapshot_id: string;
  read_seq: number;
  schema_version: string;
  adapter_version: string;
  budget: number;
  budget_unit: "characters";
  used: number;
  builder_version: string;
  policy_version: string;
  items: CanonicalRecord[];
  omitted_count: number;
  omitted_as_unexamined: boolean;
  omitted_ranges: Array<{ after_id?: string; before_id?: string; count: number }>;
  mandatory_ids: string[];
  mandatory_constraints: Array<{ id: string; display_id?: string; constraints: CanonicalRecord }>;
  truncated_count: number;
  ordering: string;
  work_item_id?: string;
  worker_role?: string;
  latest_checkpoint_id?: string;
  cursor?: string;
  sources: string[];
  manifest: ContextSource[];
  token_estimator_version?: string;
  permission_scope?: string;
  resume_delta?: ContextResumeSummary;
}
export interface ContextResumeSummary {
  from_read_seq: number;
  to_read_seq: number;
  added_ids: string[];
  updated_ids: string[];
  removed_ids: string[];
  scope_changes: string[];
  dependency_changes: string[];
  pending_actions: string[];
  blocked: boolean;
  replan_required: boolean;
  reasons: string[];
}
export class ContextBudgetError extends Error {
  readonly code = "minimum_budget_required";
  constructor(readonly requested_budget: number, readonly minimum_budget: number) {
    super(`context budget is too small; minimum required: ${minimum_budget} characters`);
    this.name = "ContextBudgetError";
  }
}
/** A committed patch must become visible to an as-of query within this bound. */
export const PATCH_TO_QUERY_P95_BUDGET_MS = 2000;
export interface ContextOptions {
  includeCandidates?: boolean;
  principalId?: string;
  workItemId?: string;
  workerRole?: string;
  policyVersion?: string;
  readSeq?: number;
  cursor?: string;
  characterBudget?: number;
  reviewerMode?: boolean;
  ordering?: string;
  cursorTtlMs?: number;
  filters?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  resumeFromSeq?: number;
  pendingActions?: Array<Record<string, unknown>>;
  /** Core passes the configured content root so cursors work after restart. */
  cursorKeyRoot?: string;
}
interface CursorState {
  v: 1; engagement_id: string; principal_id: string; read_seq: number; budget: number; offset: number; issued_at: number; expires_at: number;
  include_candidates: boolean; policy_version: string; snapshot_id: string; ordering: string;
  filters: Record<string, unknown>;
  work_item_id: string | null; worker_role: string | null; delivered: string[]; records?: CanonicalRecord[];
  reviewer_mode: boolean;
  latest_checkpoint_id: string | null;
  delta_ids: string[];
  resume_delta?: ContextResumeSummary;
  /** Time predicates and recalled dependency inclusion are fixed at first page. */
  read_time: string;
  supplemental_ids: string[];
}
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const sensitiveField = /(?:token|secret|credential|private_path|artifact_body|draft_body|raw_artifact|hidden_reasoning|chain_of_thought|host_ref|location|summary|cookie|header|url)/i;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeValue);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !sensitiveField.test(key))
    .map(([key, item]) => [key, safeValue(item)] as const);
  const artifactRef = (value as Record<string, unknown>).content_ref;
  if (typeof artifactRef === "string") {
    const allowed = new Set(["content_ref", "artifact_id", "version", "storage_mode", "content_status", "integrity_status", "payload_kind", "media_type", "byte_length", "chunk_count", "content_hash", "manifest_hash", "captured_at", "stored_at", "provenance_ref", "derived_from", "child_refs"]);
    return Object.fromEntries(entries.filter(([key]) => allowed.has(key)));
  }
  if (Object.prototype.hasOwnProperty.call(value, "host_ref")) return undefined;
  return Object.fromEntries(entries);
}
const estimate = (record: CanonicalRecord) => JSON.stringify(record).length;
function allowedRecord(record: CanonicalRecord): CanonicalRecord | undefined {
  if (record.trust_level === "L0") return undefined;
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => modelFields.has(key)).map(([key, value]) => [key, safeValue(value)]));
  if (record.trust_level === "L1" && typeof fields.provenance !== "object") fields.provenance = safeValue(record.provenance);
  return fields as CanonicalRecord;
}
function priority(record: CanonicalRecord, workItemId: string | null, deltaIds: ReadonlySet<string> = new Set()): number {
  const kind = String(record.kind ?? "");
  const coverageGap = kind === "coverage" && ["not_tested", "queued", "in_progress", "tested_no_observation", "inconclusive", "blocked", "blocked_by_control"].includes(String(record.status));
  if (["engagement", "scope", "rule_of_engagement"].includes(kind)) return 0;
  const isTargetWorkItem = Boolean(workItemId) && (record.id === workItemId || record.work_item_ref === workItemId);
  if (kind === "work_item" || kind === "workitem") return isTargetWorkItem ? 1 : 4;
  if (kind === "checkpoint") return 2;
  if (deltaIds.has(record.id) || coverageGap || ["conflict", "impact_event", "coverage_gap", "delta"].includes(kind)
    || record.status === "stale" || record.stale_reason !== undefined
    || record.coverage_status === "gap" || record.coverage_gap === true) return 3;
  if (isTargetWorkItem) return 2;
  if (["observation", "evidence", "coverage", "control_observation", "access_decision_observation", "finding", "claim", "resource"].includes(kind)) return 4;
  return 5;
}
function orderContextRecords(records: CanonicalRecord[], workItemId: string | null, deltaIds: ReadonlySet<string>): CanonicalRecord[] {
  return records.sort((a, b) => {
    const byPriority = priority(a, workItemId, deltaIds) - priority(b, workItemId, deltaIds);
    if (byPriority) return byPriority;
    if (a.kind === "checkpoint" && b.kind === "checkpoint") {
      const byTime = String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? ""));
      if (byTime) return byTime;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}
async function pinnedRecord(store: AuthorityStore, id: string, sequence: number): Promise<CanonicalRecord | undefined> {
  return await store.getAt(id, sequence);
}
function contextRecords(records: CanonicalRecord[], state: Pick<CursorState, "include_candidates" | "reviewer_mode" | "filters">): CanonicalRecord[] {
  return records.filter((record) => record.trust_level === "L2" || (state.include_candidates && record.trust_level === "L1"))
    .filter((record) => !state.reviewer_mode || record.kind !== "review")
    .filter((record) => Object.entries(state.filters).every(([key, value]) => JSON.stringify(canonical(record[key])) === JSON.stringify(canonical(value))))
    .map(allowedRecord).filter((record): record is CanonicalRecord => Boolean(record));
}
function mandatoryProjection(record: CanonicalRecord): CanonicalRecord {
  const identity = ["id", "display_id", "kind", "engagement_id", "trust_level", "version"];
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => identity.includes(key) || mandatoryFields.includes(key)));
  return fields as CanonicalRecord;
}
/** 单条记录超过整页预算时的截断投影：保留身份与可判读摘要，并显式标记内容被截断。 */
function truncatedProjection(record: CanonicalRecord): CanonicalRecord {
  const identity = ["id", "display_id", "kind", "engagement_id", "trust_level", "version"];
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (identity.includes(key)) { fields[key] = value; continue; }
    if (typeof value === "string") { fields[key] = `${value.slice(0, 120)}…[truncated]`; continue; }
    if (Array.isArray(value)) { fields[key] = value.slice(0, 5); continue; }
    fields[key] = value;
  }
  fields.truncated = true;
  return fields as CanonicalRecord;
}
function compactProjection(record: CanonicalRecord): CanonicalRecord {
  return {
    id: record.id,
    kind: record.kind,
    engagement_id: record.engagement_id,
    ...(record.display_id ? { display_id: record.display_id } : {}),
    ...(record.version !== undefined ? { version: record.version } : {}),
    ...(record.trust_level ? { trust_level: record.trust_level } : {}),
    truncated: true
  } as CanonicalRecord;
}
function encodeCursor(state: CursorState, keyRoot: string, authority: string): string {
  const iv = randomBytes(12);
  const { records: _records, ...slim } = state;
  const cipher = createCipheriv("aes-256-gcm", loadAuthorityCursorKey(keyRoot, authority, true), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(slim), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}
function decodeCursor(value: string, keyRoot: string, authority: string): CursorState {
  const [version, ivPart, encryptedPart, tagPart, extra] = value.split(".");
  if (version !== "v1" || !ivPart || !encryptedPart || !tagPart || extra) throw new InvalidCursorError();
  let parsed: CursorState;
  try {
    const decipher = createDecipheriv("aes-256-gcm", loadAuthorityCursorKey(keyRoot, authority, false), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedPart, "base64url")), decipher.final()]).toString("utf8")) as CursorState;
  } catch {
    throw new InvalidCursorError();
  }
  if (parsed.v !== 1 || !Array.isArray(parsed.delivered) || !Array.isArray(parsed.supplemental_ids) || !Array.isArray(parsed.delta_ids) || !Number.isSafeInteger(parsed.read_seq) || parsed.read_seq < 0 || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || !Number.isSafeInteger(parsed.issued_at) || !Number.isSafeInteger(parsed.expires_at) || parsed.expires_at < parsed.issued_at || !Number.isFinite(Date.parse(parsed.read_time)) || parsed.records !== undefined) throw new InvalidCursorError();
  if (Date.now() > parsed.expires_at) throw new InvalidCursorError("context continuation cursor expired");
  return parsed;
}
function packPage(state: CursorState, offset: number, budget: number, keyRoot: string, authority: string): ContextPack {
  if (!Array.isArray(state.records)) throw new InvalidCursorError();
  const delivered = new Set(state.delivered);
  const pending = state.records.slice(offset);
  const deltaIds = new Set(state.delta_ids);
  const recordPriority = (record: CanonicalRecord) => priority(record, state.work_item_id, deltaIds);
  const isMandatory = (record: CanonicalRecord) => recordPriority(record) <= 1 || record.id === state.latest_checkpoint_id;
  const undelivered = pending.filter((record) => !delivered.has(record.id));
  const mandatory = undelivered.filter(isMandatory);
  const mandatoryFullCost = mandatory.reduce((total, record) => total + estimate(record), 0);
  // 强制约束先按完整记录预留；预算不足时退化为压缩投影，保证 scope/ROE、目标 WorkItem 与 checkpoint 约束不被背景材料挤掉。
  const mandatoryItems = mandatory.map((record) => {
    if (mandatoryFullCost <= budget) return record;
    const compact = mandatoryProjection(record);
    return estimate(compact) <= budget ? compact : compactProjection(record);
  });
  let used = mandatoryItems.reduce((total, record) => total + estimate(record), 0);
  if (used > budget) throw new ContextBudgetError(budget, used);
  const items = [...mandatoryItems];
  const mandatoryIds = new Set(mandatory.map((record) => record.id));
  const background = undelivered.filter((record) => !mandatoryIds.has(record.id));
  const emitted = new Set(mandatoryItems.map((record) => record.id));
  let truncated = 0;
  for (const item of background) {
    const size = estimate(item);
    if (used + size <= budget) { items.push(item); used += size; emitted.add(item.id); continue; }
    const short = truncatedProjection(item);
    if (used + estimate(short) <= budget) { items.push(short); used += estimate(short); truncated++; emitted.add(item.id); }
    else if (items.length === 0 || used === 0) {
      // A single compact identity is still useful when the caller asks for a
      // budget smaller than any valid source record. It makes continuation
      // finite while preserving the explicit truncation marker.
      const compact = compactProjection(item);
      if (estimate(compact) > budget) throw new ContextBudgetError(budget, estimate(compact));
      items.push(compact); used += estimate(compact); truncated++; emitted.add(item.id);
    } else {
      // Leave this record for the next page; it was not examined or emitted.
      break;
    }
    if (used >= budget) {
      // 预算已用尽，后续记录留给下一页，游标停在第一条未消费记录。
      break;
    }
  }
  // 强制约束若因单条超预算被完整截断，仍以压缩投影形式保留可判读摘要。
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (estimate(item) > budget) { const short = truncatedProjection(item); if (estimate(short) <= budget) items[index] = short; }
  }
  used = items.reduce((total, item) => total + estimate(item), 0);
  // 游标按权威顺序推进：仅本页真正输出的记录前进，未装入项留待下一页。
  let nextOffset = offset;
  for (const record of pending) {
    if (!emitted.has(record.id) && !delivered.has(record.id)) break;
    nextOffset++;
  }
  const omittedCount = state.records.length - nextOffset;
  const nextDelivered = [...delivered, ...items.map((item) => item.id)];
  const exhausted = nextOffset >= state.records.length;
  const cursor = exhausted ? undefined : encodeCursor({ ...state, offset: nextOffset, budget, delivered: nextDelivered }, keyRoot, authority);
  const sourceRecords = items.map((item) => ({
    id: item.id,
    hash: digest(item),
    source_hash: typeof item.source_hash === "string" ? item.source_hash : undefined,
    version: item.version,
    revision: typeof item.revision_id === "string" || typeof item.revision_id === "number" ? item.revision_id : item.revision as string | number | undefined,
    time: typeof item.updated_at === "string" ? item.updated_at : typeof item.created_at === "string" ? item.created_at : undefined,
    trust_level: item.trust_level,
    slice: {
      ...((item.slice_metadata && typeof item.slice_metadata === "object" ? item.slice_metadata : {}) as Record<string, unknown>),
      ...(item.byte_range !== undefined ? { byte_range: item.byte_range } : {}),
      ...(item.line_range !== undefined ? { line_range: item.line_range } : {}),
      ...(item.http_location !== undefined ? { http_location: item.http_location } : {}),
      ...(item.evidence_location !== undefined ? { evidence_location: item.evidence_location } : {})
    },
    permission: `${state.principal_id}@${state.engagement_id}`,
    source_permission: typeof item.permission_scope === "string" ? item.permission_scope : typeof item.permission === "string" ? item.permission : undefined,
    source_kind: typeof item.kind === "string" ? item.kind : undefined,
    priority: recordPriority(item)
  }));
  return {
    context_snapshot_id: state.snapshot_id, read_seq: state.read_seq, schema_version: "1.0.0", adapter_version: "adapter/1.0", budget, budget_unit: "characters", used,
    builder_version: BUILDER_VERSION, policy_version: state.policy_version, items, omitted_count: omittedCount,
    omitted_as_unexamined: omittedCount > 0,
    omitted_ranges: omittedCount ? [{ after_id: state.records[nextOffset - 1]?.id, before_id: state.records[nextOffset]?.id, count: omittedCount }] : [],
    mandatory_ids: mandatory.map((item) => item.id), truncated_count: truncated,
    mandatory_constraints: mandatory.map((item) => ({ id: item.id, display_id: typeof item.display_id === "string" ? item.display_id : undefined, constraints: mandatoryProjection(item) })),
    cursor, sources: items.map((item) => item.id), manifest: sourceRecords, ordering: state.ordering,
    work_item_id: state.work_item_id ?? undefined, worker_role: state.worker_role ?? undefined,
    latest_checkpoint_id: state.latest_checkpoint_id ?? undefined,
    token_estimator_version: "characters/json-length/1",
    permission_scope: `${state.principal_id}@${state.engagement_id}`,
    resume_delta: state.resume_delta
  };
}

export async function buildContextPack(store: AuthorityStore, engagementId: string, budget: number, options: ContextOptions = {}): Promise<ContextPack> {
  await store.ready;
  const requestedBudget = options.characterBudget ?? budget;
  if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 1) throw new ContractValidationError("validation_error", "character budget must be a positive integer");
  const principalId = options.principalId ?? "local";
  const keyRoot = cursorRoot(store, options.cursorKeyRoot);
  const authority = store.authorityId;
  if (options.cursor) {
    const state = decodeCursor(options.cursor, keyRoot, authority);
    if (state.engagement_id !== engagementId || state.principal_id !== principalId || state.include_candidates !== Boolean(options.includeCandidates) || state.policy_version !== (options.policyVersion ?? "policy/1")) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if ((options.workItemId ?? null) !== state.work_item_id || (options.workerRole ?? null) !== state.worker_role) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (Boolean(options.reviewerMode) !== state.reviewer_mode) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (options.ordering !== undefined && options.ordering !== state.ordering) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (JSON.stringify(canonical(options.filters ?? {})) !== JSON.stringify(canonical(state.filters))) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (options.readSeq !== undefined && options.readSeq !== state.read_seq) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (requestedBudget !== state.budget) throw new InvalidCursorError("context continuation cursor budget mismatch");
    const snapshot = await store.snapshot(engagementId, { includeCandidates: state.include_candidates, asOf: state.read_seq, readTime: state.read_time });
    const byId = new Map(snapshot.records.map((record) => [record.id, record]));
    for (const id of state.supplemental_ids) {
      const record = await pinnedRecord(store, id, state.read_seq);
      if (record?.engagement_id === engagementId) byId.set(id, record);
    }
    state.records = orderContextRecords(contextRecords([...byId.values()], state), state.work_item_id, new Set(state.delta_ids));
    if (state.offset > state.records.length) throw new InvalidCursorError();
    return packPage(state, state.offset, requestedBudget, keyRoot, authority);
  }
  if (options.cursorTtlMs !== undefined && (!Number.isSafeInteger(options.cursorTtlMs) || options.cursorTtlMs < 1)) throw new ContractValidationError("validation_error", "cursor ttl must be a positive integer");
  const snapshot = await store.snapshot(engagementId, { includeCandidates: options.includeCandidates, asOf: options.readSeq });
  const selection = { include_candidates: Boolean(options.includeCandidates), reviewer_mode: Boolean(options.reviewerMode), filters: options.filters ?? {} };
  let records = orderContextRecords(contextRecords(snapshot.records, selection), options.workItemId ?? null, new Set());
  if (snapshot.read_seq === snapshot.committed_seq) {
    const existing = new Set(records.map((record) => record.id));
    const staleIds = new Set((await store.events())
      .filter((event) => event.commit_seq <= snapshot.read_seq && event.event_type === "record.stale" && event.subject_id)
      .map((event) => event.subject_id!));
    const staleRecords = contextRecords((await Promise.all([...staleIds].filter((id) => !existing.has(id)).map((id) => pinnedRecord(store, id, snapshot.read_seq))))
      .filter((record): record is CanonicalRecord => Boolean(record && record.engagement_id === engagementId && record.status === "stale")), selection);
    records = [...records, ...staleRecords];
  }
  const latestCheckpointId = records.find((record) => record.kind === "checkpoint")?.id ?? null;
  const resumeFromSeq = options.resumeFromSeq ?? (typeof options.checkpoint?.source_read_seq === "number" ? options.checkpoint.source_read_seq : undefined);
  const resumeDelta = resumeFromSeq === undefined ? undefined : await resumeContextDelta(store, engagementId, resumeFromSeq, {
    checkpoint: options.checkpoint,
    principalId,
    workItemId: options.workItemId,
    workerRole: options.workerRole,
    includeCandidates: options.includeCandidates,
    readSeq: snapshot.read_seq,
    readTime: snapshot.read_time,
    pendingActions: options.pendingActions
  });
  if (resumeDelta && snapshot.read_seq === snapshot.committed_seq) {
    const existing = new Set(records.map((record) => record.id));
    const staleDeltaRecords = contextRecords(resumeDelta.updated.filter((record) => !existing.has(record.id)), selection);
    records = [...records, ...staleDeltaRecords];
  }
  const resumeSummary: ContextResumeSummary | undefined = resumeDelta ? {
    from_read_seq: resumeDelta.from_read_seq,
    to_read_seq: resumeDelta.to_read_seq,
    added_ids: resumeDelta.added.map((record) => record.id),
    updated_ids: resumeDelta.updated.map((record) => record.id),
    removed_ids: resumeDelta.removed,
    scope_changes: resumeDelta.scope_changes,
    dependency_changes: resumeDelta.dependency_changes,
    pending_actions: resumeDelta.pending_actions,
    blocked: resumeDelta.blocked,
    replan_required: resumeDelta.replan_required,
    reasons: resumeDelta.reasons
  } : undefined;
  const deltaIds = [...new Set([...(resumeDelta?.added.map((record) => record.id) ?? []), ...(resumeDelta?.updated.map((record) => record.id) ?? [])])];
  const deltaIdSet = new Set(deltaIds);
  orderContextRecords(records, options.workItemId ?? null, deltaIdSet);
  const issuedAt = Date.now();
  const ttl = options.cursorTtlMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || !Number.isSafeInteger(issuedAt + ttl)) throw new ContractValidationError("validation_error", "cursor ttl must be a positive safe integer");
  const snapshotIds = new Set(snapshot.records.map((record) => record.id));
  const state: CursorState = {
    v: 1, engagement_id: engagementId, principal_id: principalId, read_seq: snapshot.read_seq,
    budget: requestedBudget, offset: 0, include_candidates: Boolean(options.includeCandidates),
    policy_version: options.policyVersion ?? "policy/1", snapshot_id: `ctx_${randomBytes(16).toString("hex")}`,
    ordering: options.ordering ?? "scope,work_item,checkpoint,delta,direct,entity_evidence,background", work_item_id: options.workItemId ?? null,
    filters: structuredClone(options.filters ?? {}),
    worker_role: options.workerRole ?? null, reviewer_mode: Boolean(options.reviewerMode), latest_checkpoint_id: latestCheckpointId, delivered: [], records,
    delta_ids: deltaIds, resume_delta: resumeSummary,
    read_time: snapshot.read_time ?? new Date().toISOString(),
    supplemental_ids: records.filter((record) => !snapshotIds.has(record.id)).map((record) => record.id),
    issued_at: issuedAt, expires_at: issuedAt + ttl
  };
  return packPage(state, 0, requestedBudget, keyRoot, authority);
}

export interface ResumeContextDelta {
  engagement_id: string;
  from_read_seq: number;
  to_read_seq: number;
  read_seq: number;
  records: CanonicalRecord[];
  added: CanonicalRecord[];
  updated: CanonicalRecord[];
  removed: string[];
  events: Array<{ commit_seq: number; event_id: string; event_type: string; subject_id?: string; hash: string }>;
  scope_changes: string[];
  dependency_changes: string[];
  pending_actions: string[];
  context_manifest: { context_snapshot_id: string; read_seq: number; builder_version: string; source_ids: string[] };
  blocked: boolean;
  replan_required: boolean;
  reasons: string[];
}

export interface ResumeDeltaOptions {
  checkpoint?: Record<string, unknown>;
  principalId?: string;
  workItemId?: string;
  workerRole?: string;
  includeCandidates?: boolean;
  readSeq?: number;
  readTime?: string;
  pendingActions?: Array<Record<string, unknown>>;
}

/** Return only changes after a pinned checkpoint sequence. This is a read-only
 * helper; it never promotes late results or writes a new authority record. */
export async function resumeContextDelta(store: AuthorityStore, engagementId: string, fromReadSeq: number, options: ResumeDeltaOptions = {}): Promise<ResumeContextDelta> {
  if (!Number.isSafeInteger(fromReadSeq) || fromReadSeq < 0) throw new ContractValidationError("validation_error", "from_read_seq must be a non-negative integer");
  const current = await store.snapshot(engagementId, { includeCandidates: options.includeCandidates, asOf: options.readSeq, readTime: options.readTime });
  if (fromReadSeq > current.read_seq) throw new ContractValidationError("conflict", "resume delta source sequence is unavailable");
  const before = await store.snapshot(engagementId, { asOf: fromReadSeq, includeCandidates: options.includeCandidates });
  const beforeById = new Map(before.records.map((record) => [record.id, record]));
  const afterById = new Map(current.records.map((record) => [record.id, record]));
  const added: CanonicalRecord[] = [];
  const updated: CanonicalRecord[] = [];
  for (const record of current.records) {
    const prior = beforeById.get(record.id);
    if (!prior) added.push(record);
    else if (digest(prior) !== digest(record)) updated.push(record);
  }
  const removed = [...beforeById.keys()].filter((id) => !afterById.has(id));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  const checkpointWorkItem = typeof options.checkpoint?.work_item_ref === "string" ? options.checkpoint.work_item_ref : options.workItemId;
  const relevantEvent = (event: Awaited<ReturnType<AuthorityStore["events"]>>[number]) =>
    (event.subject_id !== undefined && ids.has(event.subject_id))
    || event.payload.engagement_id === engagementId
    || (checkpointWorkItem !== undefined && event.payload.work_item_id === checkpointWorkItem);
  const events = (await store.events()).filter((event) => event.commit_seq > fromReadSeq && event.commit_seq <= current.read_seq && relevantEvent(event))
    .map((event) => ({ commit_seq: event.commit_seq, event_id: event.event_id, event_type: event.event_type, subject_id: event.subject_id, hash: event.hash }));
  const changedRecordIds = new Set([...added, ...updated].map((record) => record.id));
  for (const event of events) {
    if (!event.subject_id || changedRecordIds.has(event.subject_id)) continue;
    const record = await pinnedRecord(store, event.subject_id, current.read_seq);
    if (record?.engagement_id === engagementId && record.trust_level !== "L0") {
      updated.push(record);
      changedRecordIds.add(record.id);
    }
  }
  const changed = [...added, ...updated];
  const scopeKinds = ["scope", "rule_of_engagement", "engagement"];
  const scopeChanges = [
    ...changed.filter((record) => scopeKinds.includes(String(record.kind))).map((record) => record.id),
    ...removed.filter((id) => scopeKinds.includes(String(beforeById.get(id)?.kind)))
  ];
  const dependencyKinds = ["resource", "resource_revision", "relation", "control", "control_observation", "access_decision_observation", "claim", "finding", "coverage", "coverage_gap", "conflict", "impact_event"];
  const dependencyChanges = [
    ...changed.filter((record) => dependencyKinds.includes(String(record.kind)) || record.status === "stale").map((record) => record.id),
    ...removed.filter((id) => dependencyKinds.includes(String(beforeById.get(id)?.kind)))
  ];
  const pendingActions = (options.pendingActions ?? changed.filter((record) => String(record.kind) === "action_intent" && ["recommended", "authorized", "unknown"].includes(String(record.status))))
    .filter((action) => ["recommended", "authorized", "unknown"].includes(String(action.status)))
    .map((action) => String(action.action_id ?? action.id ?? "")).filter(Boolean);
  const reasons: string[] = [];
  const checkpoint = options.checkpoint;
  if (checkpoint) {
    if (typeof checkpoint.engagement_id === "string" && checkpoint.engagement_id !== engagementId) throw new ContractValidationError("authorization_error", "checkpoint engagement binding mismatch");
    const scopeRef = typeof checkpoint.scope_ref === "string" ? checkpoint.scope_ref : undefined;
    if (scopeRef && scopeChanges.includes(scopeRef)) reasons.push("scope_changed");
    if (scopeRef) {
      const currentScope = afterById.get(scopeRef);
      if (!currentScope || (typeof checkpoint.scope_version === "number" && currentScope.version !== checkpoint.scope_version)) reasons.push("scope_version_changed");
    }
    const workItemRef = typeof checkpoint.work_item_ref === "string" ? checkpoint.work_item_ref : options.workItemId;
    if (workItemRef) {
      const currentWorkItem = afterById.get(workItemRef);
      if (!currentWorkItem || changed.some((record) => record.id === workItemRef)) reasons.push("work_item_changed");
      if (typeof checkpoint.work_item_version === "number" && currentWorkItem?.version !== checkpoint.work_item_version) reasons.push("work_item_version_changed");
      if (typeof checkpoint.target_version === "number" && currentWorkItem?.target_version !== checkpoint.target_version) reasons.push("target_version_changed");
    }
    const premiseRefs = ["observation_refs", "evidence_refs", "host_decision_refs", "action_refs", "tool_result_refs"]
      .flatMap((field) => Array.isArray(checkpoint[field]) ? checkpoint[field] as unknown[] : [])
      .filter((ref): ref is string => typeof ref === "string");
    if (premiseRefs.some((ref) => changedRecordIds.has(ref) || removed.includes(ref))) reasons.push("checkpoint_premise_changed");
    if (typeof checkpoint.generation === "number" && typeof checkpoint.attempt_ref !== "string") reasons.push("attempt_attribution_missing");
    if (typeof checkpoint.external_action_state === "string" && checkpoint.external_action_state === "unknown") reasons.push("external_action_unresolved");
  }
  if (scopeChanges.length > 0) reasons.push("scope_or_roe_delta");
  const manifest = {
    context_snapshot_id: `ctx_resume_${randomBytes(16).toString("hex")}`,
    read_seq: current.read_seq,
    builder_version: BUILDER_VERSION,
    source_ids: changed.map((record) => record.id)
  };
  return {
    engagement_id: engagementId, from_read_seq: fromReadSeq, to_read_seq: current.read_seq, read_seq: current.read_seq,
    records: changed, added, updated, removed, events, scope_changes: scopeChanges, dependency_changes: dependencyChanges,
    pending_actions: pendingActions, context_manifest: manifest, blocked: reasons.length > 0, replan_required: reasons.length > 0, reasons: [...new Set(reasons)]
  };
}

export interface ContextCacheEntry {
  key: string;
  engagement_id: string;
  read_seq: number;
  source_ids: string[];
  pack: ContextPack;
  valid?: boolean;
  invalidated_at?: string;
  invalidation_reason?: string;
}

/** Mark a cached pack invalid when its pinned source or authority sequence changes. */
export function invalidateContextCache(cache: ContextCacheEntry, changedSourceIds: Iterable<string> = [], currentReadSeq?: number): ContextCacheEntry {
  const changed = new Set(changedSourceIds);
  const sourceChanged = cache.source_ids.some((id) => changed.has(id));
  const sequenceChanged = currentReadSeq !== undefined && currentReadSeq !== cache.read_seq;
  if (!sourceChanged && !sequenceChanged && cache.valid !== false) return cache;
  return { ...cache, valid: false, invalidated_at: new Date().toISOString(), invalidation_reason: sourceChanged ? "source_changed" : "authority_sequence_changed" };
}

export interface SealedDraft {
  draft_id: string;
  engagement_id: string;
  status: "sealed" | "rebased";
  attempt_ref?: string;
  generation?: number;
  owner?: Record<string, unknown>;
  content: Record<string, unknown>;
  content_hash: string;
  sealed_at: string;
  original_attempt_ref?: string;
  original_generation?: number;
  rebase?: { attempt_ref: string; generation: number; read_seq?: number; rebased_at: string };
}

/** Freeze a private draft while retaining its original Attempt/generation attribution. */
export function sealDraft(input: { draft_id?: string; engagement_id: string; attempt_ref?: string; generation?: number; owner?: Record<string, unknown>; content: Record<string, unknown> }): SealedDraft {
  if (!input.engagement_id || !input.content || typeof input.content !== "object" || Array.isArray(input.content)) throw new ContractValidationError("validation_error", "draft engagement and object content are required");
  if ((input.attempt_ref === undefined) !== (input.generation === undefined) || (input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 0))) throw new ContractValidationError("validation_error", "draft attempt and generation attribution must be complete");
  const sealedAt = new Date().toISOString();
  return {
    draft_id: input.draft_id ?? `draft_${randomBytes(16).toString("hex")}`,
    engagement_id: input.engagement_id, status: "sealed", attempt_ref: input.attempt_ref, generation: input.generation,
    owner: input.owner, content: structuredClone(input.content), content_hash: digest(input.content), sealed_at: sealedAt,
    original_attempt_ref: input.attempt_ref, original_generation: input.generation
  };
}

/** Explicitly rebase a sealed draft. The old attribution remains available for audit. */
export function rebaseDraft(draft: SealedDraft, target: { engagement_id: string; attempt_ref: string; generation: number; read_seq?: number }): SealedDraft {
  if (!draft || draft.status !== "sealed") throw new ContractValidationError("validation_error", "only a sealed draft may be rebased");
  if (draft.engagement_id !== target.engagement_id) throw new ContractValidationError("authorization_error", "draft engagement binding mismatch");
  if (!target.attempt_ref || !Number.isSafeInteger(target.generation) || target.generation < 0 || (target.read_seq !== undefined && (!Number.isSafeInteger(target.read_seq) || target.read_seq < 0))) throw new ContractValidationError("validation_error", "rebase target requires attempt and generation");
  if (draft.original_attempt_ref === target.attempt_ref) throw new ContractValidationError("stale_version", "rebase requires a new Attempt");
  if (draft.original_generation !== undefined && target.generation <= draft.original_generation) throw new ContractValidationError("stale_version", "rebase target generation must be newer");
  if (digest(draft.content) !== draft.content_hash) throw new ContractValidationError("validation_error", "sealed draft integrity check failed");
  const rebasedAt = new Date().toISOString();
  return { ...draft, status: "rebased", attempt_ref: target.attempt_ref, generation: target.generation, content: structuredClone(draft.content), rebase: { attempt_ref: target.attempt_ref, generation: target.generation, read_seq: target.read_seq, rebased_at: rebasedAt } };
}
