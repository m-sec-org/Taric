import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthorityStore, CanonicalRecord, TrustLevel } from "./store.js";

const BUILDER_VERSION = "context-builder/1";
const cursorSecret = randomBytes(32);
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

/** 强制信息优先级：scope/ROE -> WorkItem(目标/验收/风险预算) -> 最近 checkpoint。预算不足时这些必须先进包。 */
const mandatoryFields = ["scope", "scope_ref", "rule_of_engagement", "goal", "goals", "acceptance", "acceptance_criteria", "risk_budget", "budget", "limitations", "next_steps", "completed_steps", "pending_steps", "unresolved"];
export const CONTEXT_MINIMUM_BUDGET = 256;

export interface ContextSource { id: string; hash: string; version?: number; time?: string; trust_level?: TrustLevel; }
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
}
interface CursorState {
  v: 1; engagement_id: string; principal_id: string; read_seq: number; budget: number; offset: number;
  include_candidates: boolean; policy_version: string; snapshot_id: string; ordering: string;
  work_item_id: string | null; worker_role: string | null; delivered: string[]; records: CanonicalRecord[];
  reviewer_mode: boolean;
  latest_checkpoint_id: string | null;
}
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const estimate = (record: CanonicalRecord) => JSON.stringify(record).length;
function allowedRecord(record: CanonicalRecord): CanonicalRecord | undefined {
  if (record.trust_level === "L0") return undefined;
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => modelFields.has(key)));
  if (record.trust_level === "L1" && typeof fields.provenance !== "object") fields.provenance = record.provenance;
  return fields as CanonicalRecord;
}
function priority(record: CanonicalRecord, workItemId: string | null): number {
  const kind = String(record.kind ?? "");
  if (["engagement", "scope", "rule_of_engagement"].includes(kind)) return 0;
  const isTargetWorkItem = Boolean(workItemId) && (record.id === workItemId || record.work_item_ref === workItemId);
  if (kind === "work_item" || kind === "workitem") return isTargetWorkItem ? 1 : 4;
  if (kind === "checkpoint") return 2;
  if (isTargetWorkItem) return 2;
  if (["observation", "evidence", "coverage", "control_observation", "access_decision_observation", "finding", "claim", "resource"].includes(kind)) return 3;
  return 5;
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
function encodeCursor(state: CursorState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHash("sha256").update(cursorSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
function decodeCursor(value: string): CursorState {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw new Error("invalid context continuation cursor");
  const expected = createHash("sha256").update(cursorSecret).update(payload).digest("base64url");
  const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error("invalid context continuation cursor");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CursorState;
  if (parsed.v !== 1 || !Array.isArray(parsed.records) || !Array.isArray(parsed.delivered) || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error("invalid context continuation cursor");
  return parsed;
}
function packPage(state: CursorState, offset: number, budget: number): ContextPack {
  const delivered = new Set(state.delivered);
  const pending = state.records.slice(offset);
  const isMandatory = (record: CanonicalRecord) => priority(record, state.work_item_id) <= 1 || record.id === state.latest_checkpoint_id;
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
  const cursor = exhausted ? undefined : encodeCursor({ ...state, offset: nextOffset, budget, delivered: nextDelivered });
  const sourceRecords = items.map((item) => ({ id: item.id, hash: digest(item), version: item.version, time: typeof item.updated_at === "string" ? item.updated_at : undefined, trust_level: item.trust_level, priority: priority(item, state.work_item_id) }));
  return {
    context_snapshot_id: state.snapshot_id, read_seq: state.read_seq, schema_version: "1.0.0", adapter_version: "adapter/1.0", budget, budget_unit: "characters", used,
    builder_version: BUILDER_VERSION, policy_version: state.policy_version, items, omitted_count: omittedCount,
    omitted_as_unexamined: omittedCount > 0,
    omitted_ranges: omittedCount ? [{ after_id: state.records[nextOffset - 1]?.id, before_id: state.records[nextOffset]?.id, count: omittedCount }] : [],
    mandatory_ids: mandatory.map((item) => item.id), truncated_count: truncated,
    mandatory_constraints: mandatory.map((item) => ({ id: item.id, display_id: typeof item.display_id === "string" ? item.display_id : undefined, constraints: mandatoryProjection(item) })),
    cursor, sources: items.map((item) => item.id), manifest: sourceRecords, ordering: state.ordering,
    work_item_id: state.work_item_id ?? undefined, worker_role: state.worker_role ?? undefined,
    latest_checkpoint_id: state.latest_checkpoint_id ?? undefined
  };
}

export function buildContextPack(store: AuthorityStore, engagementId: string, budget: number, options: ContextOptions = {}): ContextPack {
  const requestedBudget = options.characterBudget ?? budget;
  if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 1) throw new RangeError("character budget must be a positive integer");
  const principalId = options.principalId ?? "local";
  if (options.cursor) {
    const state = decodeCursor(options.cursor);
    if (state.engagement_id !== engagementId || state.principal_id !== principalId || state.include_candidates !== Boolean(options.includeCandidates) || state.policy_version !== (options.policyVersion ?? "policy/1")) throw new Error("context continuation cursor binding mismatch");
    if ((options.workItemId ?? null) !== state.work_item_id || (options.workerRole ?? null) !== state.worker_role) throw new Error("context continuation cursor binding mismatch");
    if (Boolean(options.reviewerMode) !== state.reviewer_mode) throw new Error("context continuation cursor binding mismatch");
    if (requestedBudget !== state.budget) throw new Error("context continuation cursor budget mismatch");
    return packPage(state, state.offset, requestedBudget);
  }
  const snapshot = store.snapshot(engagementId, { includeCandidates: options.includeCandidates });
  if (options.readSeq !== undefined && options.readSeq !== snapshot.read_seq) throw new Error("requested read_seq is unavailable from the authority snapshot API");
  const records = snapshot.records
    .filter((record) => record.trust_level === "L2" || (options.includeCandidates && record.trust_level === "L1"))
    .filter((record) => !options.reviewerMode || record.kind !== "review")
    .map(allowedRecord).filter((record): record is CanonicalRecord => Boolean(record))
    .sort((a, b) => {
      const byPriority = priority(a, options.workItemId ?? null) - priority(b, options.workItemId ?? null);
      if (byPriority) return byPriority;
      if (a.kind === "checkpoint" && b.kind === "checkpoint") return String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? ""));
      return String(a.id).localeCompare(String(b.id));
    });
  const latestCheckpointId = records.find((record) => record.kind === "checkpoint")?.id ?? null;
  const state: CursorState = {
    v: 1, engagement_id: engagementId, principal_id: principalId, read_seq: snapshot.read_seq,
    budget: requestedBudget, offset: 0, include_candidates: Boolean(options.includeCandidates),
    policy_version: options.policyVersion ?? "policy/1", snapshot_id: `ctx_${randomBytes(16).toString("hex")}`,
    ordering: "scope,work_item,checkpoint,direct,entity_evidence,background", work_item_id: options.workItemId ?? null,
    worker_role: options.workerRole ?? null, reviewer_mode: Boolean(options.reviewerMode), latest_checkpoint_id: latestCheckpointId, delivered: [], records
  };
  return packPage(state, 0, requestedBudget);
}
