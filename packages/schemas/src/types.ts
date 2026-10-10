/**
 * 由 Phase 1 JSON Schema 生成的 TypeScript 类型（tasks 2.5）。
 *
 * 这些类型与 `schemas/v1/core.schema.json` 由同一份定义派生：core.schema.json 是
 * 唯一来源，本文件只做等价的手工投影。schema.test.mjs 会断言两边的必填字段、
 * 枚举取值和合同清单一致，因此修改 schema 时必须同步本文件。

 */
export type Uuid = string;
export type Timestamp = string;
export type Sha256 = string;

export type TrustLevel = "L0" | "L1" | "L2";
export type ActionMode = "llm_recommend" | "authorized_autonomous" | "host_hitl";
export type DecisionLayer = "edge" | "network" | "origin" | "unknown";
export type OriginOutcome = "reached" | "not_reached" | "unknown";
export type OriginReached = boolean | "unknown";
export type SourceKind = "host" | "tool" | "worker" | "reviewer" | "import";

export type RecallStatus = "active" | "draft" | "verified" | "proposed" | "stale" | "retracted" | "superseded" | "archived" | "expired";
export type WorkStatus = "queued" | "claimed" | "in_progress" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled" | "lost";
export type AttemptStatus = "claimed" | "running" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled" | "lost";
export type ActionStatus = "recommended" | "authorized" | "denied" | "executed" | "failed" | "unknown" | "late_result_quarantine";
export type CoverageStatus = "not_tested" | "queued" | "in_progress" | "tested_no_observation" | "positive" | "inconclusive" | "blocked" | "blocked_by_control" | "not_applicable";
export type ControlOutcome = "observed" | "suspected" | "not_observed" | "inconclusive" | "changed" | "passed" | "blocked" | "failed" | "unknown";
export type AccessDecision = "allow" | "deny" | "challenge" | "filtered" | "unknown";
export type Verdict = "pass" | "reject" | "needs_evidence" | "defer";
export type ReviewerKind = "deterministic" | "model" | "reviewer";
export type ProposalStatus = "pending" | "rejected" | "admitted" | "needs_evidence";

export interface ArtifactReference {
  host_ref: string;
  content_hash?: Sha256;
  location?: string;
  media_type?: string;
}

export interface Provenance {
  host_id: string;
  producer_id: string;
  source_kind: SourceKind;
  source_refs?: Uuid[];
  worker_id?: string;
  attempt_ref?: Uuid;
  dispatch_id?: string;
}

export interface RecordBase {
  id: Uuid;
  schema_version: "1.0.0";
  engagement_id: Uuid;
  created_at: Timestamp;
  provenance: Provenance;
}

/** Core writer 维护的字段：调用者不得设置。 */
export interface CoreManagedFields {
  kind?: string;
  version?: number;
  trust_level?: TrustLevel;
  display_id?: string;
  commit_seq?: number;
  policy_digest?: Sha256;
  review_ref?: Uuid;
  recall_excluded?: boolean;
  stale_reason?: string;
  updated_at?: Timestamp;
  superseded_by?: Uuid;
  expires_at?: Timestamp;
  evidence_claimed?: boolean;
}

export interface Budget {
  actions?: number;
  tokens?: number;
  characters?: number;
  duration_seconds?: number;
}

export interface OwnerAttribution {
  host_id: string;
  agent_id: string;
  dispatch_id?: string;
}

export interface AuthMetadata {
  scheme?: string;
  principal_class?: string;
  session_ref?: string;
  session_state?: string;
  authentication_method?: string;
}

export interface ContextManifest {
  context_snapshot_id?: Uuid;
  read_seq?: number;
  budget_unit?: "characters" | "tokens";
  budget?: number;
  builder_version?: string;
  policy_digest?: Sha256;
  adapter_manifest?: Record<string, unknown>;
  sources?: Record<string, unknown>[];
  omitted?: Record<string, unknown>[];
  unexamined?: Record<string, unknown>[];
}

export interface Scope extends RecordBase, CoreManagedFields {
  allowed_targets: string[];
  excluded_targets: string[];
  rules_of_engagement_ref: string;
  valid_from?: Timestamp;
  valid_until?: Timestamp;
  notes?: string;
}

export interface Engagement extends RecordBase, CoreManagedFields {
  name: string;
  scope_ref: Uuid;
  status: "active" | "paused" | "completed" | "archived";
  action_mode?: ActionMode;
}

export interface Resource extends RecordBase, CoreManagedFields {
  /** 记录判别字段，由 Core 固定为 `resource`，不承载资产分类语义。 */
  kind: "resource";
  /** 攻击面资产分类。设计文档 §118 的 host/domain/service/endpoint/route/page/static asset 词汇。 */
  asset_type: "host" | "domain" | "service" | "web_app" | "route" | "endpoint" | "page" | "static_asset" | "workflow" | "dataset" | "feature" | "bundle" | "other";
  identity: Record<string, unknown>;
  revision: number;
  name?: string;
  content_hash?: Sha256;
  artifact_refs?: ArtifactReference[];
  tags?: string[];
}

export interface Observation extends RecordBase, CoreManagedFields {
  resource_ref: Uuid;
  observed_at: Timestamp;
  statement: string;
  artifact_refs: ArtifactReference[];
  limitations?: string[];
  status?: RecallStatus;
}

export interface Relation extends RecordBase, CoreManagedFields {
  from_ref: Uuid;
  predicate: "calls" | "defines" | "reads" | "writes" | "returns" | "belongs_to" | "protects" | "filters" | "authenticates" | "permits" | "denies" | "routes_to" | "depends_on";
  to_ref: Uuid;
  version: number;
  source_observation_refs?: Uuid[];
}

export interface Claim extends RecordBase, CoreManagedFields {
  proposition: string;
  status: "proposed" | "supported" | "contradicted" | "inconclusive" | "stale" | "retracted" | "superseded";
  evidence_refs: Uuid[];
  limitations: string[];
  observation_refs?: Uuid[];
  applicable_scope_ref?: Uuid;
  title?: string;
}

export interface WorkItem extends RecordBase, CoreManagedFields {
  title: string;
  status: WorkStatus;
  acceptance_criteria: string[];
  goal?: string;
  acceptance?: string[];
  depends_on?: Uuid[];
  risk_class?: "informational" | "finding" | "action";
  risk_budget?: Budget;
}

export interface Evidence extends RecordBase, CoreManagedFields {
  artifact_ref: ArtifactReference;
  observed_at: Timestamp;
  limitations: string[];
  resource_ref?: Uuid;
  statement?: string;
}

export interface Finding extends RecordBase, CoreManagedFields {
  title: string;
  claim_refs: Uuid[];
  evidence_refs: Uuid[];
  review_ref: Uuid;
  status: "draft" | "verified" | "retracted" | "stale";
  severity?: "informational" | "low" | "medium" | "high" | "critical";
  limitations?: string[];
  applicable_scope_ref?: Uuid;
}

export interface CoverageCell extends RecordBase, CoreManagedFields {
  resource_ref: Uuid;
  test_category: string;
  status: CoverageStatus;
  limitations: string[];
  resource_revision_ref?: Uuid;
  identity_ref?: Uuid;
  operation?: string;
  parameter?: string;
  conditions?: string[];
  tested_at?: Timestamp;
  evidence_refs?: Uuid[];
  control_observation_ref?: Uuid;
  origin_reached?: OriginReached;
  external_result_state?: "ingested" | "pending" | "unavailable";
}

export interface NegativeObservation extends RecordBase, CoreManagedFields {
  statement: string;
  method: string;
  tested_resource_refs: Uuid[];
  conditions: string[];
  limitations: string[];
  bounded: true;
  baseline_ref?: Uuid;
  control_ref?: Uuid;
  identity_ref?: Uuid;
  operation?: string;
  parameter?: string;
  tested_at?: Timestamp;
  evidence_refs?: Uuid[];
}

export interface Proposal extends RecordBase, CoreManagedFields {
  subject_type: "observation" | "resource" | "relation" | "claim" | "work_item" | "evidence" | "finding" | "coverage" | "checkpoint" | "action_recommendation";
  content_hash: Sha256;
  status: ProposalStatus;
  base_version: number;
  evidence_refs?: Uuid[];
}

export interface Review extends RecordBase, CoreManagedFields {
  proposal_ref: Uuid;
  reviewer_id: string;
  reviewer_kind: ReviewerKind;
  input_hash: Sha256;
  verdict: Verdict;
  policy_digest?: Sha256;
  rubric_hash?: Sha256;
  evidence_snapshot_hash?: Sha256;
  limitations?: string[];
}

export interface ProtectiveControl extends RecordBase, CoreManagedFields {
  name: string;
  layer: DecisionLayer;
  resource_ref: Uuid;
  control_kind?: string;
  control_type?: string;
}

export interface ControlObservation extends RecordBase, CoreManagedFields {
  control_ref: Uuid;
  outcome: ControlOutcome;
  observed_at: Timestamp;
  resource_ref?: Uuid;
  operation?: string;
  conditions?: string[];
  decision_layer?: DecisionLayer;
  origin_reached?: OriginReached;
  origin_outcome?: OriginOutcome;
  evidence_refs?: Uuid[];
  limitations?: string[];
  identity_ref?: Uuid;
  auth_metadata?: AuthMetadata;
  network_condition?: string;
  fingerprint?: string;
}

export interface AccessDecisionObservation extends RecordBase, CoreManagedFields {
  resource_ref: Uuid;
  identity_ref: Uuid;
  operation: string;
  decision: AccessDecision;
  observed_at: Timestamp;
  control_ref?: Uuid;
  conditions?: string[];
  decision_layer?: DecisionLayer;
  origin_reached?: OriginReached;
  origin_outcome?: OriginOutcome;
  evidence_refs?: Uuid[];
  limitations?: string[];
  auth_metadata?: AuthMetadata;
  network_condition?: string;
}

export interface Attempt extends RecordBase, CoreManagedFields {
  work_item_ref: Uuid;
  status: AttemptStatus;
  generation: number;
  work_run_ref?: Uuid;
  owner?: OwnerAttribution;
  lease_expires_at?: Timestamp;
  heartbeat_at?: Timestamp;
  started_at?: Timestamp;
  ended_at?: Timestamp;
}

export interface WorkRun extends RecordBase, CoreManagedFields {
  work_item_ref: Uuid;
  status: WorkStatus;
  generation: number;
  attempt_ref?: Uuid;
  owner?: OwnerAttribution;
  lease_expires_at?: Timestamp;
  heartbeat_at?: Timestamp;
  checkpoint_id?: Uuid;
  read_seq?: number;
  pending_action_refs?: Uuid[];
}

export interface Checkpoint extends RecordBase, CoreManagedFields {
  work_item_ref: Uuid;
  attempt_ref: Uuid;
  generation: number;
  source_read_seq: number;
  completed_steps: string[];
  next_steps: string[];
  observation_refs: Uuid[];
  evidence_refs: Uuid[];
  negative_results: string[];
  unresolved_work: string[];
  host_decision_refs: string[];
  external_action_state: "none" | "pending" | "unknown" | "executed" | "failed" | "blocked";
  work_run_ref?: Uuid;
  scope_ref?: Uuid;
  target_version?: number;
  owner?: OwnerAttribution;
  lease_expires_at?: Timestamp;
  budget?: Budget;
  draft_refs?: Uuid[];
  handoff_refs?: Uuid[];
  context_manifest?: ContextManifest;
}

export interface ActionIntent extends RecordBase, CoreManagedFields {
  target: string;
  method: string;
  status: ActionStatus;
  rationale?: string;
  uncertainty?: string;
  constraints?: string[];
  limitations?: string[];
  memory_refs?: Uuid[];
  evidence_refs?: Uuid[];
  mode?: ActionMode;
  work_run_ref?: Uuid;
  attempt_ref?: Uuid;
  generation?: number;
  owner?: OwnerAttribution;
  host_decision_ref?: string;
  authorization_ref?: string;
  result_ref?: string;
  idempotency_key?: string;
  recorded_at?: Timestamp;
}

export interface AuditEvent {
  event_id: Uuid;
  commit_seq: number;
  event_type: string;
  created_at: Timestamp;
  hash: Sha256;
  subject_id?: Uuid;
  prev_hash?: string | null;
  actor_id?: string;
  host_id?: string;
  worker_id?: string;
  dispatch_id?: string;
  work_item_ref?: Uuid;
  work_run_ref?: Uuid;
  attempt_ref?: Uuid;
  proposal_ref?: Uuid;
  review_ref?: Uuid;
  entity_ref?: Uuid;
  policy_digest?: Sha256;
  input_hash?: Sha256;
  evidence_hash?: Sha256;
  idempotency_key?: string;
  changed_fields?: string[];
  before_hash?: string | null;
  after_hash?: string | null;
  payload?: Record<string, unknown>;
}

export interface ApiSuccess<T = unknown> { ok: true; data: T; request_id?: string }
export interface ApiError { code: string; message: string; follow_up?: string; details?: unknown }
export interface ApiErrorEnvelope { ok: false; error: ApiError }
export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiErrorEnvelope;

/** 合同名 -> 记录类型。Core/CLI/MCP/Pi 都从这一份映射取类型。 */
export interface ContractTypeMap {
  scope: Scope;
  engagement: Engagement;
  resource: Resource;
  observation: Observation;
  relation: Relation;
  claim: Claim;
  workItem: WorkItem;
  evidence: Evidence;
  finding: Finding;
  coverageCell: CoverageCell;
  negativeObservation: NegativeObservation;
  proposal: Proposal;
  review: Review;
  protectiveControl: ProtectiveControl;
  controlObservation: ControlObservation;
  accessDecisionObservation: AccessDecisionObservation;
  attempt: Attempt;
  workRun: WorkRun;
  checkpoint: Checkpoint;
  actionIntent: ActionIntent;
  auditEvent: AuditEvent;
  apiSuccess: ApiSuccess;
  apiError: ApiErrorEnvelope;
}

