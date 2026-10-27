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
export type DependencyCriticality = "low" | "medium" | "high" | "critical";

export interface ArtifactReference {
  host_ref?: string;
  content_hash?: Sha256;
  manifest_hash?: Sha256;
  content_ref?: string;
  artifact_id?: Uuid;
  version?: number;
  storage_mode?: "external" | "taric_stored";
  content_status?: "external" | "staged" | "available" | "unavailable" | "integrity_failed" | "quarantined" | "deleted";
  integrity_status?: "unverified" | "verified" | "mismatch" | "missing";
  payload_kind?: "text" | "binary" | "manifest";
  location?: string;
  media_type?: string;
  charset?: string;
  content_encoding?: string;
  transfer_encoding?: string;
  captured_at?: Timestamp;
  stored_at?: Timestamp;
  summary_ref?: string;
  summary?: string;
  byte_length?: number;
  chunk_count?: number;
  provenance_ref?: Uuid;
  derived_from?: Uuid;
  child_refs?: Uuid[];
}

export interface ArtifactSessionBinding {
  engagement_id: Uuid;
  session_id: string;
  root: string;
  mode: "host-session" | "run-bound";
  work_run_id?: Uuid;
  attempt_id?: Uuid;
  generation?: number;
  owner_host?: string;
  binding_id?: string;
  created_at?: Timestamp;
  manifest_hash?: Sha256;
}

export type ArtifactPayloadKind = "text" | "binary" | "manifest";

export interface ArtifactStoreBegin {
  engagement_id: Uuid;
  session_id: string;
  payload_kind: ArtifactPayloadKind;
  media_type: string;
  storage_mode?: "external" | "taric_stored";
  charset?: string;
  content_encoding?: string;
  transfer_encoding?: string;
  captured_at?: Timestamp;
  summary_ref?: string;
  summary?: string;
  expected_bytes?: number;
  expected_hash?: Sha256;
  category?: string;
  host_ref?: string;
  work_run_id?: Uuid;
  attempt_id?: Uuid;
  generation?: number;
  base_content_ref?: string;
  parent_ref?: string;
  derived_from?: string;
  child_refs?: string[];
  idempotency_key?: string;
}

export interface ArtifactIngestFileRequest extends ArtifactStoreBegin {
  path: string;
  authorize_spool_access: true;
  delete_source?: boolean;
}

export interface ArtifactStoreAppend {
  engagement_id: Uuid;
  session_id: string;
  upload_id: string;
  ordinal: number;
  offset?: number;
  chunk_hash: Sha256;
  data: string;
  encoding?: "base64";
  idempotency_key?: string;
}

export interface ArtifactStoreCommit {
  engagement_id: Uuid;
  session_id: string;
  upload_id: string;
  total_bytes: number;
  chunk_count?: number;
  content_hash: Sha256;
  manifest_hash?: Sha256;
  idempotency_key?: string;
}

export interface ArtifactContentRead {
  engagement_id: Uuid;
  session_id: string;
  content_ref: string;
  offset?: number;
  length?: number;
  chunk_cursor?: string;
  include_content?: boolean;
  max_response_bytes?: number;
}

export interface ArtifactContentList {
  engagement_id: Uuid;
  session_id: string;
  cursor?: string;
  page_size?: number;
  category?: string;
  media_type?: string;
  work_run_id?: Uuid;
  include_content?: boolean;
  max_response_bytes?: number;
}

export interface ArtifactSessionOutput {
  engagement_id: Uuid;
  session_id: string;
  cursor?: string;
  execution_cursor?: string;
  page_size?: number;
  include_content?: boolean;
  max_response_bytes?: number;
  work_run_id?: Uuid;
  attempt_id?: Uuid;
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

export interface ProposalProvenance extends Omit<Provenance, "source_kind"> {
  source_kind: "model" | "worker" | "host" | "tool" | "import";
}
export interface ProposalCandidate {
  schema_version: "1.0.0";
  engagement_id: Uuid;
  kind: string;
  provenance?: ProposalProvenance;
  [key: string]: unknown;
}
export interface ProposalEnvelope {
  engagement_id: Uuid;
  subject_type: string;
  expected_version: number;
  proposal_id?: Uuid;
  client_request_id?: string;
  target_id?: Uuid;
  subject_ref?: Uuid;
  content: ProposalCandidate;
}
export interface PromotionL2 {
  engagement_id: Uuid;
  proposal_id: Uuid;
  target_id: Uuid;
  expected_version: number;
  input_hash: Sha256;
  evidence_snapshot_hash: Sha256;
  policy_digest: Sha256;
  review_refs: Uuid[];
  idempotency_key?: string;
}

export interface ReviewPackRequest {
  engagement_id: Uuid;
  proposal_id: Uuid;
}

export interface ReviewSubmitRequest {
  engagement_id: Uuid;
  proposal_id: Uuid;
  reviewer_id: string;
  reviewer_kind: "reviewer";
  input_hash: Sha256;
  verdict: "pass" | "reject" | "needs_evidence" | "defer";
  policy_digest: Sha256;
  evidence_snapshot_hash?: Sha256;
  rubric_hash?: Sha256;
  limitations?: string[];
  idempotency_key?: string;
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
  policy_version?: string;
  trust_phase?: "proposal" | "machine_approved" | "independently_verified";
  risk_class?: "informational" | "low" | "medium" | "high" | "critical" | "finding" | "action";
  review_refs?: Uuid[];
  review_after?: Timestamp;
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

/** Immutable snapshot of one variant of a stable logical resource. */
export interface ResourceRevision extends RecordBase, CoreManagedFields {
  resource_ref: Uuid;
  revision: number;
  logical_identity: Record<string, unknown>;
  variant: ResourceVariant;
  content_hash: Sha256;
  source_observation_refs: Uuid[];
  observed_at?: Timestamp;
  valid_from: Timestamp;
  valid_until?: Timestamp;
  supersedes?: Uuid;
  raw_refs?: Array<{ object_hash: Sha256; start?: number; end?: number }>;
}

export interface ResourceVariant {
  method?: string;
  path_template?: string;
  parameter_set_hash?: Sha256;
  parameters?: string[];
  content_type?: string;
  principal_ref?: Uuid;
  tenant_ref?: Uuid;
  identity_ref?: Uuid;
  authentication_session_revision_ref?: Uuid;
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
  from_type: "resource" | "resource_revision" | "relation" | "claim" | "test_hypothesis" | "attack_path" | "work_item" | "evidence" | "observation" | "finding" | "coverage" | "protective_control" | "protective_control_revision" | "control_observation" | "access_decision_observation" | "capability";
  predicate: "calls" | "defines" | "reads" | "writes" | "returns" | "belongs_to" | "protects" | "filters" | "authenticates" | "permits" | "denies" | "routes_to" | "depends_on" | "derived_from" | "implements" | "uses" | "supported_by" | "contradicted_by" | "tests";
  to_ref: Uuid;
  to_type: Relation["from_type"];
  version: number;
  source_observation_refs: Uuid[];
  valid_from: Timestamp;
  valid_until?: Timestamp;
  criticality: DependencyCriticality;
  status?: "active" | "disputed" | "stale" | "retracted";
  confidence?: number;
  applicable_scope_ref?: Uuid;
}

export interface TestHypothesis extends RecordBase, CoreManagedFields {
  title: string;
  proposition: string;
  status: "proposed" | "supported" | "contradicted" | "inconclusive" | "stale" | "replan_required" | "retracted" | "superseded";
  version: number;
  source_observation_refs: Uuid[];
  resource_revision_refs?: Uuid[];
  claim_refs?: Uuid[];
  coverage_refs?: Uuid[];
  depends_on?: Uuid[];
  evidence_refs?: Uuid[];
  limitations: string[];
  valid_from: Timestamp;
  valid_until?: Timestamp;
  criticality: DependencyCriticality;
  applicable_scope_ref?: Uuid;
}

export interface AttackPathStep {
  subject_type: "resource_revision" | "relation" | "claim" | "finding" | "capability";
  subject_ref: Uuid;
  label?: string;
}

export interface AttackPath extends RecordBase, CoreManagedFields {
  title: string;
  status: "proposed" | "active" | "stale" | "retracted" | "superseded";
  version: number;
  steps: AttackPathStep[];
  source_observation_refs: Uuid[];
  depends_on?: Uuid[];
  valid_from: Timestamp;
  valid_until?: Timestamp;
  criticality: DependencyCriticality;
  applicable_scope_ref?: Uuid;
}

export interface PatchSetEntry {
  entity_ref: Uuid;
  base_version: number;
  fields?: string[];
}

export interface PatchSet extends RecordBase, CoreManagedFields {
  base_generation: number;
  read_set: Array<{ entity_ref: Uuid; version: number }>;
  write_set: PatchSetEntry[];
  operations: Array<"upsert_resource" | "upsert_relation" | "replace_property" | "add_relation" | "remove_relation" | "revise_claim" | "revise_hypothesis" | "attach_observation">;
  source_refs: Uuid[];
  content_hash: Sha256;
  merge_status: "pending" | "merged" | "conflict";
  host_id?: string;
  agent_id?: string;
  run_id?: Uuid;
}

export interface ConflictCandidate {
  value: unknown;
  source_refs: Uuid[];
  patch_ref?: Uuid;
}

export interface Conflict extends RecordBase, CoreManagedFields {
  subject_ref: Uuid;
  field_path: string;
  base_version: number;
  current_version: number;
  base_value: unknown;
  candidates: ConflictCandidate[];
  diff: Record<string, unknown>;
  source_refs: Uuid[];
  merge_status: "open" | "resolved" | "accepted" | "rejected" | "deferred";
  resolution_ref?: Uuid;
}

export interface ImpactEvent extends RecordBase, CoreManagedFields {
  source_ref: Uuid;
  changed_dependency_ref: Uuid;
  affected_refs: Uuid[];
  criticality: DependencyCriticality;
  disposition: "stale_for_current_use" | "requires_revalidation" | "revoked";
  reason_code: "resource_changed" | "relation_changed" | "claim_withdrawn" | "control_changed" | "policy_changed" | "identity_changed" | "other";
  continuation?: string;
  pending_watermark?: number;
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
  scope_ref?: Uuid;
  target_version?: number;
  status: WorkStatus;
  acceptance_criteria: string[];
  goal?: string;
  acceptance?: string[];
  depends_on?: Uuid[];
  /** Scheduling hint metadata: target resources this work item touches. Never a target-resource lock. */
  resource_refs?: Uuid[];
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
  review_ref?: Uuid;
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
  expected_version: number;
  proposal_id?: Uuid;
  client_request_id?: string;
  target_id?: Uuid;
  subject_ref?: Uuid;
  canonical_id?: Uuid;
  canonical_version?: number;
  content?: ProposalCandidate;
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
  current_revision_ref?: Uuid;
  protected_resource_refs?: Uuid[];
  source_observation_refs?: Uuid[];
  status?: "suspected" | "observed" | "configured" | "changed" | "unknown";
  valid_from?: Timestamp;
  valid_until?: Timestamp;
  control_kind?: string;
  control_type?: string;
}

export interface ProtectiveControlRevision extends RecordBase, CoreManagedFields {
  control_ref: Uuid;
  revision: number;
  layer: DecisionLayer;
  policy_snapshot_hash?: Sha256 | null;
  policy_artifact_ref?: Uuid | null;
  protected_resource_revision_refs: Uuid[];
  identity_conditions: string[];
  network_conditions: string[];
  valid_from: Timestamp;
  valid_until?: Timestamp;
  source_observation_refs: Uuid[];
  supersedes?: Uuid | null;
}

export interface ControlObservation extends RecordBase, CoreManagedFields {
  control_ref?: Uuid | null;
  control_revision_ref?: Uuid | null;
  policy_snapshot_hash?: Sha256 | null;
  outcome: ControlOutcome;
  observed_at: Timestamp;
  resource_ref?: Uuid;
  resource_revision_ref?: Uuid;
  operation?: string;
  conditions?: string[];
  decision_layer?: DecisionLayer;
  origin_reached?: OriginReached;
  origin_outcome?: OriginOutcome;
  evidence_refs?: Uuid[];
  limitations?: string[];
  identity_ref?: Uuid;
  authentication_session_revision_ref?: Uuid | null;
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
  control_ref?: Uuid | null;
  control_revision_refs?: Uuid[];
  policy_snapshot_hashes?: Array<Sha256 | null>;
  resource_revision_ref?: Uuid;
  authentication_session_revision_ref?: Uuid | null;
  tenant_ref?: Uuid;
  conditions?: string[];
  decision_layer?: DecisionLayer;
  origin_reached?: OriginReached;
  origin_outcome?: OriginOutcome;
  evidence_refs?: Uuid[];
  limitations?: string[];
  auth_metadata?: AuthMetadata;
  network_condition?: string;
}

export interface ControlApplicabilityEvent extends RecordBase, CoreManagedFields {
  subject_refs: Uuid[];
  changed_dependency_ref: Uuid;
  previous_policy_hash?: Sha256 | null;
  current_policy_hash?: Sha256 | null;
  affected_current_view_refs: Uuid[];
  disposition: "stale_for_current_use" | "requires_revalidation" | "revoked";
  reason_code: "policy_changed" | "control_changed" | "identity_changed" | "resource_changed" | "other";
  committed_at: Timestamp;
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
  task_session_ref?: string;
  artifact_refs?: ArtifactReference[];
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
  task_session_ref?: string;
  artifact_refs?: ArtifactReference[];
}

export interface Checkpoint extends RecordBase, CoreManagedFields {
  work_item_ref: Uuid;
  work_run_ref: Uuid;
  attempt_ref: Uuid;
  generation: number;
  target_version: number;
  work_item_version: number;
  scope_version: number;
  owner: OwnerAttribution;
  lease_expires_at: Timestamp;
  source_read_seq: number;
  completed_steps: string[];
  next_steps: string[];
  observation_refs: Uuid[];
  evidence_refs: Uuid[];
  negative_results: string[];
  unresolved_work: string[];
  host_decision_refs: string[];
  action_refs: Uuid[];
  tool_result_refs: string[];
  external_action_state: "none" | "pending" | "unknown" | "executed" | "failed" | "blocked";
  scope_ref?: Uuid;
  budget: Budget;
  draft_refs: Uuid[];
  handoff_refs: Uuid[];
  context_manifest: ContextManifest;
  task_session_ref?: string;
  artifact_refs?: ArtifactReference[];
}

export interface ActionIntent extends RecordBase, CoreManagedFields {
  target: string;
  method: string;
  status: ActionStatus;
  rationale?: string;
  scope?: string;
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
export type DiagnosticParameter = string | number | boolean;
export interface DiagnosticViolation {
  instance_path: string;
  keyword: string;
  params?: Readonly<Record<string, DiagnosticParameter>>;
  message: string;
}
export interface ContractDiagnosticDetails {
  kind: "contract";
  contract_name: string;
  violations: readonly DiagnosticViolation[];
}
export interface CompatibilityDiagnosticDetails {
  kind: "compatibility";
  backend: "sqlite" | "postgresql" | "unknown";
  expected: Readonly<Record<string, string>>;
  observed?: Readonly<Record<string, string>>;
  failed_marker?: string;
  missing?: readonly string[];
}
export type ApiErrorDetails = ContractDiagnosticDetails | CompatibilityDiagnosticDetails;
export interface ApiError { code: string; message: string; follow_up?: string; details?: ApiErrorDetails }
export interface ApiErrorEnvelope { ok: false; error: ApiError }
export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiErrorEnvelope;

/** 合同名 -> 记录类型。Core/CLI/MCP/Pi 都从这一份映射取类型。 */
export interface ContractTypeMap {
  scope: Scope;
  engagement: Engagement;
  resource: Resource;
  resourceRevision: ResourceRevision;
  observation: Observation;
  relation: Relation;
  testHypothesis: TestHypothesis;
  attackPath: AttackPath;
  patchSet: PatchSet;
  conflict: Conflict;
  impactEvent: ImpactEvent;
  claim: Claim;
  workItem: WorkItem;
  evidence: Evidence;
  finding: Finding;
  coverageCell: CoverageCell;
  negativeObservation: NegativeObservation;
  proposal: Proposal;
  proposalEnvelope: ProposalEnvelope;
  proposalCandidate: ProposalCandidate;
  proposalProvenance: ProposalProvenance;
  promotionL2: PromotionL2;
  review: Review;
  protectiveControl: ProtectiveControl;
  protectiveControlRevision: ProtectiveControlRevision;
  controlObservation: ControlObservation;
  accessDecisionObservation: AccessDecisionObservation;
  controlApplicabilityEvent: ControlApplicabilityEvent;
  attempt: Attempt;
  workRun: WorkRun;
  checkpoint: Checkpoint;
  actionIntent: ActionIntent;
  auditEvent: AuditEvent;
  apiSuccess: ApiSuccess;
  apiError: ApiErrorEnvelope;
}

