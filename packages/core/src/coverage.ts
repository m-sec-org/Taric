import { ContractValidationError } from "./validation.js";
import { uuidv7 } from "./identity.js";
import type { CanonicalRecord, AuthorityStore } from "./store.js";

export type CoverageStatus = "not_tested" | "queued" | "in_progress" | "tested_no_observation" | "positive" | "inconclusive" | "blocked" | "blocked_by_control" | "not_applicable";
export type ControlOutcome = "observed" | "suspected" | "not_observed" | "inconclusive" | "changed";
export type DecisionLayer = "edge" | "network" | "origin" | "unknown";
export type AccessDecision = "allow" | "deny" | "challenge" | "filtered" | "unknown";
export type OriginOutcome = "reached" | "not_reached" | "unknown";

export interface CoverageCell extends CanonicalRecord {
  kind: "coverage"; resource_ref: string; resource_revision_ref?: string; test_category: string;
  counter_evidence_refs?: string[];
  identity_ref?: string; operation?: string; parameter?: string; conditions: string[]; status: CoverageStatus;
  /** Remaining coverage-matrix dimensions. A cell is never merged across these (task 2.1). */
  role?: string; tenant_ref?: string; path?: string; network_condition?: string; method?: string;
  tested_at?: string; limitations: string[]; evidence_refs: string[]; control_observation_ref?: string;
  origin_reached?: boolean | "unknown"; external_result_state?: "ingested" | "pending" | "unavailable";
}
export interface NegativeObservation extends CanonicalRecord {
  kind: "negative_observation"; statement: string; method: string; baseline_ref?: string; control_ref?: string;
  tested_resource_refs: string[]; identity_ref?: string; operation?: string; parameter?: string;
  conditions: string[]; tested_at?: string; evidence_refs: string[]; limitations: string[]; bounded: true;
  role?: string; tenant_ref?: string; path?: string; network_condition?: string;
}
export interface ProtectiveControl extends CanonicalRecord { kind: "protective_control"; name: string; control_type?: string; }
export interface ControlObservation extends CanonicalRecord {
  kind: "control_observation"; resource_ref: string; operation: string; conditions: string[]; outcome: ControlOutcome;
  decision_layer: DecisionLayer; origin_reached: boolean | "unknown"; origin_outcome: OriginOutcome;
  evidence_refs: string[]; limitations: string[]; control_ref?: string; identity_ref?: string;
  auth_metadata?: Record<string, string>; network_condition?: string; fingerprint?: string;
}
export interface AccessDecisionObservation extends CanonicalRecord {
  kind: "access_decision_observation"; resource_ref: string; operation: string; conditions: string[];
  decision: AccessDecision; decision_layer: DecisionLayer; origin_reached: boolean | "unknown";
  origin_outcome: OriginOutcome; evidence_refs: string[]; limitations: string[]; control_ref?: string;
  identity_ref?: string; auth_metadata?: Record<string, string>; network_condition?: string;
}
export interface ControlObservationInput {
  engagement_id: string; resource_ref: string; operation: string; conditions: string[]; outcome: ControlOutcome;
  decision_layer: DecisionLayer; origin_reached: boolean | "unknown"; origin_outcome: OriginOutcome;
  evidence_refs: string[]; limitations: string[]; control_ref?: string; identity_ref?: string;
  auth_metadata?: Record<string, string>; network_condition?: string; fingerprint?: string;
}
export interface AccessDecisionObservationInput {
  engagement_id: string; resource_ref: string; operation: string; conditions: string[]; decision: AccessDecision;
  decision_layer: DecisionLayer; origin_reached: boolean | "unknown"; origin_outcome: OriginOutcome;
  evidence_refs: string[]; limitations: string[]; control_ref?: string; identity_ref?: string;
  auth_metadata?: Record<string, string>; network_condition?: string;
}
export interface CoverageGateResult {
  can_close: boolean; action_authorized: false;
  gaps: Array<{ kind: "untested" | "blocked" | "blocked_by_control" | "negative_only" | "unverified_positive" | "conflicting" | "un_ingested_external" | "unjustified_not_applicable" | "contradicted" | "pending_impact" | "pending_revalidation"; cell_ids: string[]; reason: string }>;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ContractValidationError("validation_error", `${name} must be a string array`);
  return value as string[];
}
const safeAuthMetadataKeys = new Set(["scheme", "principal_class", "session_ref", "session_state", "authentication_method"]);
function validateAuthMetadata(value: Record<string, string> | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractValidationError("validation_error", "auth_metadata must contain non-secret metadata");
  for (const [key, item] of Object.entries(value)) {
    if (!safeAuthMetadataKeys.has(key) || typeof item !== "string" || item.length > 256 || /(?:bearer\s+|password\s*[:=]|token\s*[:=]|secret\s*[:=])/i.test(item)) {
      throw new ContractValidationError("validation_error", "auth_metadata must contain non-secret authentication/session metadata only");
    }
  }
}
function assertOriginEvidence(origin_reached: boolean | "unknown", evidence_refs: string[]): void {
  if (origin_reached === true && evidence_refs.length === 0) throw new ContractValidationError("validation_error", "origin_reached=true requires evidence references");
}
function assertLayer(input: { decision_layer: DecisionLayer; control_ref?: string; origin_reached: boolean | "unknown"; origin_outcome: OriginOutcome; outcome?: ControlOutcome; fingerprint?: string }): void {
  if (input.decision_layer === "unknown" && input.control_ref) throw new ContractValidationError("validation_error", "unknown decision layer cannot name a control");
  if (input.decision_layer === "edge" && input.origin_reached === false && input.origin_outcome !== "not_reached") throw new ContractValidationError("validation_error", "edge block before origin must use origin_outcome=not_reached");
  if (input.fingerprint && input.outcome && input.outcome !== "suspected") throw new ContractValidationError("validation_error", "fingerprint attribution is only suspected");
}
export function validateControlObservation(input: ControlObservationInput): void {
  const evidence = stringList(input.evidence_refs, "evidence_refs"); stringList(input.conditions, "conditions");
  if (!input.resource_ref || !input.operation || !input.outcome || !input.origin_outcome) throw new ContractValidationError("validation_error", "control observation requires resource, operation, outcome and origin outcome");
  if (!input.decision_layer || !["edge", "network", "origin", "unknown"].includes(input.decision_layer) || !["observed", "suspected", "not_observed", "inconclusive", "changed"].includes(input.outcome)) throw new ContractValidationError("validation_error", "invalid control observation layer or outcome");
  validateAuthMetadata(input.auth_metadata);
  assertLayer({ decision_layer: input.decision_layer, control_ref: input.control_ref, origin_reached: input.origin_reached, origin_outcome: input.origin_outcome, outcome: input.outcome, fingerprint: input.fingerprint });
  assertOriginEvidence(input.origin_reached, evidence);
}
export function validateAccessDecisionObservation(input: AccessDecisionObservationInput): void {
  const evidence = stringList(input.evidence_refs, "evidence_refs"); stringList(input.conditions, "conditions");
  if (!input.resource_ref || !input.operation || !input.decision || !input.origin_outcome) throw new ContractValidationError("validation_error", "access decision requires resource, operation, decision and origin outcome");
  if (!input.decision_layer || !["edge", "network", "origin", "unknown"].includes(input.decision_layer) || !["allow", "deny", "challenge", "filtered", "unknown"].includes(input.decision)) throw new ContractValidationError("validation_error", "invalid access decision layer or decision");
  validateAuthMetadata(input.auth_metadata);
  assertLayer({ decision_layer: input.decision_layer, control_ref: input.control_ref, origin_reached: input.origin_reached, origin_outcome: input.origin_outcome });
  assertOriginEvidence(input.origin_reached, evidence);
}
export async function createControlObservation(store: AuthorityStore, input: ControlObservationInput): Promise<ControlObservation> {
  validateControlObservation(input);
  const observation = await store.commit({ ...input, evidence_refs: [...input.evidence_refs], conditions: [...input.conditions], id: uuidv7(), kind: "control_observation" } as CanonicalRecord, "L1") as ControlObservation;
  const control = input.control_ref ? await store.get(input.control_ref) : undefined;
  if (control && ["protective_control", "protective_control_revision", "control_observation", "access_decision_observation"].includes(String(control.kind))) await store.impact(input.control_ref!, { engagement_id: input.engagement_id, limit: 100 });
  return observation;
}
export async function createAccessDecisionObservation(store: AuthorityStore, input: AccessDecisionObservationInput): Promise<AccessDecisionObservation> {
  validateAccessDecisionObservation(input);
  const observation = await store.commit({ ...input, evidence_refs: [...input.evidence_refs], conditions: [...input.conditions], id: uuidv7(), kind: "access_decision_observation" } as CanonicalRecord, "L1") as AccessDecisionObservation;
  const resource = await store.get(input.resource_ref);
  if (resource && ["resource", "resource_revision", "service", "endpoint"].includes(String(resource.kind))) await store.impact(input.resource_ref, { engagement_id: input.engagement_id, limit: 100 });
  return observation;
}
export interface CoverageCellInput {
  engagement_id: string; resource_ref: string; resource_revision_ref?: string; test_category: string;
  identity_ref?: string; operation?: string; parameter?: string; conditions?: string[]; status: CoverageStatus;
  tested_at?: string; limitations: string[]; evidence_refs?: string[]; control_observation_ref?: string;
  origin_reached?: boolean | "unknown"; external_result_state?: "ingested" | "pending" | "unavailable";
  role?: string; tenant_ref?: string; path?: string; network_condition?: string; method?: string;
  /** Reason a cell is genuinely not applicable; blocks its use as an untested excuse. */
  not_applicable_reason?: string;
  /** Counter-evidence that contradicts this cell's outcome (task 2.2). */
  counter_evidence_refs?: string[];
}
export async function createCoverageCell(store: AuthorityStore, input: CoverageCellInput): Promise<CoverageCell> {
  const conditions = [...new Set(stringList(input.conditions ?? [], "conditions"))].sort(); const evidence = stringList(input.evidence_refs ?? [], "evidence_refs");
  const counterEvidence = stringList(input.counter_evidence_refs ?? [], "counter_evidence_refs");
  if (!input.resource_ref || !input.test_category) throw new ContractValidationError("validation_error", "coverage requires resource_ref and test_category");
  if (!["not_tested", "queued", "in_progress", "tested_no_observation", "positive", "inconclusive", "blocked", "blocked_by_control", "not_applicable"].includes(input.status)) throw new ContractValidationError("validation_error", "invalid coverage status");
  if (input.status === "blocked_by_control" && input.origin_reached === true) throw new ContractValidationError("validation_error", "blocked_by_control cannot claim origin_reached=true");
  if (input.status === "blocked_by_control" && !input.control_observation_ref && !input.limitations.length) throw new ContractValidationError("validation_error", "blocked_by_control requires control evidence or limitations");
  // not_applicable must carry a reason; it cannot be used to mask an untested cell.
  if (input.status === "not_applicable" && !input.not_applicable_reason?.trim()) throw new ContractValidationError("validation_error", "not_applicable requires an explicit reason");
  if (input.status !== "not_applicable" && input.not_applicable_reason) throw new ContractValidationError("validation_error", "not_applicable_reason is only valid for a not_applicable cell");
  assertOriginEvidence(input.origin_reached ?? "unknown", evidence);
  return await store.commit({ ...input, tested_at: input.tested_at ?? new Date().toISOString(), conditions, evidence_refs: evidence, counter_evidence_refs: counterEvidence, id: uuidv7(), kind: "coverage" } as CanonicalRecord, "L1") as CoverageCell;
}
export interface NegativeObservationInput {
  engagement_id: string; statement: string; method: string; baseline_ref?: string; control_ref?: string;
  tested_resource_refs: string[]; identity_ref?: string; operation?: string; parameter?: string;
  conditions: string[]; tested_at?: string; evidence_refs: string[]; limitations: string[];
  role?: string; tenant_ref?: string; path?: string; network_condition?: string;
}
export async function createNegativeObservation(store: AuthorityStore, input: NegativeObservationInput): Promise<NegativeObservation> {
  const conditions = [...new Set(stringList(input.conditions, "conditions"))].sort(); const resources = stringList(input.tested_resource_refs, "tested_resource_refs");
  const evidence = stringList(input.evidence_refs, "evidence_refs"); const limitations = stringList(input.limitations, "limitations");
  if (!input.statement || !input.method || resources.length === 0 || conditions.length === 0 || limitations.length === 0 || (!input.baseline_ref && !input.control_ref)) throw new ContractValidationError("validation_error", "negative observations require a bounded method, resource, baseline or control, conditions, and limitations");
  // Scope comes from structured test dimensions, not a keyword heuristic over the claim text.
  return await store.commit({ ...input, tested_at: input.tested_at ?? new Date().toISOString(), conditions, tested_resource_refs: resources, evidence_refs: evidence, limitations, bounded: true, id: uuidv7(), kind: "negative_observation" } as CanonicalRecord, "L1") as NegativeObservation;
}
/**
 * Full coverage-matrix identity (design §9.2). Two cells may only be compared when
 * every dimension matches: resource revision, test category, identity/role/tenant,
 * operation/path/parameter/method, network condition and conditions (task 2.1).
 */
export function coverageDimensions(cell: CoverageCell): string {
  return JSON.stringify([
    cell.resource_ref,
    cell.resource_revision_ref ?? null,
    cell.test_category,
    cell.identity_ref ?? null,
    cell.role ?? null,
    cell.tenant_ref ?? null,
    cell.operation ?? null,
    cell.path ?? null,
    cell.parameter ?? null,
    cell.method ?? null,
    cell.network_condition ?? null,
    [...cell.conditions].sort(),
  ]);
}
function dimensions(cell: CoverageCell): string { return coverageDimensions(cell); }
export function evaluateCoverageGate(cells: CoverageCell[]): CoverageGateResult {
  const gaps: CoverageGateResult["gaps"] = []; const grouped = new Map<string, CoverageCell[]>();
  for (const cell of cells) {
    const key = dimensions(cell); const values = grouped.get(key) ?? []; values.push(cell); grouped.set(key, values);
    if (["not_tested", "queued", "in_progress"].includes(cell.status)) gaps.push({ kind: "untested", cell_ids: [cell.id], reason: "coverage has not completed a test" });
    if (cell.status === "blocked") gaps.push({ kind: "blocked", cell_ids: [cell.id], reason: "test is blocked by a missing premise or scope" });
    if (cell.status === "blocked_by_control") gaps.push({ kind: "blocked_by_control", cell_ids: [cell.id], reason: "edge/control block did not reach the origin" });
    if (cell.status === "tested_no_observation") gaps.push({ kind: "negative_only", cell_ids: [cell.id], reason: "negative-only coverage does not establish a verified positive or close the gap" });
    if (cell.status === "positive" && cell.evidence_refs.length === 0) gaps.push({ kind: "unverified_positive", cell_ids: [cell.id], reason: "positive result is missing evidence" });
    if (cell.status === "not_applicable" && !String(cell.not_applicable_reason ?? "").trim()) gaps.push({ kind: "unjustified_not_applicable", cell_ids: [cell.id], reason: "not_applicable is only valid with an explicit reason" });
    // Counter-evidence makes the cell inconclusive rather than silently closed.
    if ((Array.isArray(cell.counter_evidence_refs) ? cell.counter_evidence_refs : []).length > 0 && cell.status !== "inconclusive") gaps.push({ kind: "contradicted", cell_ids: [cell.id], reason: "cell carries counter-evidence and must be revalidated" });
    if (cell.external_result_state === "pending" || cell.external_result_state === "unavailable") gaps.push({ kind: "un_ingested_external", cell_ids: [cell.id], reason: "external result is not ingested" });
  }
  for (const group of grouped.values()) {
    const statuses = new Set(group.map((cell) => cell.status));
    if (statuses.has("positive") && (statuses.has("tested_no_observation") || statuses.has("inconclusive") || statuses.has("blocked") || statuses.has("blocked_by_control"))) gaps.push({ kind: "conflicting", cell_ids: group.map((cell) => cell.id), reason: "matching dimensions contain conflicting outcomes" });
  }
  return { can_close: gaps.length === 0, action_authorized: false, gaps };
}
export interface CoverageVisibilitySummary {
  pending_impact_count: number;
  revalidation_count: number;
  conflicted_count: number;
  pending_external_results_count: number;
  complete: boolean;
}

export interface CoverageGateSnapshot extends CoverageGateResult {
  engagement_id: string;
  visibility: CoverageVisibilitySummary;
  read_seq: number;
}

export function coverageCloseGate(source: CoverageCell[]): Promise<CoverageGateResult>;
export function coverageCloseGate(source: AuthorityStore, engagementId: string): Promise<CoverageGateSnapshot>;
export async function coverageCloseGate(source: CoverageCell[] | AuthorityStore, engagementId?: string): Promise<CoverageGateResult | CoverageGateSnapshot> {
  if (Array.isArray(source)) return evaluateCoverageGate(source);
  return coverageGateSnapshot(source, engagementId ?? "");
}

export interface CoverageVisibility {
  /** Cells whose state is still moving; they can never be reported as full coverage. */
  pending_external_results: CoverageCell[];
  /** Queued revalidation WorkItems produced by counter-evidence or dependency change. */
  revalidation_queue: Array<{ work_item_id: string; subject_ref: string; status: string }>;
  /** Impact events that have not finished propagating. */
  pending_impact: Array<{ event_id: string; pending_watermark: number; continuation?: string }>;
  /** Cells with conflicting or counter-evidenced outcomes. */
  conflicted: CoverageCell[];
  /** Never true while any pending state exists above. */
  complete: boolean;
}

function coverageVisibilityFromRecords(records: CanonicalRecord[]): CoverageVisibility {
  const cells = records.filter((record) => record.kind === "coverage") as CoverageCell[];
  const pending_external_results = cells.filter((cell) => cell.external_result_state === "pending" || cell.external_result_state === "unavailable");
  const conflicted = cells.filter((cell) => (Array.isArray(cell.counter_evidence_refs) ? cell.counter_evidence_refs : []).length > 0 || cell.status === "inconclusive");
  const revalidation_queue = records
    .filter((record) => record.kind === "work_item" && String(record.status ?? "queued") === "queued" && typeof record.related_entity_ref === "string")
    .map((record) => ({ work_item_id: record.id, subject_ref: String(record.related_entity_ref), status: String(record.status ?? "queued") }));
  const pending_impact = records
    .filter((record) => record.kind === "impact_event" && typeof record.continuation === "string")
    .map((record) => ({ event_id: record.id, pending_watermark: Number(record.pending_watermark ?? 0), continuation: String(record.continuation) }));
  return {
    pending_external_results,
    revalidation_queue,
    pending_impact,
    conflicted,
    complete: pending_external_results.length === 0 && revalidation_queue.length === 0 && pending_impact.length === 0 && conflicted.length === 0,
  };
}

function addVisibilityGaps(result: CoverageGateResult, visibility: CoverageVisibility): CoverageGateResult {
  if (visibility.pending_impact.length > 0) result.gaps.push({ kind: "pending_impact", cell_ids: [], reason: "impact propagation is incomplete; pending watermark remains visible" });
  if (visibility.revalidation_queue.length > 0) result.gaps.push({ kind: "pending_revalidation", cell_ids: [], reason: "revalidation work remains queued" });
  if (visibility.conflicted.length > 0) result.gaps.push({ kind: "conflicting", cell_ids: visibility.conflicted.map((cell) => cell.id), reason: "contradicted or inconclusive coverage remains unresolved" });
  result.can_close = result.gaps.length === 0;
  return result;
}

function summarizeCoverageVisibility(visibility: CoverageVisibility): CoverageVisibilitySummary {
  return {
    pending_impact_count: visibility.pending_impact.length,
    revalidation_count: visibility.revalidation_queue.length,
    conflicted_count: visibility.conflicted.length,
    pending_external_results_count: visibility.pending_external_results.length,
    complete: visibility.complete,
  };
}

/** Gate decision, operator visibility and watermark from one authority read snapshot. */
export async function coverageGateSnapshot(store: AuthorityStore, engagementId: string): Promise<CoverageGateSnapshot> {
  return store.maintenanceRead(async ({ read_seq }) => {
    const current = (await store.list(engagementId, { includeCandidates: true })).filter((record) => record.kind === "coverage") as CoverageCell[];
    const visibleRecords = await store.list(engagementId, { includeCandidates: true, includeRecalled: true });
    const visibility = coverageVisibilityFromRecords(visibleRecords);
    return {
      ...addVisibilityGaps(evaluateCoverageGate(current), visibility),
      engagement_id: engagementId,
      visibility: summarizeCoverageVisibility(visibility),
      read_seq,
    };
  });
}

/**
 * Report-side visibility (task 2.4). Unfinished impact/revalidation, un-ingested
 * external results and counter-evidence must be visible; a report may only claim
 * complete coverage when none of them exist.
 */
export async function coverageVisibility(store: AuthorityStore, engagementId: string): Promise<CoverageVisibility> {
  // Reports are an operator surface: include recalled current records so stale,
  // contradicted and retracted outcomes remain visible as unresolved history.
  return store.maintenanceRead(async () => coverageVisibilityFromRecords(await store.list(engagementId, { includeCandidates: true, includeRecalled: true })));
}
