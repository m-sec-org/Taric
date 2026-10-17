import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
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
  omitted_count_complete: boolean;
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
  read_stats?: { scanned_rows: number; returned_rows: number; scan_budget: number; continuation: boolean };
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
  constructor(readonly requested_budget: number, readonly minimum_budget: number, unit: "characters" | "authority rows" = "characters") {
    super(unit === "characters"
      ? `context budget is too small; minimum required: ${minimum_budget} characters`
      : `context scan budget is too small; minimum required: ${minimum_budget} authority rows`);
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
  /** Optional stage timings for bounded diagnostics; values contain no record data. */
  diagnostics?: (stage: "snapshot" | "snapshot_hydration" | "snapshot_filter" | "snapshot_sort" | "record_projection" | "ordering" | "cursor_encoding" | "page_projection", elapsedMs: number) => void;
  /** Maximum authority rows fetched for one Context keyset page. */
  scanBudget?: number;
}
interface CursorState {
  v: 2; engagement_id: string; principal_id: string; read_seq: number; budget: number; issued_at: number; expires_at: number;
  include_candidates: boolean; policy_version: string; snapshot_id: string; ordering: string;
  filters: Record<string, unknown>;
  work_item_id: string | null; worker_role: string | null; records?: CanonicalRecord[];
  reviewer_mode: boolean;
  latest_checkpoint_id: string | null;
  delta_ids: string[];
  resume_delta?: ContextResumeSummary;
  /** Time predicates and recalled dependency inclusion are fixed at first page. */
  read_time: string;
  after_id: string;
  after_priority: number;
  after_time: string;
  scan_budget: number;
  page_has_more: boolean;
  read_stats?: { scanned_rows: number; returned_rows: number; scan_budget: number; continuation: boolean };
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
  const isTargetWorkItem = Boolean(workItemId) && record.id === workItemId;
  if (isTargetWorkItem) return 1;
  if (kind === "work_item" || kind === "workitem") return 4;
  if (kind === "checkpoint") return 2;
  if (deltaIds.has(record.id) || coverageGap || ["conflict", "impact_event", "coverage_gap", "delta"].includes(kind)
    || record.status === "stale" || record.stale_reason !== undefined
    || record.coverage_status === "gap" || record.coverage_gap === true) return 3;
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
function encodeCursor(state: CursorState, keyRoot: string, authority: string, diagnostics?: ContextOptions["diagnostics"]): string {
  const started = performance.now();
  const iv = randomBytes(12);
  const { records: _records, ...slim } = state;
  const cipher = createCipheriv("aes-256-gcm", loadAuthorityCursorKey(keyRoot, authority, true), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(slim), "utf8"), cipher.final()]);
  const value = `v2.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  diagnostics?.("cursor_encoding", performance.now() - started);
  return value;
}
function decodeCursor(value: string, keyRoot: string, authority: string): CursorState {
  const [version, ivPart, encryptedPart, tagPart, extra] = value.split(".");
  if (version !== "v2" || !ivPart || !encryptedPart || !tagPart || extra) throw new InvalidCursorError();
  let parsed: Partial<CursorState>;
  try {
    const decipher = createDecipheriv("aes-256-gcm", loadAuthorityCursorKey(keyRoot, authority, false), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedPart, "base64url")), decipher.final()]).toString("utf8")) as Partial<CursorState>;
  } catch {
    throw new InvalidCursorError();
  }
  if (parsed.v !== 2 || !Array.isArray(parsed.delta_ids) || parsed.delta_ids.length > 500
    || !Number.isSafeInteger(parsed.read_seq) || parsed.read_seq! < 0
    || !Number.isSafeInteger(parsed.budget) || parsed.budget! < 1
    || !Number.isSafeInteger(parsed.issued_at) || !Number.isSafeInteger(parsed.expires_at)
    || parsed.expires_at! < parsed.issued_at! || !Number.isFinite(Date.parse(parsed.read_time ?? ""))
    || parsed.records !== undefined || typeof parsed.after_id !== "string"
    || !Number.isSafeInteger(parsed.after_priority) || typeof parsed.after_time !== "string"
    || !Number.isSafeInteger(parsed.scan_budget) || parsed.scan_budget! < 2
    || typeof parsed.page_has_more !== "boolean" || !parsed.filters || typeof parsed.filters !== "object" || Array.isArray(parsed.filters)) throw new InvalidCursorError();
  const state = parsed as CursorState;
  if (Date.now() > state.expires_at) throw new InvalidCursorError("context continuation cursor expired");
  return state;
}
function packPage(state: CursorState, budget: number, keyRoot: string, authority: string, diagnostics?: ContextOptions["diagnostics"]): ContextPack {
  const started = performance.now();
  if (!Array.isArray(state.records)) throw new InvalidCursorError();
  const pending = state.records;
  const deltaIds = new Set(state.delta_ids);
  const recordPriority = (record: CanonicalRecord) => priority(record, state.work_item_id, deltaIds);
  const mandatory = pending.filter((record) => recordPriority(record) <= 1 || record.id === state.latest_checkpoint_id);
  const mandatoryFullCost = mandatory.reduce((total, record) => total + estimate(record), 0);
  const mandatoryItems = new Map(mandatory.map((record) => {
    if (mandatoryFullCost <= budget) return [record.id, record] as const;
    const compact = mandatoryProjection(record);
    return [record.id, estimate(compact) <= budget ? compact : compactProjection(record)] as const;
  }));
  const mandatoryCost = [...mandatoryItems.values()].reduce((total, record) => total + estimate(record), 0);
  if (mandatoryCost > budget) throw new ContextBudgetError(budget, mandatoryCost);
  let used = 0;
  const items: CanonicalRecord[] = [];
  const emitted = new Set<string>();
  let truncated = 0;
  for (const record of pending) {
    const required = mandatoryItems.get(record.id);
    if (required) {
      items.push(required); used += estimate(required); emitted.add(record.id);
      continue;
    }
    const size = estimate(record);
    if (used + size <= budget) { items.push(record); used += size; emitted.add(record.id); continue; }
    const short = truncatedProjection(record);
    if (used + estimate(short) <= budget) { items.push(short); used += estimate(short); truncated++; emitted.add(record.id); }
    else if (items.length === 0) {
      const compact = compactProjection(record);
      if (estimate(compact) > budget) throw new ContextBudgetError(budget, estimate(compact));
      items.push(compact); used += estimate(compact); truncated++; emitted.add(record.id);
    }
    break;
  }
  let nextOffset = 0;
  for (const record of pending) { if (!emitted.has(record.id)) break; nextOffset++; }
  const remainingInPage = pending.length - nextOffset;
  const omittedCount = remainingInPage + (state.page_has_more ? 1 : 0);
  const exhausted = remainingInPage === 0 && !state.page_has_more;
  const lastEmitted = pending[nextOffset - 1];
  const cursor = exhausted || !lastEmitted ? undefined : encodeCursor({
    ...state,
    records: undefined,
    after_id: lastEmitted.id,
    after_priority: recordPriority(lastEmitted),
    after_time: lastEmitted.kind === "checkpoint" ? String(lastEmitted.updated_at ?? lastEmitted.created_at ?? "") : ""
  }, keyRoot, authority, diagnostics);
  used = items.reduce((total, item) => total + estimate(item), 0);
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
  const result: ContextPack = {
    context_snapshot_id: state.snapshot_id, read_seq: state.read_seq, schema_version: "1.0.0", adapter_version: "adapter/1.0", budget, budget_unit: "characters", used,
    builder_version: BUILDER_VERSION, policy_version: state.policy_version, items, omitted_count: omittedCount, omitted_count_complete: !state.page_has_more,
    omitted_as_unexamined: omittedCount > 0,
    omitted_ranges: omittedCount ? [{ after_id: lastEmitted?.id, before_id: pending[nextOffset]?.id, count: omittedCount }] : [],
    mandatory_ids: mandatory.map((item) => item.id), truncated_count: truncated,
    mandatory_constraints: mandatory.map((item) => ({ id: item.id, display_id: typeof item.display_id === "string" ? item.display_id : undefined, constraints: mandatoryProjection(item) })),
    cursor, sources: items.map((item) => item.id), manifest: sourceRecords, ordering: state.ordering,
    work_item_id: state.work_item_id ?? undefined, worker_role: state.worker_role ?? undefined,
    latest_checkpoint_id: state.latest_checkpoint_id ?? undefined,
    token_estimator_version: "characters/json-length/1",
    permission_scope: `${state.principal_id}@${state.engagement_id}`,
    resume_delta: state.resume_delta,
    read_stats: state.read_stats ? { ...state.read_stats, continuation: Boolean(cursor) } : undefined
  };
  diagnostics?.("page_projection", performance.now() - started);
  return result;
}

export async function buildContextPack(store: AuthorityStore, engagementId: string, budget: number, options: ContextOptions = {}): Promise<ContextPack> {
  await store.ready;
  const requestedBudget = options.characterBudget ?? budget;
  if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 1) throw new ContractValidationError("validation_error", "character budget must be a positive integer");
  const principalId = options.principalId ?? "local";
  const keyRoot = cursorRoot(store, options.cursorKeyRoot);
  const authority = store.authorityId;
  const scanBudget = options.scanBudget ?? 256;
  if (!Number.isSafeInteger(scanBudget) || scanBudget < 2 || scanBudget > 1000) throw new ContractValidationError("validation_error", "context scan budget must be between 2 and 1000");
  if (options.cursor) {
    const state = decodeCursor(options.cursor, keyRoot, authority);
    if (state.engagement_id !== engagementId || state.principal_id !== principalId || state.include_candidates !== Boolean(options.includeCandidates) || state.policy_version !== (options.policyVersion ?? "policy/1")) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if ((options.workItemId ?? null) !== state.work_item_id || (options.workerRole ?? null) !== state.worker_role) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (Boolean(options.reviewerMode) !== state.reviewer_mode) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (options.ordering !== undefined && options.ordering !== state.ordering) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (JSON.stringify(canonical(options.filters ?? {})) !== JSON.stringify(canonical(state.filters))) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (options.readSeq !== undefined && options.readSeq !== state.read_seq) throw new InvalidCursorError("context continuation cursor binding mismatch");
    if (options.scanBudget !== undefined && scanBudget !== state.scan_budget) throw new InvalidCursorError("context continuation cursor scan budget mismatch");
    if (requestedBudget !== state.budget) throw new InvalidCursorError("context continuation cursor budget mismatch");
    const snapshotStarted = performance.now();
    const page = await store.contextRecordsPage({
      engagement_id: engagementId, after_id: state.after_id, after_priority: state.after_priority, after_time: state.after_time,
      page_size: state.scan_budget - 1, as_of: state.read_seq, read_time: state.read_time,
      include_candidates: state.include_candidates, reviewer_mode: state.reviewer_mode,
      work_item_id: state.work_item_id ?? undefined, delta_ids: state.delta_ids, filters: state.filters
    });
    options.diagnostics?.("snapshot", performance.now() - snapshotStarted);
    if (page.read_seq !== state.read_seq || page.read_time !== state.read_time) throw new InvalidCursorError("context continuation read point mismatch");
    const projectionStarted = performance.now();
    const projected = contextRecords(page.records, state);
    options.diagnostics?.("record_projection", performance.now() - projectionStarted);
    state.records = projected;
    options.diagnostics?.("ordering", 0);
    state.page_has_more = page.has_more;
    if (!state.latest_checkpoint_id) state.latest_checkpoint_id = state.records.find((record) => record.kind === "checkpoint")?.id ?? null;
    state.read_stats = { scanned_rows: page.scanned_rows, returned_rows: page.returned_rows, scan_budget: state.scan_budget, continuation: page.has_more };
    return packPage(state, requestedBudget, keyRoot, authority, options.diagnostics);
  }
  if (options.cursorTtlMs !== undefined && (!Number.isSafeInteger(options.cursorTtlMs) || options.cursorTtlMs < 1)) throw new ContractValidationError("validation_error", "cursor ttl must be a positive integer");
  const selection = { include_candidates: Boolean(options.includeCandidates), reviewer_mode: Boolean(options.reviewerMode), filters: options.filters ?? {} };
  const resumeFromSeq = options.resumeFromSeq ?? (typeof options.checkpoint?.source_read_seq === "number" ? options.checkpoint.source_read_seq : undefined);
  let readSeq = options.readSeq;
  let readTime: string | undefined;
  let resumeDelta: ResumeContextDelta | undefined;
  if (resumeFromSeq !== undefined) {
    const point = await store.contextRecordsPage({ engagement_id: engagementId, page_size: 1, as_of: readSeq });
    readSeq = point.read_seq;
    readTime = point.read_time;
    resumeDelta = await resumeContextDelta(store, engagementId, resumeFromSeq, {
      checkpoint: options.checkpoint, principalId, workItemId: options.workItemId, workerRole: options.workerRole,
      includeCandidates: options.includeCandidates, readSeq, readTime, pendingActions: options.pendingActions,
      scanBudget: Math.min(scanBudget - 1, 500)
    });
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
  const snapshotStarted = performance.now();
  const page = await store.contextRecordsPage({
    engagement_id: engagementId, page_size: scanBudget - 1, as_of: readSeq, read_time: readTime,
    include_candidates: selection.include_candidates, reviewer_mode: selection.reviewer_mode,
    work_item_id: options.workItemId, delta_ids: deltaIds, filters: selection.filters
  });
  options.diagnostics?.("snapshot", performance.now() - snapshotStarted);
  const projectionStarted = performance.now();
  const records = contextRecords(page.records, selection);
  options.diagnostics?.("record_projection", performance.now() - projectionStarted);
  options.diagnostics?.("ordering", 0);
  const latestCheckpointId = records.find((record) => record.kind === "checkpoint")?.id ?? null;
  const issuedAt = Date.now();
  const ttl = options.cursorTtlMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || !Number.isSafeInteger(issuedAt + ttl)) throw new ContractValidationError("validation_error", "cursor ttl must be a positive safe integer");
  const state: CursorState = {
    v: 2, engagement_id: engagementId, principal_id: principalId, read_seq: page.read_seq,
    budget: requestedBudget, include_candidates: selection.include_candidates,
    policy_version: options.policyVersion ?? "policy/1", snapshot_id: `ctx_${randomBytes(16).toString("hex")}`,
    ordering: options.ordering ?? "scope,work_item,checkpoint,delta,direct,entity_evidence,background", work_item_id: options.workItemId ?? null,
    filters: structuredClone(options.filters ?? {}),
    worker_role: options.workerRole ?? null, reviewer_mode: selection.reviewer_mode, latest_checkpoint_id: latestCheckpointId, records,
    delta_ids: deltaIds, resume_delta: resumeSummary,
    read_time: page.read_time, after_id: "", after_priority: -1, after_time: "",
    scan_budget: scanBudget, page_has_more: page.has_more,
    read_stats: { scanned_rows: page.scanned_rows, returned_rows: page.returned_rows, scan_budget: scanBudget, continuation: page.has_more },
    issued_at: issuedAt, expires_at: issuedAt + ttl
  };
  return packPage(state, requestedBudget, keyRoot, authority, options.diagnostics);
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
  scanBudget?: number;
}

/** Return only changes after a pinned checkpoint sequence. This is a read-only
 * helper; it never promotes late results or writes a new authority record. */
export async function resumeContextDelta(store: AuthorityStore, engagementId: string, fromReadSeq: number, options: ResumeDeltaOptions = {}): Promise<ResumeContextDelta> {
  if (!Number.isSafeInteger(fromReadSeq) || fromReadSeq < 0) throw new ContractValidationError("validation_error", "from_read_seq must be a non-negative integer");
  const scanBudget = options.scanBudget ?? 500;
  if (!Number.isSafeInteger(scanBudget) || scanBudget < 1 || scanBudget > 500) throw new ContractValidationError("validation_error", "resume scan budget must be between 1 and 500");
  const current = await store.contextRecordsPage({ engagement_id: engagementId, page_size: 1, as_of: options.readSeq, read_time: options.readTime });
  if (fromReadSeq > current.read_seq) throw new ContractValidationError("conflict", "resume delta source sequence is unavailable");
  const beforePoint = await store.contextRecordsPage({ engagement_id: engagementId, page_size: 1, as_of: fromReadSeq });
  const checkpointData = options.checkpoint;
  const checkpointWorkItem = typeof checkpointData?.work_item_ref === "string" ? checkpointData.work_item_ref : options.workItemId;
  const premiseRefs = ["observation_refs", "evidence_refs", "host_decision_refs", "action_refs", "tool_result_refs"]
    .flatMap((field) => Array.isArray(checkpointData?.[field]) ? checkpointData[field] as unknown[] : [])
    .filter((ref): ref is string => typeof ref === "string");
  const referenceIds = [
    ...(typeof checkpointData?.scope_ref === "string" ? [checkpointData.scope_ref] : []),
    ...(checkpointWorkItem ? [checkpointWorkItem] : []),
    ...premiseRefs
  ];
  const changedSubjects = await store.changedRecordSubjects({ engagement_id: engagementId, from_read_seq: fromReadSeq, to_read_seq: current.read_seq, limit: scanBudget });
  if (changedSubjects.has_more) throw new ContextBudgetError(scanBudget, scanBudget + 1, "authority rows");
  const ids = [...new Set([...changedSubjects.ids, ...referenceIds])];
  if (ids.length > scanBudget) throw new ContextBudgetError(scanBudget, ids.length, "authority rows");
  const selected = {
    include_candidates: Boolean(options.includeCandidates), reviewer_mode: Boolean(options.workerRole === "reviewer"),
    filters: {} as Record<string, unknown>
  };
  const beforeById = new Map<string, CanonicalRecord>();
  const afterById = new Map<string, CanonicalRecord>();
  for (const id of ids) {
    const [beforeRecord, afterRecord] = await Promise.all([store.getAt(id, fromReadSeq), store.getAt(id, current.read_seq)]);
    if (beforeRecord?.engagement_id === engagementId) beforeById.set(id, beforeRecord);
    if (afterRecord?.engagement_id === engagementId) afterById.set(id, afterRecord);
  }
  const eligible = (record: CanonicalRecord | undefined, readTime: string): CanonicalRecord | undefined => {
    if (!record || (record.trust_level !== "L2" && !(selected.include_candidates && record.trust_level === "L1"))) return undefined;
    if (selected.reviewer_mode && record.kind === "review") return undefined;
    const status = String(record.status ?? "active");
    if (status !== "stale" && ["retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(status)) return undefined;
    const readAt = Date.parse(readTime);
    if (status !== "stale" && [record.expires_at, record.review_after].some((value) => typeof value === "string" && Date.parse(value) <= readAt)) return undefined;
    return allowedRecord(record);
  };
  const eligibleEventIds = ids.filter((id) =>
    Boolean(eligible(beforeById.get(id), beforePoint.read_time) || eligible(afterById.get(id), current.read_time)));
  const eventRows = await store.eventsForSubjects({
    engagement_id: engagementId, from_read_seq: fromReadSeq, to_read_seq: current.read_seq,
    subject_ids: eligibleEventIds, include_candidates: selected.include_candidates, limit: scanBudget
  });
  if (eventRows.has_more) throw new ContextBudgetError(scanBudget, scanBudget + 1, "authority rows");
  const events = eventRows.events.map((event) => ({
    commit_seq: event.commit_seq, event_id: event.event_id, event_type: event.event_type,
    subject_id: event.subject_id, hash: event.hash
  }));
  const added: CanonicalRecord[] = [];
  const updated: CanonicalRecord[] = [];
  const removed: string[] = [];
  for (const id of changedSubjects.ids) {
    const prior = eligible(beforeById.get(id), beforePoint.read_time);
    const next = eligible(afterById.get(id), current.read_time);
    if (!prior && next) added.push(next);
    else if (prior && !next) removed.push(id);
    else if (prior && next && digest(prior) !== digest(next)) updated.push(next);
  }
  const changedRecordIds = new Set([...added, ...updated].map((record) => record.id));
  const changedSubjectIds = new Set(changedSubjects.ids);
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
  const checkpoint = checkpointData;
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
      if (!currentWorkItem || changedSubjectIds.has(workItemRef)) reasons.push("work_item_changed");
      if (typeof checkpoint.work_item_version === "number" && currentWorkItem?.version !== checkpoint.work_item_version) reasons.push("work_item_version_changed");
      if (typeof checkpoint.target_version === "number" && currentWorkItem?.target_version !== checkpoint.target_version) reasons.push("target_version_changed");
    }
    const premiseRefs = ["observation_refs", "evidence_refs", "host_decision_refs", "action_refs", "tool_result_refs"]
      .flatMap((field) => Array.isArray(checkpoint[field]) ? checkpoint[field] as unknown[] : [])
      .filter((ref): ref is string => typeof ref === "string");
    if (premiseRefs.some((ref) => changedRecordIds.has(ref) || changedSubjectIds.has(ref) || removed.includes(ref))) reasons.push("checkpoint_premise_changed");
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
