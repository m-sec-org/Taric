import { uuidv7 } from "./identity.js";
import type { CanonicalRecord, AuthorityStore } from "./store.js";

export type CoverageStatus = "not_tested" | "queued" | "in_progress" | "tested_no_observation" | "positive" | "inconclusive" | "blocked" | "blocked_by_control" | "not_applicable";
export type ControlOutcome = "observed" | "suspected" | "not_observed" | "inconclusive" | "changed";
export type DecisionLayer = "edge" | "network" | "origin" | "unknown";
export type AccessDecision = "allow" | "deny" | "challenge" | "filtered" | "unknown";
export type OriginOutcome = "reached" | "not_reached" | "unknown";

export interface CoverageCell extends CanonicalRecord {
  kind: "coverage"; resource_ref: string; resource_revision_ref?: string; test_category: string;
  identity_ref?: string; operation?: string; parameter?: string; conditions: string[]; status: CoverageStatus;
  tested_at?: string; limitations: string[]; evidence_refs: string[]; control_observation_ref?: string;
  origin_reached?: boolean | "unknown"; external_result_state?: "ingested" | "pending" | "unavailable";
}
export interface NegativeObservation extends CanonicalRecord {
  kind: "negative_observation"; statement: string; method: string; baseline_ref?: string; control_ref?: string;
  tested_resource_refs: string[]; identity_ref?: string; operation?: string; parameter?: string;
  conditions: string[]; tested_at?: string; evidence_refs: string[]; limitations: string[]; bounded: true;
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
  gaps: Array<{ kind: "untested" | "blocked" | "blocked_by_control" | "negative_only" | "unverified_positive" | "conflicting" | "un_ingested_external"; cell_ids: string[]; reason: string }>;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string array`);
  return value as string[];
}
const safeAuthMetadataKeys = new Set(["scheme", "principal_class", "session_ref", "session_state", "authentication_method"]);
function validateAuthMetadata(value: Record<string, string> | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth_metadata must contain non-secret metadata");
  for (const [key, item] of Object.entries(value)) {
    if (!safeAuthMetadataKeys.has(key) || typeof item !== "string" || item.length > 256 || /(?:bearer\s+|password\s*[:=]|token\s*[:=]|secret\s*[:=])/i.test(item)) {
      throw new Error("auth_metadata must contain non-secret authentication/session metadata only");
    }
  }
}
function assertOriginEvidence(origin_reached: boolean | "unknown", evidence_refs: string[]): void {
  if (origin_reached === true && evidence_refs.length === 0) throw new Error("origin_reached=true requires evidence references");
}
function assertLayer(input: { decision_layer: DecisionLayer; control_ref?: string; origin_reached: boolean | "unknown"; origin_outcome: OriginOutcome; outcome?: ControlOutcome; fingerprint?: string }): void {
  if (input.decision_layer === "unknown" && input.control_ref) throw new Error("unknown decision layer cannot name a control");
  if (input.decision_layer === "edge" && input.origin_reached === false && input.origin_outcome !== "not_reached") throw new Error("edge block before origin must use origin_outcome=not_reached");
  if (input.fingerprint && input.outcome && input.outcome !== "suspected") throw new Error("fingerprint attribution is only suspected");
}
export function validateControlObservation(input: ControlObservationInput): void {
  const evidence = stringList(input.evidence_refs, "evidence_refs"); stringList(input.conditions, "conditions");
  if (!input.resource_ref || !input.operation || !input.outcome || !input.origin_outcome) throw new Error("control observation requires resource, operation, outcome and origin outcome");
  if (!input.decision_layer || !["edge", "network", "origin", "unknown"].includes(input.decision_layer) || !["observed", "suspected", "not_observed", "inconclusive", "changed"].includes(input.outcome)) throw new Error("invalid control observation layer or outcome");
  validateAuthMetadata(input.auth_metadata);
  assertLayer({ decision_layer: input.decision_layer, control_ref: input.control_ref, origin_reached: input.origin_reached, origin_outcome: input.origin_outcome, outcome: input.outcome, fingerprint: input.fingerprint });
  assertOriginEvidence(input.origin_reached, evidence);
}
export function validateAccessDecisionObservation(input: AccessDecisionObservationInput): void {
  const evidence = stringList(input.evidence_refs, "evidence_refs"); stringList(input.conditions, "conditions");
  if (!input.resource_ref || !input.operation || !input.decision || !input.origin_outcome) throw new Error("access decision requires resource, operation, decision and origin outcome");
  if (!input.decision_layer || !["edge", "network", "origin", "unknown"].includes(input.decision_layer) || !["allow", "deny", "challenge", "filtered", "unknown"].includes(input.decision)) throw new Error("invalid access decision layer or decision");
  validateAuthMetadata(input.auth_metadata);
  assertLayer({ decision_layer: input.decision_layer, control_ref: input.control_ref, origin_reached: input.origin_reached, origin_outcome: input.origin_outcome });
  assertOriginEvidence(input.origin_reached, evidence);
}
export function createControlObservation(store: AuthorityStore, input: ControlObservationInput): ControlObservation {
  validateControlObservation(input); return store.commit({ ...input, evidence_refs: [...input.evidence_refs], conditions: [...input.conditions], id: uuidv7(), kind: "control_observation" } as CanonicalRecord, "L1") as ControlObservation;
}
export function createAccessDecisionObservation(store: AuthorityStore, input: AccessDecisionObservationInput): AccessDecisionObservation {
  validateAccessDecisionObservation(input); return store.commit({ ...input, evidence_refs: [...input.evidence_refs], conditions: [...input.conditions], id: uuidv7(), kind: "access_decision_observation" } as CanonicalRecord, "L1") as AccessDecisionObservation;
}
export interface CoverageCellInput {
  engagement_id: string; resource_ref: string; resource_revision_ref?: string; test_category: string;
  identity_ref?: string; operation?: string; parameter?: string; conditions?: string[]; status: CoverageStatus;
  tested_at?: string; limitations: string[]; evidence_refs?: string[]; control_observation_ref?: string;
  origin_reached?: boolean | "unknown"; external_result_state?: "ingested" | "pending" | "unavailable";
}
export function createCoverageCell(store: AuthorityStore, input: CoverageCellInput): CoverageCell {
  const conditions = stringList(input.conditions ?? [], "conditions"); const evidence = stringList(input.evidence_refs ?? [], "evidence_refs");
  if (!input.resource_ref || !input.test_category) throw new Error("coverage requires resource_ref and test_category");
  if (!["not_tested", "queued", "in_progress", "tested_no_observation", "positive", "inconclusive", "blocked", "blocked_by_control", "not_applicable"].includes(input.status)) throw new Error("invalid coverage status");
  if (input.status === "blocked_by_control" && input.origin_reached === true) throw new Error("blocked_by_control cannot claim origin_reached=true");
  if (input.status === "blocked_by_control" && !input.control_observation_ref && !input.limitations.length) throw new Error("blocked_by_control requires control evidence or limitations");
  assertOriginEvidence(input.origin_reached ?? "unknown", evidence);
  return store.commit({ ...input, tested_at: input.tested_at ?? new Date().toISOString(), conditions, evidence_refs: evidence, id: uuidv7(), kind: "coverage" } as CanonicalRecord, "L1") as CoverageCell;
}
export interface NegativeObservationInput {
  engagement_id: string; statement: string; method: string; baseline_ref?: string; control_ref?: string;
  tested_resource_refs: string[]; identity_ref?: string; operation?: string; parameter?: string;
  conditions: string[]; tested_at?: string; evidence_refs: string[]; limitations: string[];
}
export function createNegativeObservation(store: AuthorityStore, input: NegativeObservationInput): NegativeObservation {
  const conditions = stringList(input.conditions, "conditions"); const resources = stringList(input.tested_resource_refs, "tested_resource_refs");
  const evidence = stringList(input.evidence_refs, "evidence_refs"); const limitations = stringList(input.limitations, "limitations");
  if (!input.statement || !input.method || resources.length === 0 || conditions.length === 0 || limitations.length === 0 || (!input.baseline_ref && !input.control_ref)) throw new Error("negative observations require a bounded method, resource, baseline or control, conditions, and limitations");
  // Scope comes from structured test dimensions, not a keyword heuristic over the claim text.
  return store.commit({ ...input, tested_at: input.tested_at ?? new Date().toISOString(), conditions, tested_resource_refs: resources, evidence_refs: evidence, limitations, bounded: true, id: uuidv7(), kind: "negative_observation" } as CanonicalRecord, "L1") as NegativeObservation;
}
function dimensions(cell: CoverageCell): string { return JSON.stringify([cell.resource_ref, cell.resource_revision_ref ?? null, cell.test_category, cell.identity_ref ?? null, cell.operation ?? null, cell.parameter ?? null, cell.conditions]); }
export function evaluateCoverageGate(cells: CoverageCell[]): CoverageGateResult {
  const gaps: CoverageGateResult["gaps"] = []; const grouped = new Map<string, CoverageCell[]>();
  for (const cell of cells) {
    const key = dimensions(cell); const values = grouped.get(key) ?? []; values.push(cell); grouped.set(key, values);
    if (["not_tested", "queued", "in_progress"].includes(cell.status)) gaps.push({ kind: "untested", cell_ids: [cell.id], reason: "coverage has not completed a test" });
    if (cell.status === "blocked") gaps.push({ kind: "blocked", cell_ids: [cell.id], reason: "test is blocked by a missing premise or scope" });
    if (cell.status === "blocked_by_control") gaps.push({ kind: "blocked_by_control", cell_ids: [cell.id], reason: "edge/control block did not reach the origin" });
    if (cell.status === "tested_no_observation") gaps.push({ kind: "negative_only", cell_ids: [cell.id], reason: "negative-only coverage does not establish a verified positive or close the gap" });
    if (cell.status === "positive" && cell.evidence_refs.length === 0) gaps.push({ kind: "unverified_positive", cell_ids: [cell.id], reason: "positive result is missing evidence" });
    if (cell.external_result_state === "pending" || cell.external_result_state === "unavailable") gaps.push({ kind: "un_ingested_external", cell_ids: [cell.id], reason: "external result is not ingested" });
  }
  for (const group of grouped.values()) {
    const statuses = new Set(group.map((cell) => cell.status));
    if (statuses.has("positive") && (statuses.has("tested_no_observation") || statuses.has("inconclusive") || statuses.has("blocked") || statuses.has("blocked_by_control"))) gaps.push({ kind: "conflicting", cell_ids: group.map((cell) => cell.id), reason: "matching dimensions contain conflicting outcomes" });
  }
  return { can_close: gaps.length === 0, action_authorized: false, gaps };
}
export function coverageCloseGate(source: CoverageCell[] | AuthorityStore, engagementId?: string): CoverageGateResult {
  const cells = Array.isArray(source) ? source : source.list(engagementId ?? "", { includeCandidates: true }).filter((record) => record.kind === "coverage") as CoverageCell[];
  return evaluateCoverageGate(cells);
}
