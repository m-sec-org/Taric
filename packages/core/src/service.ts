import { AuthorityStore, type CanonicalRecord, type TrustLevel } from "./store.js";
import { buildContextPack, type ContextPack } from "./context.js";
import { TARIC_COMPATIBILITY_MANIFEST } from "./compatibility.js";
import { ContractValidationError } from "./validation.js";
import { createAccessDecisionObservation, createControlObservation, type AccessDecisionObservationInput, type ControlObservationInput } from "./coverage.js";

export const API_CONTRACT_VERSION = "1.0.0" as const;

export type PrincipalRole = "model" | "host" | "reviewer" | "operator";
/** principal 只能由 transport 创建，不能由请求 body 自行声明权限。 */
export interface Principal { id: string; role: PrincipalRole; engagement_id?: string; transport_verified: true; }

export type ApiErrorCode = "validation_error" | "authorization_error" | "unsupported_capability" | "unsupported_schema_version" | "idempotency_conflict" | "stale_version" | "conflict" | "unavailable_host" | "internal_error";

export interface ApiError { code: ApiErrorCode; message: string; follow_up?: string; }
export interface ApiEnvelope<T> { ok: true; data: T; request_id?: string }
export interface ErrorEnvelope { ok: false; error: ApiError }
export type ApiResponse<T> = ApiEnvelope<T> | ErrorEnvelope;

export function createCoreServiceForPath(filename = ":memory:"): CoreService { return createCoreService(new AuthorityStore(filename)); }
export function createAuthorityStoreForCli(filename = ":memory:"): AuthorityStore { return new AuthorityStore(filename); }

const deferred = {
  "resource.revise": "evolve-engagement-memory",
  "resource.patch": "evolve-engagement-memory",
  "resource.relation": "evolve-engagement-memory",
  "resource.impact": "evolve-engagement-memory",
  "snapshot.import": "evolve-engagement-memory",
  "adapter.install": "integrate-native-host-adapters",
  "adapter.remove": "integrate-native-host-adapters",
  "adapter.config": "integrate-native-host-adapters",
  "deepseek.harness.install": "integrate-native-host-adapters",
  "hermes.plugin.install": "integrate-native-host-adapters",
  "storage.postgresql": "add-shared-authority-backend",
  "storage.backup": "evolve-engagement-memory",
  "storage.restore": "evolve-engagement-memory",
  "work.renew": "complete-taric-runtime-gaps",
  "work.reclaim": "complete-taric-runtime-gaps",
  "audit.reconcile": "complete-taric-runtime-gaps",
} as const;

const modelAllowed = new Set(["context.build", "context.query", "query", "resource.query", "evidence.query", "proposal.submit", "proposal.list", "checkpoint.propose", "action.recommend", "capability.status"]);
const hostRequired = new Set(["work.claim", "work.renew", "work.reclaim", "checkpoint.commit", "action.host-decision", "action.host-result", "action.reconcile"]);
const auditRequired = new Set(["audit.verify", "audit.doctor", "audit.reconcile", "snapshot.export", "engagement.init", "engagement.status", "capability.status"]);
const hostScoped = new Set(["engagement.status", "context.build", "context.query", "query", "resource.query", "evidence.query", "proposal.submit", "proposal.list", "action.recommend"]);
const operatorScoped = new Set(["engagement.status", "context.build", "context.query", "query", "resource.query", "evidence.query", "proposal.list", "proposal.submit", "capture.observation", "admission.evaluate", "capability.status"]);
const reviewerScoped = new Set(["review.submit", "review.get"]);

export interface CoreService {
  init(engagement: { id: string; name?: string; scope_ref?: string }): ApiResponse<CanonicalRecord>;
  status(): ApiResponse<Record<string, unknown>>;
  buildContext(principal: Principal, input: { engagement_id: string; budget?: number; include_candidates?: boolean }): ApiResponse<ContextPack>;
  query(principal: Principal, input: { engagement_id: string; as_of?: number; trust_level?: TrustLevel; include_candidates?: boolean }): ApiResponse<{ read_seq: number; records: CanonicalRecord[] }>;
  submitProposal(principal: Principal, input: { engagement_id: string; subject_type: string; base_version: number; content: CanonicalRecord }): ApiResponse<Record<string, unknown>>;
  submitReview(principal: Principal, input: { engagement_id: string; proposal_id: string; reviewer_id: string; reviewer_kind: "reviewer"; input_hash: string; verdict: "pass" | "reject" | "needs_evidence" | "defer"; policy_digest: string }): ApiResponse<Record<string, unknown>>;
  admitProposal(principal: Principal, input: { engagement_id: string; proposal_id: string; policy_digest: string; expected_base_version: number }): ApiResponse<Record<string, unknown>>;
  listProposals(principal: Principal, input: { engagement_id: string }): ApiResponse<Array<Record<string, unknown>>>;
  workClaim(principal: Principal, input: { engagement_id: string; work_item_id: string; host_id: string; agent_id: string; ttl_ms?: number }): ApiResponse<Record<string, unknown>>;
  checkpointPropose(principal: Principal, input: { engagement_id: string; work_run_id: string; checkpoint: Record<string, unknown> }): ApiResponse<Record<string, unknown>>;
  checkpointCommit(principal: Principal, input: { engagement_id: string; work_run_id: string; host_id: string; generation: number; checkpoint: Record<string, unknown> }): ApiResponse<Record<string, unknown>>;
  actionRecommend(principal: Principal, input: { engagement_id: string; work_run_id?: string; target: string; method: string; rationale: string }): ApiResponse<Record<string, unknown>>;
  actionHostDecision(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id?: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; host_decision_ref?: string; status: "authorized" | "denied" }): ApiResponse<Record<string, unknown>>;
  actionHostResult(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id?: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; status: "executed" | "failed" | "unknown"; result_ref?: string; host_decision_ref?: string }): ApiResponse<Record<string, unknown>>;
  actionReconcile(principal: Principal, input: { engagement_id: string; work_run_id: string; generation: number; result_ref: string; status: "executed" | "failed" }): ApiResponse<Record<string, unknown>>;
  observeControl(principal: Principal, input: ControlObservationInput): ApiResponse<Record<string, unknown>>;
  observeAccess(principal: Principal, input: AccessDecisionObservationInput): ApiResponse<Record<string, unknown>>;
  resume(principal: Principal, input: { engagement_id: string; work_run_id: string; host_id: string }): ApiResponse<Record<string, unknown>>;
  auditVerify(principal: Principal): ApiResponse<{ valid: boolean; errors: string[] }>;
  auditDoctor(principal: Principal): ApiResponse<Record<string, unknown>>;
  snapshotExport(principal: Principal, input: { engagement_id: string; as_of?: number }): ApiResponse<Record<string, unknown>>;
  capabilityStatus(principal?: Principal): ApiResponse<Record<string, unknown>>;
  dispatch(operation: string, principal: Principal, request: Record<string, unknown>): ApiResponse<unknown>;
}

export function createCoreService(store: AuthorityStore): CoreService {
  const api = {
    init(engagement: { id: string; name?: string; scope_ref?: string }) {
      const record = store.commit({ id: engagement.id, engagement_id: engagement.id, kind: "engagement", name: engagement.name ?? "engagement", scope_ref: engagement.scope_ref }, "L2");
      return { ok: true as const, data: record };
    },
    status() { return { ok: true as const, data: { schema_version: API_CONTRACT_VERSION, schema_supported: true } }; },
    buildContext(principal: Principal, input: { engagement_id: string; budget?: number; include_candidates?: boolean }) {
      const response = authorize(principal, "context.build", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: buildContextPack(store, input.engagement_id, input.budget ?? 4000, { includeCandidates: Boolean(input.include_candidates) }) }));
    },
    query(principal: Principal, input: { engagement_id: string; as_of?: number; trust_level?: TrustLevel; include_candidates?: boolean }) {
      const response = authorize(principal, "query", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.snapshot(input.engagement_id, { asOf: input.as_of, trustLevel: principal.role === "model" ? undefined : input.trust_level, includeCandidates: principal.role === "model" ? false : input.include_candidates }) }));
    },
    submitProposal(principal: Principal, input: { engagement_id: string; subject_type: string; base_version: number; content: CanonicalRecord }) {
      const response = authorize(principal, "proposal.submit", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => {
        if (!input.content || typeof input.content !== "object") return error("validation_error", "proposal content must be an object");
        if (["trust_level", "admission_status", "policy_result", "display_id"].some((field) => field in input.content)) return error("validation_error", "proposal cannot set privileged fields");
        const content = { ...input.content, engagement_id: input.engagement_id, trust_level: undefined, display_id: undefined };
        return { ok: true as const, data: store.submitProposal({ engagement_id: input.engagement_id, subject_type: input.subject_type, base_version: input.base_version, content }) as unknown as Record<string, unknown> };
      });
    },
    submitReview(principal: Principal, input: { engagement_id: string; proposal_id: string; reviewer_id: string; reviewer_kind: "reviewer"; input_hash: string; verdict: "pass" | "reject" | "needs_evidence" | "defer"; policy_digest: string }) {
      const response = authorize(principal, "review.submit", input.engagement_id);
      if (!response.ok) return response;
      if (input.reviewer_id !== principal.id || input.reviewer_kind !== "reviewer") return error("authorization_error", "reviewer identity is bound to the authenticated principal");
      return safe(() => {
        const proposal = store.proposals(input.engagement_id).find((item) => item.id === input.proposal_id);
        if (!proposal) return error("conflict", "proposal not found in this engagement");
        return { ok: true as const, data: store.submitReview({ proposal_id: input.proposal_id, reviewer_id: principal.id, reviewer_kind: "reviewer", input_hash: input.input_hash, verdict: input.verdict, policy_digest: input.policy_digest }) };
      });
    },
    admitProposal(principal: Principal, input: { engagement_id: string; proposal_id: string; policy_digest: string; expected_base_version: number }) {
      const response = authorize(principal, "admission.evaluate", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => {
        if (!store.proposals(input.engagement_id).some((item) => item.id === input.proposal_id)) return error("conflict", "proposal not found in this engagement");
        const result = store.admitProposal(input.proposal_id, input.policy_digest, { expectedBaseVersion: input.expected_base_version });
        return { ok: true as const, data: result as unknown as Record<string, unknown> };
      });
    },
    listProposals(principal: Principal, input: { engagement_id: string }) {
      const response = authorize(principal, "proposal.list", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.proposals(input.engagement_id) as unknown as Array<Record<string, unknown>> }));
    },
    workClaim(principal: Principal, input: { engagement_id: string; work_item_id: string; host_id: string; agent_id: string; ttl_ms?: number }) {
      const response = authorize(principal, "work.claim", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.claimWorkRun(input) }));
    },
    checkpointPropose(principal: Principal, input: { engagement_id: string; work_run_id: string; checkpoint: Record<string, unknown> }) {
      const response = authorize(principal, "checkpoint.propose", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.submitProposal({ engagement_id: input.engagement_id, subject_type: "checkpoint", base_version: 0, content: { id: input.work_run_id, engagement_id: input.engagement_id, kind: "checkpoint", checkpoint: input.checkpoint } }) as unknown as Record<string, unknown> }));
    },
    checkpointCommit(principal: Principal, input: { engagement_id: string; work_run_id: string; host_id: string; generation: number; checkpoint: Record<string, unknown> }) {
      const response = authorize(principal, "checkpoint.commit", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.commitCheckpoint(input.work_run_id, input.generation, input.host_id, input.checkpoint) }));
    },
    actionRecommend(principal: Principal, input: { engagement_id: string; work_run_id?: string; target: string; method: string; rationale: string }) {
      const response = authorize(principal, "action.recommend", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: { recommendation_id: store.submitProposal({ engagement_id: input.engagement_id, subject_type: "action_recommendation", base_version: 0, content: { id: `action-${input.target}-${input.method}`, engagement_id: input.engagement_id, kind: "action_intent", target: input.target, method: input.method, rationale: input.rationale } }).id } }));
    },
    actionHostDecision(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id?: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; host_decision_ref?: string; status: "authorized" | "denied" }) {
      const response = authorize(principal, "action.host-decision", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.recordActionIntent({ ...input, action_id: input.action_id, run_id: input.work_run_id, status: input.status }) }));
    },
    actionHostResult(principal: Principal, input: { engagement_id: string; work_run_id: string; action_id?: string; generation: number; mode: "llm_recommend" | "authorized_autonomous" | "host_hitl"; status: "executed" | "failed" | "unknown"; result_ref?: string; host_decision_ref?: string }) {
      const response = authorize(principal, "action.host-result", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.recordActionIntent({ ...input, action_id: input.action_id, run_id: input.work_run_id, status: input.status }) }));
    },
    actionReconcile(principal: Principal, input: { engagement_id: string; work_run_id: string; generation: number; result_ref: string; status: "executed" | "failed" }) {
      const response = authorize(principal, "action.reconcile", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.recordActionIntent({ run_id: input.work_run_id, generation: input.generation, mode: "host_hitl", status: input.status, result_ref: input.result_ref }) }));
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
    resume(principal: Principal, input: { engagement_id: string; work_run_id: string; host_id: string }) {
      const response = authorize(principal, "work.resume", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.resumePacket(input.work_run_id, input.host_id) }));
    },
    auditVerify(principal: Principal) {
      const response = authorize(principal, "audit.verify");
      if (!response.ok) return response;
      return { ok: true as const, data: store.verifyAudit() };
    },
    auditDoctor(principal: Principal) {
      const response = authorize(principal, "audit.doctor");
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.doctor() as unknown as Record<string, unknown> }));
    },
    snapshotExport(principal: Principal, input: { engagement_id: string; as_of?: number }) {
      const response = authorize(principal, "snapshot.export", input.engagement_id);
      if (!response.ok) return response;
      return safe(() => ({ ok: true as const, data: store.exportSnapshot(input.engagement_id, input.as_of) as unknown as Record<string, unknown> }));
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
        supported_operations: ["engagement.init", "engagement.status", "context.build", "query", "proposal.submit", "proposal.list", "checkpoint.propose", "action.recommend", "audit.verify", "capability.status"],
        unsupported_capabilities: { ...unsupported, ...deferred },
      } };
    }
  };
  return {
    ...api,
    dispatch(operation, principal, request) {
      if (Object.prototype.hasOwnProperty.call(deferred, operation)) return error("unsupported_capability", `operation is deferred to ${deferred[operation as keyof typeof deferred]}`, deferred[operation as keyof typeof deferred]);
      if (!request || typeof request !== "object" || Array.isArray(request)) return error("validation_error", "request must be an object");
      if (request.contract_version !== undefined && request.contract_version !== API_CONTRACT_VERSION) return error("unsupported_schema_version", "unsupported API contract version");
      const aliases: Record<string, string> = { "engagement.init": "init", "engagement.status": "status", "adapter.status": "capabilityStatus", "capability.status": "capabilityStatus", "audit.verify": "auditVerify", "audit.doctor": "auditDoctor", "snapshot.export": "snapshotExport", "context.build": "buildContext", "context.query": "buildContext", "proposal.submit": "submitProposal", "capture": "submitProposal", "capture.observation": "submitProposal", "proposal.list": "listProposals", "review.submit": "submitReview", "admission.evaluate": "admitProposal", "admission.commit": "admitProposal", "admission": "admitProposal", "work.claim": "workClaim", "checkpoint.propose": "checkpointPropose", "checkpoint.commit": "checkpointCommit", "action.recommend": "actionRecommend", "action.host-decision": "actionHostDecision", "action.host-result": "actionHostResult", "action.reconcile": "actionReconcile", "control.observe": "observeControl", "access.observe": "observeAccess", "work.resume": "resume", "resource.query": "query", "evidence.query": "query" };
      const methodName = aliases[operation] ?? operation;
      if (!Object.prototype.hasOwnProperty.call(api, methodName)) return error("unsupported_capability", "operation is not supported", "complete-taric-runtime-gaps");
      return safe(() => {
        if (methodName === "status") {
          const access = authorize(principal, "engagement.status");
          return access.ok ? api.status() as ApiResponse<unknown> : access;
        }
        if (methodName === "init") {
          const access = authorize(principal, "engagement.init");
          if (!access.ok) return access;
          if (typeof request.id !== "string" || request.id.length === 0) return error("validation_error", "engagement id is required");
          return api.init(request as { id: string; name?: string; scope_ref?: string }) as ApiResponse<unknown>;
        }
        if (methodName === "capabilityStatus") return api.capabilityStatus(principal) as ApiResponse<unknown>;
        const method = api[methodName as keyof typeof api] as (p: Principal, r: Record<string, unknown>) => ApiResponse<unknown>;
        return method(principal, request);
      });
    }
  };
}

function authorize(principal: Principal, operation: string, engagementId?: string): ApiResponse<{ principal: Principal }> {
  if (!principal?.id || !principal.role || principal.transport_verified !== true) return error("authorization_error", "transport-verified principal is required");
  if (operation in deferred) return error("unsupported_capability", "operation is deferred", deferred[operation as keyof typeof deferred]);
  if (engagementId && principal.engagement_id && principal.engagement_id !== engagementId) return error("authorization_error", "principal is not authorized for this engagement");
  if (modelAllowed.has(operation) && principal.role === "model") {
    if (operation !== "capability.status" && (!engagementId || !principal.engagement_id || principal.engagement_id !== engagementId)) return error("authorization_error", "principal is not authorized for this engagement");
    return { ok: true as const, data: { principal } };
  }
  if (hostScoped.has(operation) && principal.role === "host") {
    if (engagementId && (!principal.engagement_id || principal.engagement_id !== engagementId)) return error("authorization_error", "principal is not authorized for this engagement");
    return { ok: true as const, data: { principal } };
  }
  if (operatorScoped.has(operation) && principal.role === "operator") {
    if (engagementId && principal.engagement_id && principal.engagement_id !== engagementId) return error("authorization_error", "principal is not authorized for this engagement");
    return { ok: true as const, data: { principal } };
  }
  if (reviewerScoped.has(operation) && principal.role === "reviewer") {
    if (engagementId && (!principal.engagement_id || principal.engagement_id !== engagementId)) return error("authorization_error", "principal is not authorized for this engagement");
    return { ok: true as const, data: { principal } };
  }
  if (["admission.commit", "admission.evaluate", "control.observe", "access.observe"].includes(operation) && (principal.role === "operator" || principal.role === "host")) {
    if (engagementId && principal.engagement_id && principal.engagement_id !== engagementId) return error("authorization_error", "principal is not authorized for this engagement");
    return { ok: true as const, data: { principal } };
  }
  if (operation === "work.resume" && principal.role === "host") {
    if (!engagementId || !principal.engagement_id || principal.engagement_id !== engagementId) return error("authorization_error", "principal is not authorized for this engagement");
    return { ok: true as const, data: { principal } };
  }
  if (hostRequired.has(operation) && principal.role === "host") {
    if (!engagementId) return error("validation_error", "engagement_id is required");
    return { ok: true as const, data: { principal } };
  }
  if (auditRequired.has(operation) && principal.role === "operator") return { ok: true as const, data: { principal } };
  return error("authorization_error", "principal role is not authorized for this operation");
}
function safe<T>(operation: () => ApiResponse<T>): ApiResponse<T> {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof ContractValidationError) {
      const code: ApiErrorCode = cause.code === "unsupported_schema_version" || cause.code === "unsupported_capability" || cause.code === "idempotency_conflict" || cause.code === "conflict" ? cause.code : "validation_error";
      return error(code, cause.message, typeof cause.details === "string" ? cause.details : undefined);
    }
    const message = cause instanceof Error ? cause.message : "internal error";
    // 只有明确可识别的冲突语义才映射为 stale_version，其余一律 internal_error 且不泄漏堆栈。
    if (/stale|lease|generation|version conflict/i.test(message)) return error("stale_version", message);
    return error("internal_error", message);
  }
}
function error(code: ApiErrorCode, message: string, follow_up?: string): ErrorEnvelope { return { ok: false, error: { code, message, follow_up } }; }
