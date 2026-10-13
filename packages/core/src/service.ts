import { AuthorityStore, type CanonicalRecord, type TrustLevel } from "./store.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { uuidv7 } from "./identity.js";
import { buildContextPack, type ContextPack } from "./context.js";
import { TARIC_COMPATIBILITY_MANIFEST } from "./compatibility.js";
import { ContractValidationError, schemaValidator, validateContract } from "./validation.js";
import { coreSchema, operationContract, operationContracts, SCHEMA_VERSION, type ContractName } from "@taric/schemas";
import { createAccessDecisionObservation, createControlObservation, type AccessDecisionObservationInput, type ControlObservationInput } from "./coverage.js";
import { ArtifactContentStore, type ArtifactBeginInput, type ArtifactAppendInput, type ArtifactCommitInput } from "./artifact-content-store.js";
import { dirname } from "node:path";
import { tmpdir } from "node:os";

export const API_CONTRACT_VERSION = "1.0.0" as const;

export type PrincipalRole = "model" | "host" | "reviewer" | "writer" | "operator";
/** principal 只能由 transport 创建，不能由请求 body 自行声明权限。 */
export type PrincipalCapability =
  | "read" | "propose" | "review" | "admit" | "work" | "checkpoint"
  | "action" | "audit" | "operator" | "content" | "content_read";
export interface Principal { id: string; role: PrincipalRole; engagement_id?: string; capabilities?: readonly PrincipalCapability[]; transport_verified: true; }

// Transport adapters register principals here; callers cannot make an arbitrary
// object trusted by merely adding `transport_verified: true`.
const verifiedPrincipals = new WeakSet<object>();
export function registerTransportPrincipal<T extends Principal>(principal: T): T {
  verifiedPrincipals.add(principal as unknown as object);
  return principal;
}

export type ApiErrorCode = "validation_error" | "authorization_error" | "unsupported_capability" | "unsupported_schema_version" | "idempotency_conflict" | "stale_version" | "conflict" | "unavailable_host" | "internal_error";

export interface ApiError { code: ApiErrorCode; message: string; follow_up?: string; }
export interface ApiEnvelope<T> { ok: true; data: T; request_id?: string }
export interface ErrorEnvelope { ok: false; error: ApiError }
export type ApiResponse<T> = ApiEnvelope<T> | ErrorEnvelope;

export function createCoreServiceForPath(filename = ":memory:", configuredContentRoot?: string): CoreService { return createCoreService(new AuthorityStore(filename), configuredContentRoot ?? process.env.TARIC_CONTENT_ROOT ?? (filename === ":memory:" ? join(tmpdir(), "taric-content", uuidv7()) : join(dirname(filename), "content"))); }
export function createAuthorityStoreForCli(filename = ":memory:"): AuthorityStore { return new AuthorityStore(filename); }

const deferred = {
  "storage.postgresql": "add-shared-authority-backend",
  "storage.backup": "evolve-engagement-memory",
  "storage.restore": "evolve-engagement-memory",
} as const;

const modelAllowed = new Set(["context.build", "context.query", "query", "resource.query", "evidence.query", "proposal.submit", "proposal.list", "checkpoint.propose", "action.recommend", "capability.status"]);
const hostRequired = new Set(["work.claim", "work.renew", "work.reclaim", "checkpoint.commit", "action.host-decision", "action.host-result", "action.reconcile"]);
const hostErrors = new Set(["error.report"]);
const auditRequired = new Set(["audit.verify", "audit.doctor", "audit.reconcile", "snapshot.export", "engagement.init", "engagement.status", "capability.status"]);
const hostScoped = new Set(["engagement.status", "context.build", "context.query", "query", "resource.query", "evidence.query", "proposal.submit", "proposal.list", "action.recommend"]);
const operatorScoped = new Set(["engagement.status", "context.build", "context.query", "query", "resource.query", "evidence.query", "proposal.list", "proposal.submit", "capture.observation", "admission.evaluate", "capability.status"]);
const reviewerScoped = new Set(["review.submit", "review.get"]);
const checkpointReasoningFields = new Set(["reasoning", "hidden_reasoning", "chain_of_thought", "thoughts", "internal_reasoning", "private_reasoning"]);
const operationRequestValidators = new Map<string, ReturnType<typeof schemaValidator.compile>>();
const adapterConfigPath = () => process.env.TARIC_ADAPTER_CONFIG ?? join(homedir(), ".taric", "adapters.json");
function readAdapterConfig(): Record<string, unknown> { try { const value = JSON.parse(readFileSync(adapterConfigPath(), "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } }
function saveAdapterConfig(value: Record<string, unknown>) { const path = adapterConfigPath(); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

function containsCheckpointReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCheckpointReasoning);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => checkpointReasoningFields.has(key) || containsCheckpointReasoning(item));
}

function publicArtifactMetadata(row: import("./artifact-content-store.js").ArtifactRow): Record<string, unknown> {
  const { relative_dir: _relativeDir, manifest_path: _manifestPath, ...metadata } = row;
  return metadata;
}
function sanitizeModelValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeModelValue).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.content_ref === "string") {
    const allowed = new Set(["content_ref", "artifact_id", "version", "storage_mode", "content_status", "integrity_status", "payload_kind", "media_type", "byte_length", "chunk_count", "content_hash", "manifest_hash", "captured_at", "stored_at", "provenance_ref", "derived_from", "child_refs"]);
    return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, sanitizeModelValue(item)]));
  }
  if (Object.prototype.hasOwnProperty.call(record, "host_ref")) return undefined;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !/(?:location|summary|cookie|header|url|token|secret|credential|private_path|artifact_body|raw_artifact)/i.test(key)).map(([key, item]) => [key, sanitizeModelValue(item)]));
}
function sanitizeModelRecord(record: CanonicalRecord): CanonicalRecord {
  return sanitizeModelValue(record) as CanonicalRecord;
}

export interface CoreService {
  init(engagement: { id: string; name?: string; scope_ref?: string }): ApiResponse<CanonicalRecord>;
  status(): ApiResponse<Record<string, unknown>>;
  buildContext(principal: Principal, input: { engagement_id: string; budget?: number; include_candidates?: boolean; work_item_id?: string; worker_role?: string; policy_version?: string; read_seq?: number; cursor?: string; filters?: Record<string, unknown>; ordering?: string; checkpoint?: Record<string, unknown>; resume_from_seq?: number; pending_actions?: Array<Record<string, unknown>> }): ApiResponse<ContextPack>;
  query(principal: Principal, input: { engagement_id: string; as_of?: number; trust_level?: TrustLevel; include_candidates?: boolean }): ApiResponse<{ read_seq: number; records: CanonicalRecord[] }>;
  submitProposal(principal: Principal, input: { engagement_id: string; subject_type: string; base_version: number; content: CanonicalRecord; work_run_id?: string; generation?: number; idempotency_key?: string }): ApiResponse<Record<string, unknown>>;
  captureObservation(principal: Principal, input: { engagement_id: string; observation?: CanonicalRecord; subject_type?: string; base_version?: number; content?: CanonicalRecord; work_run_id?: string; generation?: number }): ApiResponse<Record<string, unknown>>;
  submitReview(principal: Principal, input: { engagement_id: string; proposal_id: string; reviewer_id: string; reviewer_kind: "reviewer"; input_hash: string; verdict: "pass" | "reject" | "needs_evidence" | "defer"; policy_digest: string; evidence_snapshot_hash?: string; rubric_hash?: string; limitations?: string[]; idempotency_key?: string; reviewer_capability?: "deterministic" | "model" | "human"; reviewer_model?: string; prompt_digest?: string; ruleset_digest?: string }): ApiResponse<Record<string, unknown>>;
  admitProposal(principal: Principal, input: { engagement_id: string; proposal_id: string; policy_digest: string; expected_base_version: number; idempotency_key?: string }): ApiResponse<Record<string, unknown>>;
  listProposals(principal: Principal, input: { engagement_id: string }): ApiResponse<Array<Record<string, unknown>>>;
  workClaim(principal: Principal, input: { engagement_id: string; work_item_id: string; host_id: string; agent_id: string; ttl_ms?: number; task_session_ref?: string }): ApiResponse<Record<string, unknown>>;
  workRenew(principal: Principal, input: { engagement_id: string; work_run_id: string; generation: number; ttl_ms?: number }): ApiResponse<Record<string, unknown>>;
  workReclaim(principal: Principal, input: { engagement_id: string; work_run_id: string; agent_id: string; ttl_ms?: number }): ApiResponse<Record<string, unknown>>;
  auditReconcile(principal: Principal, input?: { action?: "preview" | "replay" | "rebuild" | "reconcile" }): ApiResponse<Record<string, unknown>>;
  errorReport(principal: Principal, input: { engagement_id: string; work_run_id?: string; generation?: number; error_ref?: string; message?: string }): ApiResponse<Record<string, unknown>>;
  checkpointPropose(principal: Principal, input: { engagement_id: string; work_run_id: string; generation: number; checkpoint: Record<string, unknown> }): ApiResponse<Record<string, unknown>>;
  checkpointCommit(principal: Principal, input: { engagement_id: string; work_run_id: string; host_id: string; generation: number; checkpoint: Record<string, unknown> }): ApiResponse<Record<string, unknown>>;
  actionRecommend(principal: Principal, input: { engagement_id: string; work_run_id?: string; generation?: number; target: string; method: string; rationale: string; uncertainty?: string; scope?: string; constraints?: string[]; limitations?: string[]; memory_refs?: string[]; evidence_refs?: string[] }): ApiResponse<Record<string, unknown>>;
  actionHostDecision(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; host_decision_ref?: string; status: "authorized" | "denied" }): ApiResponse<Record<string, unknown>>;
  actionHostResult(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; status: "executed" | "failed" | "unknown"; result_ref?: string; host_decision_ref?: string }): ApiResponse<Record<string, unknown>>;
  actionReconcile(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id: string; generation: number; result_ref: string; status: "executed" | "failed" }): ApiResponse<Record<string, unknown>>;
  observeControl(principal: Principal, input: ControlObservationInput): ApiResponse<Record<string, unknown>>;
  observeAccess(principal: Principal, input: AccessDecisionObservationInput): ApiResponse<Record<string, unknown>>;
  controlList(principal: Principal, input: { engagement_id: string }): ApiResponse<Array<Record<string, unknown>>>;
  resume(principal: Principal, input: { engagement_id: string; work_run_id: string; host_id: string }): ApiResponse<Record<string, unknown>>;
  auditVerify(principal: Principal): ApiResponse<{ valid: boolean; errors: string[] }>;
  auditDoctor(principal: Principal): ApiResponse<Record<string, unknown>>;
  snapshotExport(principal: Principal, input: { engagement_id: string; as_of?: number }): ApiResponse<Record<string, unknown>>;
  snapshotImport(principal: Principal, input: { engagement_id: string; snapshot: unknown }): ApiResponse<Record<string, unknown>>;
  resourceRevise(principal: Principal, input: Record<string, unknown>): ApiResponse<Record<string, unknown>>;
  resourcePatch(principal: Principal, input: Record<string, unknown>): ApiResponse<Record<string, unknown>>;
  resourceRelation(principal: Principal, input: Record<string, unknown>): ApiResponse<Record<string, unknown>>;
  resourceImpact(principal: Principal, input: { engagement_id: string; source_id: string; limit?: number; continuation?: string }): ApiResponse<Record<string, unknown>>;
  artifactSessionBind(principal: Principal, input: { engagement_id: string; session_id: string; root: string }): ApiResponse<Record<string, unknown>>;
  artifactStoreBegin(principal: Principal, input: ArtifactBeginInput): ApiResponse<Record<string, unknown>>;
  artifactStoreAppend(principal: Principal, input: ArtifactAppendInput): ApiResponse<Record<string, unknown>>;
  artifactStoreCommit(principal: Principal, input: ArtifactCommitInput): ApiResponse<Record<string, unknown>>;
  artifactMetadata(principal: Principal, input: { engagement_id: string; session_id: string; content_ref: string }): ApiResponse<Record<string, unknown>>;
  artifactContentRead(principal: Principal, input: { engagement_id: string; session_id: string; content_ref: string; offset?: number; length?: number; chunk_cursor?: string; max_response_bytes?: number }): ApiResponse<Record<string, unknown>>;
  artifactContentList(principal: Principal, input: { engagement_id: string; session_id: string; cursor?: string; page_size?: number; category?: string; media_type?: string; work_run_id?: string; include_content?: boolean }): ApiResponse<Record<string, unknown>>;
  artifactSessionOutput(principal: Principal, input: { engagement_id: string; session_id: string; cursor?: string; execution_cursor?: string; page_size?: number; include_content?: boolean; max_response_bytes?: number; work_run_id?: string; attempt_id?: string }): ApiResponse<Record<string, unknown>>;
  capabilityStatus(principal?: Principal): ApiResponse<Record<string, unknown>>;
  dispatch(operation: string, principal: Principal, request: Record<string, unknown>): ApiResponse<unknown>;
}

export function createCoreService(store: AuthorityStore, contentRoot = process.env.TARIC_CONTENT_ROOT ?? join(tmpdir(), "taric-content", uuidv7())): CoreService {
  const artifactStore = new ArtifactContentStore(contentRoot, store);
  const api = {
    init(engagement: { id: string; name?: string; scope_ref?: string }) {
      const record = store.commit({ id: engagement.id, engagement_id: engagement.id, kind: "engagement", name: engagement.name ?? "engagement", scope_ref: engagement.scope_ref }, "L2");
      return { ok: true as const, data: record };
    },
    status() { return { ok: true as const, data: { schema_version: API_CONTRACT_VERSION, schema_supported: true } }; },
    artifactSessionBind(principal: Principal, input: { engagement_id: string; session_id: string; root: string }) {
      const access = authorize(principal, "artifact.session.bind", input.engagement_id); if (!access.ok) return access;
      return safe(() => { const { root: _root, ...binding } = artifactStore.bind(input); return { ok: true as const, data: binding as unknown as Record<string, unknown> }; });
    },
    artifactStoreBegin(principal: Principal, input: ArtifactBeginInput) {
      const access = authorize(principal, "artifact.store.begin", input.engagement_id); if (!access.ok) return access;
      return safe(() => ({ ok: true as const, data: artifactStore.begin(input, principal.id) }));
    },
    artifactStoreAppend(principal: Principal, input: ArtifactAppendInput) {
      const access = authorize(principal, "artifact.store.append", input.engagement_id); if (!access.ok) return access;
      return safe(() => ({ ok: true as const, data: artifactStore.append(input, principal.id) }));
    },
    artifactStoreCommit(principal: Principal, input: ArtifactCommitInput) {
      const access = authorize(principal, "artifact.store.commit", input.engagement_id); if (!access.ok) return access;
      return safe(() => ({ ok: true as const, data: publicArtifactMetadata(artifactStore.commit(input, principal.id)) }));
    },
    artifactMetadata(principal: Principal, input: { engagement_id: string; session_id: string; content_ref: string }) {
      const access = authorize(principal, "artifact.metadata", input.engagement_id); if (!access.ok) return access;
      return safe(() => ({ ok: true as const, data: artifactStore.metadata(input) }));
    },
    artifactContentRead(principal: Principal, input: { engagement_id: string; session_id: string; content_ref: string; offset?: number; length?: number; chunk_cursor?: string; max_response_bytes?: number }) {
      const access = authorize(principal, "artifact.content.read", input.engagement_id); if (!access.ok) return access;
      return safe(() => ({ ok: true as const, data: artifactStore.readBounded({ ...input, principal_id: principal.id }) }));
    },
    artifactContentList(principal: Principal, input: { engagement_id: string; session_id: string; cursor?: string; page_size?: number; category?: string; media_type?: string; work_run_id?: string; include_content?: boolean }) {
      const access = authorize(principal, "artifact.content.list", input.engagement_id); if (!access.ok) return access;
      if ((input as typeof input & { include_content?: boolean }).include_content) { const rawAccess = authorize(principal, "artifact.content.read", input.engagement_id); if (!rawAccess.ok) return rawAccess; }
      return safe(() => ({ ok: true as const, data: artifactStore.list({ ...input, principal_id: principal.id }) }));
    },
    artifactSessionOutput(principal: Principal, input: { engagement_id: string; session_id: string; cursor?: string; execution_cursor?: string; page_size?: number; include_content?: boolean; max_response_bytes?: number; work_run_id?: string; attempt_id?: string }) {
      const access = authorize(principal, "artifact.session.output", input.engagement_id); if (!access.ok) return access;
      if (input.include_content) { const rawAccess = authorize(principal, "artifact.content.read", input.engagement_id); if (!rawAccess.ok) return rawAccess; }
      return safe(() => ({ ok: true as const, data: artifactStore.output({ ...input, principal_id: principal.id }) }));
    },
    buildContext(principal: Principal, input: { engagement_id: string; budget?: number; include_candidates?: boolean; work_item_id?: string; worker_role?: string; policy_version?: string; read_seq?: number; cursor?: string; filters?: Record<string, unknown>; ordering?: string; checkpoint?: Record<string, unknown>; resume_from_seq?: number; pending_actions?: Array<Record<string, unknown>> }) {
      const response = authorize(principal, "context.build", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: buildContextPack(store, input.engagement_id, input.budget ?? 4000, { includeCandidates: Boolean(input.include_candidates), principalId: principal.id, workItemId: input.work_item_id, workerRole: input.worker_role, policyVersion: input.policy_version, readSeq: input.read_seq, cursor: input.cursor, filters: input.filters, ordering: input.ordering, checkpoint: input.checkpoint, resumeFromSeq: input.resume_from_seq, pendingActions: input.pending_actions } as never) }));
    },
    query(principal: Principal, input: { engagement_id: string; as_of?: number; trust_level?: TrustLevel; include_candidates?: boolean }) {
      const response = authorize(principal, "query", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => { const snapshot = store.snapshot(input.engagement_id, { asOf: input.as_of, trustLevel: principal.role === "model" ? undefined : input.trust_level, includeCandidates: principal.role === "model" ? false : input.include_candidates }); return { ok: true as const, data: principal.role === "model" ? { ...snapshot, records: snapshot.records.map(sanitizeModelRecord) } : snapshot }; });
    },
    submitProposal(principal: Principal, input: { engagement_id: string; subject_type: string; base_version: number; content: CanonicalRecord; work_run_id?: string; generation?: number; idempotency_key?: string }) {
      const response = authorize(principal, "proposal.submit", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => {
        if (!input.content || typeof input.content !== "object") return error("validation_error", "proposal content must be an object");
        if (["trust_level", "admission_status", "policy_result", "display_id"].some((field) => field in input.content)) return error("validation_error", "proposal cannot set privileged fields");
        const content = { ...input.content, engagement_id: input.engagement_id, trust_level: undefined, display_id: undefined, provenance: { ...(input.content.provenance as Record<string, unknown> ?? {}), host_id: principal.id, producer_id: principal.id, source_kind: principal.role === "model" ? "model" : "host" } } as CanonicalRecord;
        return { ok: true as const, data: store.submitProposal({ engagement_id: input.engagement_id, subject_type: input.subject_type, base_version: input.base_version, content }, { idempotencyKey: input.idempotency_key, operation: "proposal.submit", principal: principal.id, engagement_id: input.engagement_id, workRunId: input.work_run_id ?? (typeof content.work_run_ref === "string" ? content.work_run_ref : undefined), generation: input.generation ?? (typeof content.generation === "number" ? content.generation : undefined), principalRole: principal.role }) as unknown as Record<string, unknown> };
      });
    },
    captureObservation(principal: Principal, input: { engagement_id: string; observation?: CanonicalRecord; subject_type?: string; base_version?: number; content?: CanonicalRecord; work_run_id?: string; generation?: number }) {
      const response = authorize(principal, "capture.observation", input.engagement_id);
      if (!response.ok) return response;
      const content = input.observation ?? input.content;
      if (!content || typeof content !== "object") return error("validation_error", "observation is required");
      return api.submitProposal(principal, {
        engagement_id: input.engagement_id,
        subject_type: input.subject_type ?? "observation",
        base_version: input.base_version ?? 0,
        content,
        work_run_id: input.work_run_id,
        generation: input.generation,
      });
    },
    submitReview(principal: Principal, input: { engagement_id: string; proposal_id: string; reviewer_id: string; reviewer_kind: "reviewer"; input_hash: string; verdict: "pass" | "reject" | "needs_evidence" | "defer"; policy_digest: string; evidence_snapshot_hash?: string; rubric_hash?: string; limitations?: string[]; idempotency_key?: string; reviewer_capability?: "deterministic" | "model" | "human"; reviewer_model?: string; prompt_digest?: string; ruleset_digest?: string }) {
      const response = authorize(principal, "review.submit", input.engagement_id);
      if (!response.ok) return response;
      if (input.reviewer_id !== principal.id || input.reviewer_kind !== "reviewer") return error("authorization_error", "reviewer identity is bound to the authenticated principal");
      return safe(() => {
        const proposal = store.proposals(input.engagement_id).find((item) => item.id === input.proposal_id);
        if (!proposal) return error("conflict", "proposal not found in this engagement");
        return { ok: true as const, data: store.submitReview({ proposal_id: input.proposal_id, reviewer_id: principal.id, reviewer_kind: "reviewer", input_hash: input.input_hash, verdict: input.verdict, policy_digest: input.policy_digest, evidence_snapshot_hash: input.evidence_snapshot_hash, rubric_hash: input.rubric_hash, limitations: input.limitations, idempotencyKey: input.idempotency_key, principal: principal.id, reviewer_capability: input.reviewer_capability, reviewer_model: input.reviewer_model, prompt_digest: input.prompt_digest, ruleset_digest: input.ruleset_digest }) };
      });
    },
    admitProposal(principal: Principal, input: { engagement_id: string; proposal_id: string; policy_digest: string; expected_base_version: number; idempotency_key?: string }) {
      const response = authorize(principal, "admission.evaluate", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => {
        if (!store.proposals(input.engagement_id).some((item) => item.id === input.proposal_id)) return error("conflict", "proposal not found in this engagement");
        const result = store.admitProposal(input.proposal_id, input.policy_digest, { expectedBaseVersion: input.expected_base_version, idempotencyKey: input.idempotency_key, operation: "admission.evaluate", principal: principal.id, engagement_id: input.engagement_id });
        return { ok: true as const, data: result as unknown as Record<string, unknown> };
      });
    },
    listProposals(principal: Principal, input: { engagement_id: string }) {
      const response = authorize(principal, "proposal.list", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.proposals(input.engagement_id) as unknown as Array<Record<string, unknown>> }));
    },
    workClaim(principal: Principal, input: { engagement_id: string; work_item_id: string; host_id: string; agent_id: string; ttl_ms?: number; task_session_ref?: string }) {
      const response = authorize(principal, "work.claim", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.claimWorkRun({ ...input, host_id: principal.id }) }));
    },
    workRenew(principal: Principal, input: { engagement_id: string; work_run_id: string; generation: number; ttl_ms?: number }) {
      const response = authorize(principal, "work.renew", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.renewWorkRun(input.work_run_id, input.generation, principal.id, input.ttl_ms) }));
    },
    workReclaim(principal: Principal, input: { engagement_id: string; work_run_id: string; agent_id: string; ttl_ms?: number }) {
      const response = authorize(principal, "work.reclaim", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => {
        const run = store.getWorkRun(input.work_run_id);
        if (!run || run.engagement_id !== input.engagement_id) return error("conflict", "work run not found");
        return { ok: true as const, data: store.reclaimWorkRun(input.work_run_id, principal.id, input.agent_id, input.ttl_ms) };
      });
    },
    auditReconcile(principal: Principal, input: { action?: "preview" | "replay" | "rebuild" | "reconcile" } = {}) {
      const response = authorize(principal, "audit.reconcile");
      if (!response.ok) return response;
      return safe<Record<string, unknown>>(() => {
        if (input.action !== undefined && !["preview", "replay", "rebuild", "reconcile"].includes(input.action)) return error("validation_error", "audit reconcile action must be preview, replay, rebuild, or reconcile");
        if (input.action) return { ok: true as const, data: {
          ...store.reconcileDerived(input.action) as unknown as Record<string, unknown>,
          artifacts: input.action === "reconcile" || input.action === "preview" ? artifactStore.reconcile() : undefined,
        } };
        return { ok: true as const, data: { applied: store.consumeOutbox(), doctor: { ...store.doctor(), artifacts: artifactStore.reconcile() } } };
      });
    },
    errorReport(principal: Principal, input: { engagement_id: string; work_run_id?: string; generation?: number; error_ref?: string; message?: string }) {
      const response = authorize(principal, "error.report", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.recordHostError({ ...input, host_id: principal.id }) }));
    },
    checkpointPropose(principal: Principal, input: { engagement_id: string; work_run_id: string; generation: number; checkpoint: Record<string, unknown> }) {
      const response = authorize(principal, "checkpoint.propose", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => {
        if (!Number.isInteger(input.generation) || input.generation < 1) return error("validation_error", "current generation is required");
        const run = store.getWorkRun(input.work_run_id);
        if (!run || run.engagement_id !== input.engagement_id) return error("conflict", "work run not found");
        if (containsCheckpointReasoning(input.checkpoint)) return error("validation_error", "checkpoint proposal cannot contain hidden reasoning");
        const workItem = store.get(String(run.work_item_id));
        if (!workItem || workItem.engagement_id !== input.engagement_id) return error("conflict", "WorkItem is unavailable");
        const content = {
          ...input.checkpoint,
          id: uuidv7(),
          schema_version: SCHEMA_VERSION,
          engagement_id: input.engagement_id,
          created_at: new Date().toISOString(),
          provenance: { host_id: String((run.owner as Record<string, unknown>).host_id), producer_id: principal.id, source_kind: "worker" },
          kind: "checkpoint",
          work_item_ref: run.work_item_id,
          work_run_ref: input.work_run_id,
          attempt_ref: run.attempt_ref,
          generation: input.generation,
          scope_ref: run.scope_ref,
          target_version: run.target_version,
          work_item_version: run.work_item_version,
          scope_version: run.scope_version,
          owner: run.owner,
          lease_expires_at: run.lease_expires_at,
        } as CanonicalRecord;
        validateContract("checkpoint", content);
        return { ok: true as const, data: store.submitProposal({ engagement_id: input.engagement_id, subject_type: "checkpoint", base_version: 0, content }, { operation: "checkpoint.propose", principal: principal.id, engagement_id: input.engagement_id, workRunId: input.work_run_id, generation: input.generation, principalRole: principal.role }) as unknown as Record<string, unknown> };
      });
    },
    checkpointCommit(principal: Principal, input: { engagement_id: string; work_run_id: string; host_id: string; generation: number; checkpoint: Record<string, unknown> }) {
      const response = authorize(principal, "checkpoint.commit", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.commitCheckpoint(input.work_run_id, input.generation, principal.id, input.checkpoint) }));
    },
    actionRecommend(principal: Principal, input: { engagement_id: string; work_run_id?: string; generation?: number; target: string; method: string; rationale: string; uncertainty?: string; scope?: string; constraints?: string[]; limitations?: string[]; memory_refs?: string[]; evidence_refs?: string[] }) {
      const response = authorize(principal, "action.recommend", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => {
        const allowed = new Set(["engagement_id", "work_run_id", "generation", "target", "method", "rationale", "uncertainty", "scope", "constraints", "limitations", "memory_refs", "evidence_refs"]);
        if (Object.keys(input as unknown as Record<string, unknown>).some((key) => !allowed.has(key))) return error("validation_error", "action recommendation contains unsupported fields");
        if (![input.target, input.method, input.rationale].every((value) => typeof value === "string" && value.trim().length > 0)) return error("validation_error", "target, method and rationale are required");
        for (const field of ["constraints", "limitations", "memory_refs", "evidence_refs"] as const) {
          if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field]!.some((value) => typeof value !== "string"))) return error("validation_error", `${field} must be a string array`);
        }
        const run = input.work_run_id ? store.getWorkRun(input.work_run_id) : undefined;
        if (input.work_run_id && (!run || run.engagement_id !== input.engagement_id)) return error("conflict", "work run not found");
        if (input.work_run_id && (!Number.isInteger(input.generation) || input.generation !== run!.generation)) return error("stale_version", "action recommendation requires the active generation");
        const workRunId = typeof run?.run_id === "string" ? run.run_id : undefined;
        const generation = typeof run?.generation === "number" ? run.generation : undefined;
        const content = {
          id: uuidv7(), engagement_id: input.engagement_id, kind: "action_intent", status: "recommended",
          target: input.target, method: input.method, rationale: input.rationale, uncertainty: input.uncertainty, scope: input.scope ?? input.engagement_id,
          constraints: input.constraints ?? [], limitations: input.limitations ?? [], memory_refs: input.memory_refs ?? [], evidence_refs: input.evidence_refs ?? [],
          work_run_ref: workRunId, attempt_ref: run?.attempt_ref, generation,
        } as CanonicalRecord;
        if (run) {
          const action = store.recordActionIntent({ action_id: content.id, run_id: workRunId!, generation: generation!, mode: "llm_recommend", target: input.target, method: input.method, rationale: input.rationale, uncertainty: input.uncertainty, scope: input.scope ?? input.engagement_id, constraints: input.constraints ?? [], limitations: input.limitations ?? [], memory_refs: input.memory_refs ?? [], evidence_refs: input.evidence_refs ?? [], status: "recommended", host_id: principal.id, actor_role: principal.role === "model" ? "model" : "host" });
          return { ok: true as const, data: { recommendation_id: action.action_id, target: input.target, method: input.method, rationale: input.rationale, uncertainty: input.uncertainty, scope: input.scope ?? input.engagement_id, constraints: input.constraints ?? [], limitations: input.limitations ?? [], memory_refs: input.memory_refs ?? [], evidence_refs: input.evidence_refs ?? [] } };
        }
        const proposal = store.submitProposal({ engagement_id: input.engagement_id, subject_type: "action_recommendation", base_version: 0, content }, {
          operation: "action.recommend", principal: principal.id, engagement_id: input.engagement_id,
          workRunId, generation, principalRole: principal.role,
        });
        return { ok: true as const, data: { recommendation_id: proposal.id, target: input.target, method: input.method, rationale: input.rationale, uncertainty: input.uncertainty, scope: input.scope ?? input.engagement_id, constraints: input.constraints ?? [], limitations: input.limitations ?? [], memory_refs: input.memory_refs ?? [], evidence_refs: input.evidence_refs ?? [] } };
      });
    },
    actionHostDecision(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; host_decision_ref?: string; status: "authorized" | "denied" }) {
      const response = authorize(principal, "action.host-decision", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.recordActionIntent({ ...input, host_id: principal.id, action_id: input.action_id, run_id: input.work_run_id, status: input.status }) }));
    },
    actionHostResult(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; status: "executed" | "failed" | "unknown"; result_ref?: string; host_decision_ref?: string }) {
      const response = authorize(principal, "action.host-result", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.recordActionIntent({ ...input, host_id: principal.id, action_id: input.action_id, run_id: input.work_run_id, status: input.status }) }));
    },
    actionReconcile(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id: string; generation: number; result_ref: string; status: "executed" | "failed" }) {
      const response = authorize(principal, "action.reconcile", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.reconcileAction(input.work_run_id, input.generation, input.result_ref, input.status, input.action_id, principal.id) }));
    },
    observeControl(principal: Principal, input: ControlObservationInput) {
      const response = authorize(principal, "control.observe", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: createControlObservation(store, input) as unknown as Record<string, unknown> }));
    },
    observeAccess(principal: Principal, input: AccessDecisionObservationInput) {
      const response = authorize(principal, "access.observe", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: createAccessDecisionObservation(store, input) as unknown as Record<string, unknown> }));
    },
    controlList(principal: Principal, input: { engagement_id: string }) {
      const response = authorize(principal, "control.list", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.snapshot(input.engagement_id, { includeCandidates: true }).records.filter((record) => ["protective_control", "control_observation", "access_decision_observation"].includes(String(record.kind))) as Array<Record<string, unknown>> }));
    },
    resume(principal: Principal, input: { engagement_id: string; work_run_id: string; host_id: string }) {
      const response = authorize(principal, "work.resume", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.resumePacket(input.work_run_id, principal.id) }));
    },
    auditVerify(principal: Principal) {
      const response = authorize(principal, "audit.verify");
      if (!response.ok) return response;
      return { ok: true as const, data: store.verifyAudit() };
    },
    auditDoctor(principal: Principal) {
      const response = authorize(principal, "audit.doctor");
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: { ...store.doctor(), artifacts: artifactStore.reconcile() } as unknown as Record<string, unknown> }));
    },
    snapshotExport(principal: Principal, input: { engagement_id: string; as_of?: number }) {
      const response = authorize(principal, "snapshot.export", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.exportSnapshot(input.engagement_id, input.as_of) as unknown as Record<string, unknown> }));
    },
    snapshotImport(principal: Principal, input: { engagement_id: string; snapshot: unknown }) {
      const response = authorize(principal, "snapshot.import", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => {
        if (typeof input.snapshot === "string" && input.snapshot.length > 20_000_000) return error("validation_error", "snapshot exceeds the import size limit");
        const snapshot = typeof input.snapshot === "string" && !input.snapshot.trim().includes("\n") ? JSON.parse(input.snapshot) as Record<string, unknown> : input.snapshot;
        const snapshotObject = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : undefined;
        if (snapshotObject?.engagement_id !== undefined && snapshotObject.engagement_id !== input.engagement_id) return error("authorization_error", "snapshot Engagement does not match the request");
        return { ok: true as const, data: store.importSnapshot(input.snapshot) as unknown as Record<string, unknown> };
      });
    },
    resourceRevise(principal: Principal, input: Record<string, unknown>) {
      const response = authorize(principal, "resource.revise", typeof input.engagement_id === "string" ? input.engagement_id : undefined);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.createResourceRevision({ ...input, principal: principal.id } as never) as unknown as Record<string, unknown> }));
    },
    resourcePatch(principal: Principal, input: Record<string, unknown>) {
      const response = authorize(principal, "resource.patch", typeof input.engagement_id === "string" ? input.engagement_id : undefined);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.applyPatchSet({ ...input, principal: principal.id } as never) as unknown as Record<string, unknown> }));
    },
    resourceRelation(principal: Principal, input: Record<string, unknown>) {
      const response = authorize(principal, "resource.relation", typeof input.engagement_id === "string" ? input.engagement_id : undefined);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.addRelation({ ...input, provenance: { host_id: principal.id, producer_id: principal.id, source_kind: "host" } } as never) as unknown as Record<string, unknown> }));
    },
    resourceImpact(principal: Principal, input: { engagement_id: string; source_id: string; limit?: number; continuation?: string }) {
      const response = authorize(principal, "resource.impact", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.impact(input.source_id, input) as unknown as Record<string, unknown> }));
    },
    capabilityStatus(principal?: Principal) {
      if (principal) {
        const access = authorize(principal, "capability.status");
        if (!access.ok) return access;
      }
      // 诊断必须与 compat manifest 同源，避免 CLI/MCP/Pi 各自维护支持名单。
      const unsupported = Object.fromEntries(TARIC_COMPATIBILITY_MANIFEST.capabilities.filter((item) => item.state === "unsupported").map((item) => [item.id, item.follow_up ?? "complete-taric-runtime-gaps"]));
      return { ok: true as const, data: {
        schema_version: API_CONTRACT_VERSION,
        compatibility_manifest: TARIC_COMPATIBILITY_MANIFEST,
        // 支持名单必须来自统一操作注册表，避免 Core、CLI、MCP 与 Pi 各维护一份。
        supported_operations: operationContracts.map((contract) => contract.operation),
        unsupported_capabilities: { ...unsupported, ...deferred },
      } };
    },
    adapterInstall(principal: Principal, input: Record<string, unknown>) {
      const access = authorize(principal, "adapter.install"); if (!access.ok) return access;
      const host = input.host; if (host !== "pi" && host !== "deepseek-harness" && host !== "hermes") return error("validation_error", "host must be pi, deepseek-harness, or hermes");
      const manifestHost = host === "deepseek-harness" ? "deepseek-harness" : host;
      const evidence = TARIC_COMPATIBILITY_MANIFEST.hosts[manifestHost];
      if (evidence.state !== "supported") return error("unsupported_capability", `${host} has no verified native hooks`, "MCP/CLI fallback remains available");
      const config = readAdapterConfig(); const adapters = (config.adapters && typeof config.adapters === "object" ? config.adapters : {}) as Record<string, unknown>;
      adapters[host] = { enabled: true, version: "version" in evidence ? evidence.version : "1.1.0", commit: "commit" in evidence ? evidence.commit : "7c10bd4" };
      config.adapters = adapters; saveAdapterConfig(config); return { ok: true as const, data: { host, installed: true, config_path: adapterConfigPath() } };
    },
    adapterRemove(principal: Principal, input: Record<string, unknown>) {
      const access = authorize(principal, "adapter.remove"); if (!access.ok) return access;
      const host = input.host; if (host !== "pi" && host !== "deepseek-harness" && host !== "hermes") return error("validation_error", "host must be pi, deepseek-harness, or hermes");
      const config = readAdapterConfig(); const adapters = (config.adapters && typeof config.adapters === "object" ? config.adapters : {}) as Record<string, unknown>; delete adapters[host]; config.adapters = adapters; saveAdapterConfig(config);
      return { ok: true as const, data: { host, installed: false, config_path: adapterConfigPath() } };
    },
    adapterConfig(principal: Principal, input: Record<string, unknown>) {
      const access = authorize(principal, "adapter.config"); if (!access.ok) return access;
      const host = input.host; if (host !== "pi" && host !== "deepseek-harness" && host !== "hermes") return error("validation_error", "host must be pi, deepseek-harness, or hermes");
      const patch = input.config; if (!patch || typeof patch !== "object" || Array.isArray(patch)) return error("validation_error", "config must be an object");
      const config = readAdapterConfig(); const adapters = (config.adapters && typeof config.adapters === "object" ? config.adapters : {}) as Record<string, unknown>; const current = (adapters[host] && typeof adapters[host] === "object" ? adapters[host] : {}) as Record<string, unknown>;
      adapters[host] = { ...current, ...(patch as Record<string, unknown>) }; config.adapters = adapters; saveAdapterConfig(config); return { ok: true as const, data: { host, config: adapters[host], config_path: adapterConfigPath() } };
    }
  };
  return {
    ...api,
    dispatch(operation, principal, request) {
      if (Object.prototype.hasOwnProperty.call(deferred, operation)) return error("unsupported_capability", `operation is deferred to ${deferred[operation as keyof typeof deferred]}`, deferred[operation as keyof typeof deferred]);
      if (!operationContract(operation)) return error("unsupported_capability", "operation is not supported", "complete-taric-runtime-gaps");
      if (!request || typeof request !== "object" || Array.isArray(request)) return error("validation_error", "request must be an object");
      if (request.contract_version !== undefined && request.contract_version !== API_CONTRACT_VERSION) return error("unsupported_schema_version", "unsupported API contract version");
      const requestedEngagement = typeof request.engagement_id === "string" ? request.engagement_id : typeof request.id === "string" && operation === "engagement.init" ? request.id : undefined;
      const access = authorize(principal, operation, requestedEngagement);
      if (!access.ok) return access;
      if (operation.startsWith("artifact.")) {
        const requestContract = operationContract(operation)!.request as ContractName;
        let validate = operationRequestValidators.get(requestContract);
        if (!validate) { validate = schemaValidator.compile({ $id: `${coreSchema.$id}/requests/${requestContract}.json`, $defs: coreSchema.$defs, $ref: `#/$defs/${requestContract}` }); operationRequestValidators.set(requestContract, validate); }
        if (!validate || !validate(request)) return error("validation_error", `invalid ${operation} request`);
      }
      const aliases: Record<string, string> = { "engagement.init": "init", "engagement.status": "status", "adapter.status": "capabilityStatus", "adapter.install": "adapterInstall", "adapter.remove": "adapterRemove", "adapter.config": "adapterConfig", "capability.status": "capabilityStatus", "audit.verify": "auditVerify", "audit.doctor": "auditDoctor", "audit.reconcile": "auditReconcile", "error.report": "errorReport", "snapshot.export": "snapshotExport", "snapshot.import": "snapshotImport", "resource.revise": "resourceRevise", "resource.patch": "resourcePatch", "resource.relation": "resourceRelation", "resource.impact": "resourceImpact", "context.build": "buildContext", "context.query": "buildContext", "proposal.submit": "submitProposal", "capture": "captureObservation", "capture.observation": "captureObservation", "proposal.list": "listProposals", "review.submit": "submitReview", "admission.evaluate": "admitProposal", "admission.commit": "admitProposal", "admission": "admitProposal", "work.claim": "workClaim", "work.renew": "workRenew", "work.reclaim": "workReclaim", "checkpoint.propose": "checkpointPropose", "checkpoint.commit": "checkpointCommit", "action.recommend": "actionRecommend", "action.host-decision": "actionHostDecision", "action.host-result": "actionHostResult", "action.reconcile": "actionReconcile", "control.list": "controlList", "control.observe": "observeControl", "access.observe": "observeAccess", "work.resume": "resume", "resource.query": "query", "evidence.query": "query", "artifact.session.bind": "artifactSessionBind", "artifact.store.begin": "artifactStoreBegin", "artifact.store.append": "artifactStoreAppend", "artifact.store.commit": "artifactStoreCommit", "artifact.metadata": "artifactMetadata", "artifact.content.read": "artifactContentRead", "artifact.content.list": "artifactContentList", "artifact.session.output": "artifactSessionOutput" };
      const methodName = aliases[operation] ?? operation;
      if (!Object.prototype.hasOwnProperty.call(api, methodName)) return error("unsupported_capability", "operation is not supported", "complete-taric-runtime-gaps");
      return safe(() => {
        if (methodName === "status") {
          return api.status() as ApiResponse<unknown>;
        }
        if (methodName === "init") {
          if (typeof request.id !== "string" || request.id.length === 0) return error("validation_error", "engagement id is required");
          return safe(() => ({ ok: true as const, data: store.commit({ id: request.id as string, engagement_id: request.id as string, kind: "engagement", name: typeof request.name === "string" ? request.name : "engagement", scope_ref: request.scope_ref }, "L2") }));
        }
        if (methodName === "capabilityStatus") return api.capabilityStatus(undefined) as ApiResponse<unknown>;
        const method = api[methodName as keyof typeof api] as (p: Principal, r: Record<string, unknown>) => ApiResponse<unknown>;
        return method(principal, request);
      });
    }
  };
}

function authorize(principal: Principal, operation: string, engagementId?: string): ApiResponse<{ principal: Principal }> {
  if (!principal?.id || !principal.role || principal.transport_verified !== true || !verifiedPrincipals.has(principal)) return error("authorization_error", "transport-verified principal is required");
  if (operation in deferred) return error("unsupported_capability", "operation is deferred", deferred[operation as keyof typeof deferred]);
  const contract = operationContract(operation);
  if (!contract || !contract.roles.includes(principal.role)) return error("authorization_error", "principal role is not authorized for this operation");
  const requiredCapability = capabilityForOperation(operation);
  if (requiredCapability && !principal.capabilities?.includes(requiredCapability)) return error("authorization_error", "principal lacks the required engagement capability");
  if (contract.engagement_scoped) {
    if (!engagementId) return error("validation_error", "engagement_id is required");
    if (operation !== "engagement.init" && ((principal.role !== "operator" && !principal.engagement_id) || (principal.engagement_id !== undefined && principal.engagement_id !== engagementId))) return error("authorization_error", "principal is not authorized for this engagement");
  } else if (engagementId && principal.engagement_id && principal.engagement_id !== engagementId) {
    return error("authorization_error", "principal is not authorized for this engagement");
  }
  return { ok: true as const, data: { principal } };
}

function capabilityForOperation(operation: string): PrincipalCapability | undefined {
  if (["context.build", "context.query", "query", "resource.query", "evidence.query", "proposal.list", "control.list", "engagement.status"].includes(operation)) return "read";
  if (["proposal.submit", "capture.observation", "checkpoint.propose", "action.recommend"].includes(operation)) return "propose";
  if (operation === "review.submit" || operation === "review.get") return "review";
  if (["admission.evaluate", "admission.commit"].includes(operation)) return "admit";
  if (["work.claim", "work.renew", "work.reclaim", "work.resume", "error.report"].includes(operation)) return "work";
  if (["checkpoint.commit"].includes(operation)) return "checkpoint";
  if (["action.host-decision", "action.host-result", "action.reconcile"].includes(operation)) return "action";
  if (["audit.verify", "audit.doctor", "audit.reconcile", "snapshot.export", "snapshot.import"].includes(operation)) return "audit";
  if (operation === "artifact.content.read") return "content_read";
  if (operation.startsWith("artifact.")) return "content";
  if (["resource.revise", "resource.patch", "resource.relation", "resource.impact"].includes(operation)) return "propose";
  if (["engagement.init", "capability.status"].includes(operation)) return "operator";
  return undefined;
}
function safe<T>(operation: () => ApiResponse<T>): ApiResponse<T> {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof ContractValidationError) {
      const code: ApiErrorCode = cause.code === "unsupported_schema_version" || cause.code === "unsupported_capability" || cause.code === "idempotency_conflict" || cause.code === "conflict" || cause.code === "stale_version" || cause.code === "authorization_error" ? cause.code : "validation_error";
      return error(code, cause.message, typeof cause.details === "string" ? cause.details : undefined);
    }
    const errorCode = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : "";
    if (["validation_error", "authorization_error", "unsupported_capability", "unsupported_schema_version", "idempotency_conflict", "stale_version", "conflict", "unavailable_host"].includes(errorCode)) return error(errorCode as ApiErrorCode, cause instanceof Error ? cause.message : "artifact operation failed");
    const message = cause instanceof Error ? cause.message : "internal error";
    // 只有明确可识别的冲突语义才映射为 stale_version，其余一律 internal_error 且不泄漏堆栈。
    if (/unavailable host/i.test(message)) return error("unavailable_host", message);
    if (/stale|lease|generation|version conflict/i.test(message)) return error("stale_version", message);
    return error("internal_error", message);
  }
}
function error(code: ApiErrorCode, message: string, follow_up?: string): ErrorEnvelope { return { ok: false, error: { code, message, follow_up } }; }
