import { AuthorityStore, type CanonicalRecord, type TrustLevel } from "./store.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { uuidv7 } from "./identity.js";
import { buildContextPack, ContextBudgetError, type ContextPack } from "./context.js";
import { InvalidCursorError } from "./cursor-key.js";
import { TARIC_COMPATIBILITY_MANIFEST } from "./compatibility.js";
import { ContractValidationError, schemaValidator, validateContract, validateProposalEnvelope } from "./validation.js";
import { coreSchema, operationContract, operationContracts, SCHEMA_VERSION, type ContractName, type ProposalEnvelope, type ProposalCandidate, type PromotionL2 } from "@taric/schemas";
import { createAccessDecisionObservation, createControlObservation, type AccessDecisionObservationInput, type ControlObservationInput } from "./coverage.js";
import { ArtifactContentStore, type ArtifactBeginInput, type ArtifactAppendInput, type ArtifactBinaryAppendStreamInput, type ArtifactCommitInput } from "./artifact-content-store.js";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
export const API_CONTRACT_VERSION = "1.0.0" as const;
export type PrincipalRole = "model" | "host" | "reviewer" | "writer" | "operator";
/** principal 只能由 transport 创建，不能由请求 body 自行声明权限。 */
export type PrincipalCapability = "read" | "propose" | "review" | "admit" | "work" | "checkpoint" | "action" | "audit" | "operator" | "writer" | "content" | "content_read";
export interface ReviewerAttestation {
    capability: "deterministic" | "model" | "human";
    model?: string;
    prompt_digest?: string;
    ruleset_digest?: string;
}
export interface Principal {
    id: string;
    role: PrincipalRole;
    engagement_id?: string;
    /** Configured by a trusted transport; request bodies never populate this value. */
    transport_session_id?: string;
    capabilities?: readonly PrincipalCapability[];
    reviewer_attestation?: Readonly<ReviewerAttestation>;
    transport_verified: true;
}
// Transport adapters register principals here; callers cannot make an arbitrary
// object trusted by merely adding `transport_verified: true`.
const verifiedPrincipals = new WeakSet<object>();
const verifiedReviewerAttestations = new WeakMap<object, Readonly<ReviewerAttestation>>();
const verifiedTransportSessions = new WeakMap<object, string>();
export function registerTransportPrincipal<T extends Principal>(principal: T): T {
    if (principal.transport_session_id !== undefined) {
        if (principal.role !== "host" || typeof principal.transport_session_id !== "string" || !principal.transport_session_id.trim() || principal.transport_session_id.length > 256)
            throw new ContractValidationError("validation_error", "transport session association requires a host principal and a bounded session id");
        verifiedTransportSessions.set(principal, principal.transport_session_id);
    }
    const attestation = principal.reviewer_attestation;
    if (attestation) {
        if (principal.role !== "reviewer" || !["deterministic", "model", "human"].includes(attestation.capability))
            throw new ContractValidationError("validation_error", "reviewer attestation requires a reviewer transport identity");
        if (attestation.model !== undefined && (typeof attestation.model !== "string" || !attestation.model.trim()))
            throw new ContractValidationError("validation_error", "reviewer model attestation must be a nonempty string");
        for (const field of ["prompt_digest", "ruleset_digest"] as const)
            if (attestation[field] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(attestation[field]!))
                throw new ContractValidationError("validation_error", "reviewer attestation digests must be SHA-256");
        verifiedReviewerAttestations.set(principal, Object.freeze({ ...attestation }));
    }
    verifiedPrincipals.add(principal as unknown as object);
    return principal;
}
export type ApiErrorCode = "validation_error" | "authorization_error" | "unsupported_capability" | "unsupported_schema_version" | "idempotency_conflict" | "stale_version" | "conflict" | "unavailable_host" | "invalid_cursor" | "minimum_budget_required" | "internal_error";
export interface ApiError {
    code: ApiErrorCode;
    message: string;
    follow_up?: string;
}
export interface ApiEnvelope<T> {
    ok: true;
    data: T;
    request_id?: string;
}
export interface ErrorEnvelope {
    ok: false;
    error: ApiError;
}
export type ApiResponse<T> = ApiEnvelope<T> | ErrorEnvelope;
export async function createCoreServiceForPath(filename = ":memory:", configuredContentRoot?: string): Promise<CoreService> { return (await createCoreService(new AuthorityStore(filename), configuredContentRoot ?? process.env.TARIC_CONTENT_ROOT ?? (filename === ":memory:" ? join(tmpdir(), "taric-content", uuidv7()) : join(dirname(filename), "content")))); }
export function createAuthorityStoreForCli(filename = ":memory:"): AuthorityStore { return new AuthorityStore(filename); }
const deferred = {
    "snapshot.import": "evolve-engagement-memory",
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
function readAdapterConfig(): Record<string, unknown> { try {
    const value = JSON.parse(readFileSync(adapterConfigPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
catch {
    return {};
} }
function saveAdapterConfig(value: Record<string, unknown>) { const path = adapterConfigPath(); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function containsCheckpointReasoning(value: unknown): boolean {
    if (Array.isArray(value))
        return value.some(containsCheckpointReasoning);
    if (!value || typeof value !== "object")
        return false;
    return Object.entries(value as Record<string, unknown>).some(([key, item]) => checkpointReasoningFields.has(key) || containsCheckpointReasoning(item));
}
function publicArtifactMetadata(row: import("./artifact-content-store.js").ArtifactRow): Record<string, unknown> {
    const { relative_dir: _relativeDir, manifest_path: _manifestPath, ...metadata } = row;
    return metadata;
}
function sanitizeModelValue(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(sanitizeModelValue).filter((item) => item !== undefined);
    if (!value || typeof value !== "object")
        return value;
    const record = value as Record<string, unknown>;
    if (typeof record.content_ref === "string") {
        const allowed = new Set(["content_ref", "artifact_id", "version", "storage_mode", "content_status", "integrity_status", "payload_kind", "media_type", "byte_length", "chunk_count", "content_hash", "manifest_hash", "captured_at", "stored_at", "provenance_ref", "derived_from", "child_refs"]);
        return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, sanitizeModelValue(item)]));
    }
    if (Object.prototype.hasOwnProperty.call(record, "host_ref"))
        return undefined;
    return Object.fromEntries(Object.entries(record).filter(([key]) => !/(?:location|summary|cookie|header|url|token|secret|credential|private_path|artifact_body|raw_artifact)/i.test(key)).map(([key, item]) => [key, sanitizeModelValue(item)]));
}
function sanitizeModelRecord(record: CanonicalRecord): CanonicalRecord {
    return sanitizeModelValue(record) as CanonicalRecord;
}
export interface CoreService {
    close(): Promise<void>;
    init(engagement: {
        name?: string;
        scope?: {
            allowed_targets: string[];
            excluded_targets: string[];
            rules_of_engagement_ref: string;
        };
    }): Promise<ApiResponse<CanonicalRecord>>;
    status(): Promise<ApiResponse<Record<string, unknown>>>;
    buildContext(principal: Principal, input: {
        engagement_id: string;
        budget?: number;
        include_candidates?: boolean;
        work_item_id?: string;
        worker_role?: string;
        policy_version?: string;
        read_seq?: number;
        cursor?: string;
        filters?: Record<string, unknown>;
        ordering?: string;
        checkpoint?: Record<string, unknown>;
        resume_from_seq?: number;
        pending_actions?: Array<Record<string, unknown>>;
    }): Promise<ApiResponse<ContextPack>>;
    query(principal: Principal, input: {
        engagement_id: string;
        as_of?: number;
        trust_level?: TrustLevel;
        include_candidates?: boolean;
        cursor?: string;
        page_size?: number;
        kind?: string;
    }): Promise<ApiResponse<Awaited<ReturnType<AuthorityStore["recordsPage"]>>>>;
    submitProposal(principal: Principal, input: ProposalEnvelope & {
        work_run_id?: string;
        generation?: number;
        idempotency_key?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    captureObservation(principal: Principal, input: {
        engagement_id: string;
        observation?: ProposalCandidate;
        subject_type?: string;
        expected_version?: number;
        target_id?: string;
        content?: ProposalCandidate;
        work_run_id?: string;
        generation?: number;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    submitReview(principal: Principal, input: {
        engagement_id: string;
        proposal_id: string;
        reviewer_id: string;
        reviewer_kind: "reviewer";
        input_hash: string;
        verdict: "pass" | "reject" | "needs_evidence" | "defer";
        policy_digest: string;
        evidence_snapshot_hash?: string;
        rubric_hash?: string;
        limitations?: string[];
        idempotency_key?: string;
        reviewer_capability?: "deterministic" | "model" | "human";
        reviewer_model?: string;
        prompt_digest?: string;
        ruleset_digest?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    admitProposal(principal: Principal, input: {
        engagement_id: string;
        proposal_id: string;
        policy_digest: string;
        expected_version: number;
        idempotency_key?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    promoteFinding(principal: Principal, input: PromotionL2): Promise<ApiResponse<Record<string, unknown>>>;
    listProposals(principal: Principal, input: {
        engagement_id: string;
        cursor?: string;
        page_size?: number;
    }): Promise<ApiResponse<Awaited<ReturnType<AuthorityStore["proposalsPage"]>>>>;
    workClaim(principal: Principal, input: {
        engagement_id: string;
        work_item_id: string;
        host_id: string;
        agent_id: string;
        ttl_ms?: number;
        task_session_ref?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    workRenew(principal: Principal, input: {
        engagement_id: string;
        work_run_id: string;
        generation: number;
        ttl_ms?: number;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    workReclaim(principal: Principal, input: {
        engagement_id: string;
        work_run_id: string;
        agent_id: string;
        ttl_ms?: number;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    auditReconcile(principal: Principal, input?: {
        action?: "preview" | "replay" | "rebuild" | "reconcile";
    }): Promise<ApiResponse<Record<string, unknown>>>;
    errorReport(principal: Principal, input: {
        engagement_id: string;
        work_run_id?: string;
        generation?: number;
        error_ref?: string;
        message?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    checkpointPropose(principal: Principal, input: {
        engagement_id: string;
        work_run_id: string;
        generation: number;
        checkpoint: Record<string, unknown>;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    checkpointCommit(principal: Principal, input: {
        engagement_id: string;
        work_run_id: string;
        host_id: string;
        generation: number;
        checkpoint: Record<string, unknown>;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    actionRecommend(principal: Principal, input: {
        engagement_id: string;
        work_run_id?: string;
        generation?: number;
        target: string;
        method: string;
        rationale: string;
        uncertainty?: string;
        scope?: string;
        constraints?: string[];
        limitations?: string[];
        memory_refs?: string[];
        evidence_refs?: string[];
    }): Promise<ApiResponse<Record<string, unknown>>>;
    actionHostDecision(principal: Principal, input: {
        engagement_id: string;
        work_run_id: string;
        action_id: string;
        generation: number;
        mode: "llm_recommend" | "authorized_autonomous" | "host_hitl";
        host_decision_ref?: string;
        status: "authorized" | "denied";
    }): Promise<ApiResponse<Record<string, unknown>>>;
    actionHostResult(principal: Principal, input: {
        engagement_id: string;
        work_run_id: string;
        action_id: string;
        generation: number;
        mode: "llm_recommend" | "authorized_autonomous" | "host_hitl";
        status: "executed" | "failed" | "unknown";
        result_ref?: string;
        host_decision_ref?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    actionReconcile(principal: Principal, input: {
        engagement_id: string;
        work_run_id: string;
        action_id: string;
        generation: number;
        result_ref: string;
        status: "executed" | "failed";
    }): Promise<ApiResponse<Record<string, unknown>>>;
    observeControl(principal: Principal, input: ControlObservationInput): Promise<ApiResponse<Record<string, unknown>>>;
    observeAccess(principal: Principal, input: AccessDecisionObservationInput): Promise<ApiResponse<Record<string, unknown>>>;
    controlList(principal: Principal, input: {
        engagement_id: string;
    }): Promise<ApiResponse<Array<Record<string, unknown>>>>;
    hostState(principal: Principal, input: { engagement_id: string; limit?: number }): Promise<ApiResponse<Record<string, unknown>>>;
    resume(principal: Principal, input: {
        engagement_id: string;
        work_run_id: string;
        host_id: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    auditVerify(principal: Principal): Promise<ApiResponse<Awaited<ReturnType<AuthorityStore["verifyAudit"]>>>>;
    auditDoctor(principal: Principal): Promise<ApiResponse<Record<string, unknown>>>;
    snapshotExport(principal: Principal, input: {
        engagement_id: string;
        as_of?: number;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    snapshotImport(principal: Principal, input: {
        engagement_id: string;
        snapshot: unknown;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    adapterStatus(principal: Principal): Promise<ApiResponse<Record<string, unknown>>>;
    resourceRevise(principal: Principal, input: Record<string, unknown>): Promise<ApiResponse<Record<string, unknown>>>;
    resourcePatch(principal: Principal, input: Record<string, unknown>): Promise<ApiResponse<Record<string, unknown>>>;
    resourceRelation(principal: Principal, input: Record<string, unknown>): Promise<ApiResponse<Record<string, unknown>>>;
    resourceImpact(principal: Principal, input: {
        engagement_id: string;
        source_id: string;
        limit?: number;
        continuation?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    artifactSessionBind(principal: Principal, input: {
        engagement_id: string;
        session_id: string;
        root: string;
        mode: "host-session" | "run-bound";
        work_run_id?: string;
        attempt_id?: string;
        generation?: number;
        owner_host?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    artifactStoreBegin(principal: Principal, input: ArtifactBeginInput): Promise<ApiResponse<Record<string, unknown>>>;
    artifactStoreAppend(principal: Principal, input: ArtifactAppendInput): Promise<ApiResponse<Record<string, unknown>>>;
    artifactStoreAppendBinaryStream(principal: Principal, input: ArtifactBinaryAppendStreamInput, source: AsyncIterable<Uint8Array>): Promise<ApiResponse<Record<string, unknown>>>;
    artifactStoreCommit(principal: Principal, input: ArtifactCommitInput): Promise<ApiResponse<Record<string, unknown>>>;
    artifactMetadata(principal: Principal, input: {
        engagement_id: string;
        session_id: string;
        content_ref: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    artifactContentRead(principal: Principal, input: {
        engagement_id: string;
        session_id: string;
        content_ref: string;
        offset?: number;
        length?: number;
        chunk_cursor?: string;
        max_response_bytes?: number;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    artifactContentList(principal: Principal, input: {
        engagement_id: string;
        session_id: string;
        cursor?: string;
        page_size?: number;
        category?: string;
        media_type?: string;
        work_run_id?: string;
        include_content?: boolean;
        max_response_bytes?: number;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    artifactSessionOutput(principal: Principal, input: {
        engagement_id: string;
        session_id: string;
        cursor?: string;
        execution_cursor?: string;
        page_size?: number;
        include_content?: boolean;
        max_response_bytes?: number;
        work_run_id?: string;
        attempt_id?: string;
    }): Promise<ApiResponse<Record<string, unknown>>>;
    capabilityStatus(principal?: Principal): Promise<ApiResponse<Record<string, unknown>>>;
    dispatch(operation: string, principal: Principal, request: Record<string, unknown>): Promise<ApiResponse<unknown>>;
}
export async function createCoreService(store: AuthorityStore, contentRoot = process.env.TARIC_CONTENT_ROOT ?? defaultContentRoot(store)): Promise<CoreService> {
    await store.ready;
    const artifactStore = new ArtifactContentStore(contentRoot, store);
    await artifactStore.initialize();
    const api = {
        async init(engagement: {
            name?: string;
            scope?: {
                allowed_targets: string[];
                excluded_targets: string[];
                rules_of_engagement_ref: string;
            };
        }) {
            return (await safe(async () => ({ ok: true as const, data: (await store.initializeEngagement(engagement)) })));
        },
        async status() { return { ok: true as const, data: { schema_version: API_CONTRACT_VERSION, schema_supported: true } }; },
        async artifactSessionBind(principal: Principal, input: {
            engagement_id: string;
            session_id: string;
            root: string;
            mode: "host-session" | "run-bound";
            work_run_id?: string;
            attempt_id?: string;
            generation?: number;
            owner_host?: string;
        }) {
            const access = authorize(principal, "artifact.session.bind", input.engagement_id);
            if (!access.ok)
                return access;
            const transportSession = verifiedTransportSessions.get(principal);
            if (transportSession !== undefined && input.session_id !== transportSession)
                return error("authorization_error", "session binding must match the trusted transport session");
            if (input.mode === "run-bound" && input.owner_host !== principal.id)
                return error("authorization_error", "run-bound session owner must match the transport principal");
            return (await safe(async () => { const { root: _root, ...binding } = (await artifactStore.bind(input, principal.id)); return { ok: true as const, data: binding as unknown as Record<string, unknown> }; }));
        },
        async artifactStoreBegin(principal: Principal, input: ArtifactBeginInput) {
            const access = authorize(principal, "artifact.store.begin", input.engagement_id);
            if (!access.ok)
                return access;
            const sessionError = checkArtifactTransportSession(principal, input.session_id);
            if (sessionError)
                return sessionError;
            return (await safe(async () => ({ ok: true as const, data: (await artifactStore.begin(input, principal.id)) })));
        },
        async artifactStoreAppend(principal: Principal, input: ArtifactAppendInput) {
            const access = authorize(principal, "artifact.store.append", input.engagement_id);
            if (!access.ok)
                return access;
            const sessionError = checkArtifactTransportSession(principal, input.session_id);
            if (sessionError)
                return sessionError;
            return (await safe(async () => ({ ok: true as const, data: (await artifactStore.append(input, principal.id)) })));
        },
        async artifactStoreAppendBinaryStream(principal: Principal, input: ArtifactBinaryAppendStreamInput, source: AsyncIterable<Uint8Array>) {
            const access = authorize(principal, "artifact.store.append", input.engagement_id);
            if (!access.ok)
                return access;
            const sessionError = checkArtifactTransportSession(principal, input.session_id);
            if (sessionError)
                return sessionError;
            return (await safe(async () => ({ ok: true as const, data: (await artifactStore.appendBinaryStream(input, principal.id, source)) })));
        },
        async artifactStoreCommit(principal: Principal, input: ArtifactCommitInput) {
            const access = authorize(principal, "artifact.store.commit", input.engagement_id);
            if (!access.ok)
                return access;
            const sessionError = checkArtifactTransportSession(principal, input.session_id);
            if (sessionError)
                return sessionError;
            return (await safe(async () => ({ ok: true as const, data: publicArtifactMetadata((await artifactStore.commit(input, principal.id))) })));
        },
        async artifactMetadata(principal: Principal, input: {
            engagement_id: string;
            session_id: string;
            content_ref: string;
        }) {
            const access = authorize(principal, "artifact.metadata", input.engagement_id);
            if (!access.ok)
                return access;
            const sessionError = checkArtifactTransportSession(principal, input.session_id);
            if (sessionError)
                return sessionError;
            return (await safe(async () => ({ ok: true as const, data: (await artifactStore.metadata(input)) })));
        },
        async artifactContentRead(principal: Principal, input: {
            engagement_id: string;
            session_id: string;
            content_ref: string;
            offset?: number;
            length?: number;
            chunk_cursor?: string;
            max_response_bytes?: number;
        }) {
            const access = authorize(principal, "artifact.content.read", input.engagement_id);
            if (!access.ok)
                return access;
            const sessionError = checkArtifactTransportSession(principal, input.session_id);
            if (sessionError)
                return sessionError;
            return (await safe(async () => ({ ok: true as const, data: (await artifactStore.readBounded({ ...input, principal_id: principal.id })) })));
        },
        async artifactContentList(principal: Principal, input: {
            engagement_id: string;
            session_id: string;
            cursor?: string;
            page_size?: number;
            category?: string;
            media_type?: string;
            work_run_id?: string;
            include_content?: boolean;
        max_response_bytes?: number;
        }) {
            const access = authorize(principal, "artifact.content.list", input.engagement_id);
            if (!access.ok)
                return access;
            if ((input as typeof input & {
                include_content?: boolean;
            }).include_content) {
                const rawAccess = authorize(principal, "artifact.content.read", input.engagement_id);
                if (!rawAccess.ok)
                    return rawAccess;
            }
            const sessionError = checkArtifactTransportSession(principal, input.session_id);
            if (sessionError)
                return sessionError;
            return (await safe(async () => ({ ok: true as const, data: (await artifactStore.list({ ...input, principal_id: principal.id })) })));
        },
        async artifactSessionOutput(principal: Principal, input: {
            engagement_id: string;
            session_id: string;
            cursor?: string;
            execution_cursor?: string;
            page_size?: number;
            include_content?: boolean;
            max_response_bytes?: number;
            work_run_id?: string;
            attempt_id?: string;
        }) {
            const access = authorize(principal, "artifact.session.output", input.engagement_id);
            if (!access.ok)
                return access;
            if (input.include_content) {
                const rawAccess = authorize(principal, "artifact.content.read", input.engagement_id);
                if (!rawAccess.ok)
                    return rawAccess;
            }
            const sessionError = checkArtifactTransportSession(principal, input.session_id);
            if (sessionError)
                return sessionError;
            return (await safe(async () => ({ ok: true as const, data: (await artifactStore.output({ ...input, principal_id: principal.id })) })));
        },
        async buildContext(principal: Principal, input: {
            engagement_id: string;
            budget?: number;
            include_candidates?: boolean;
            work_item_id?: string;
            worker_role?: string;
            policy_version?: string;
            read_seq?: number;
            cursor?: string;
            filters?: Record<string, unknown>;
            ordering?: string;
            checkpoint?: Record<string, unknown>;
            resume_from_seq?: number;
            pending_actions?: Array<Record<string, unknown>>;
        }) {
            const response = authorize(principal, "context.build", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await buildContextPack(store, input.engagement_id, input.budget ?? 4000, { includeCandidates: Boolean(input.include_candidates), principalId: principal.id, workItemId: input.work_item_id, workerRole: input.worker_role, policyVersion: input.policy_version, readSeq: input.read_seq, cursor: input.cursor, filters: input.filters, ordering: input.ordering, checkpoint: input.checkpoint, resumeFromSeq: input.resume_from_seq, pendingActions: input.pending_actions, cursorKeyRoot: contentRoot } as never)) })));
        },
        async query(principal: Principal, input: {
            engagement_id: string;
            as_of?: number;
            trust_level?: TrustLevel;
            include_candidates?: boolean;
            cursor?: string;
            page_size?: number;
            kind?: string;
        }) {
            const response = authorize(principal, "query", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => { const page = (await store.recordsPage({ ...input, principal_id: principal.id, cursor_key_root: contentRoot, trust_level: principal.role === "model" ? undefined : input.trust_level, include_candidates: principal.role === "model" ? false : input.include_candidates })); return { ok: true as const, data: principal.role === "model" ? { ...page, records: page.records.map(sanitizeModelRecord) } : page }; }));
        },
        async submitProposal(principal: Principal, input: ProposalEnvelope & {
            work_run_id?: string;
            generation?: number;
            idempotency_key?: string;
        }) {
            const response = authorize(principal, "proposal.submit", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const allowed = new Set(["engagement_id", "subject_type", "expected_version", "proposal_id", "client_request_id", "target_id", "subject_ref", "content", "work_run_id", "generation", "idempotency_key", "contract_version"]);
                if (Object.keys(input).some((field) => !allowed.has(field)))
                    return error("validation_error", "proposal envelope contains unsupported fields");
                const { work_run_id, generation, idempotency_key, contract_version: _contractVersion, ...envelope } = input as typeof input & {
                    contract_version?: string;
                };
                validateProposalEnvelope(envelope);
                const sessionError = await checkHostTransportSession(store, principal, input.engagement_id, {
                    work_run_id: work_run_id ?? (typeof input.content.work_run_ref === "string" ? input.content.work_run_ref : undefined),
                    generation: generation ?? (typeof input.content.generation === "number" ? input.content.generation : undefined),
                    content: input.content as Record<string, unknown>,
                    request: input as unknown as Record<string, unknown>,
                });
                if (sessionError)
                    return sessionError;
                const content = { ...input.content, provenance: { ...(input.content.provenance ?? {}), host_id: principal.id, producer_id: principal.id, source_kind: principal.role === "model" ? "model" : "host" } } as ProposalCandidate;
                const attribution = await hostTransportAttribution(store, principal, input.engagement_id, work_run_id ?? (typeof content.work_run_ref === "string" ? content.work_run_ref : undefined), generation ?? (typeof content.generation === "number" ? content.generation : undefined));
                return { ok: true as const, data: (await store.submitProposal({ ...envelope, content }, { idempotencyKey: idempotency_key, operation: "proposal.submit", principal: principal.id, engagement_id: input.engagement_id, workRunId: work_run_id ?? (typeof content.work_run_ref === "string" ? content.work_run_ref : undefined), attemptId: attribution?.attempt_id ?? (typeof content.attempt_ref === "string" ? content.attempt_ref : undefined), sessionId: attribution?.session_id, generation: generation ?? (typeof content.generation === "number" ? content.generation : undefined), principalRole: principal.role })) as unknown as Record<string, unknown> };
            }));
        },
        async captureObservation(principal: Principal, input: {
            engagement_id: string;
            observation?: ProposalCandidate;
            subject_type?: string;
            expected_version?: number;
            target_id?: string;
            content?: ProposalCandidate;
            work_run_id?: string;
            generation?: number;
        }) {
            const response = authorize(principal, "capture.observation", input.engagement_id);
            if (!response.ok)
                return response;
            const sessionError = await checkHostTransportSession(store, principal, input.engagement_id, { work_run_id: input.work_run_id, generation: input.generation, content: input.observation ?? input.content as Record<string, unknown>, request: input as unknown as Record<string, unknown> });
            if (sessionError)
                return sessionError;
            const content = input.observation ?? input.content;
            if (!content || typeof content !== "object")
                return error("validation_error", "observation is required");
            return (await api.submitProposal(principal, {
                engagement_id: input.engagement_id,
                subject_type: input.subject_type ?? "observation",
                expected_version: input.expected_version ?? 0,
                target_id: input.target_id,
                content,
                work_run_id: input.work_run_id,
                generation: input.generation,
            }));
        },
        async submitReview(principal: Principal, input: {
            engagement_id: string;
            proposal_id: string;
            reviewer_id: string;
            reviewer_kind: "reviewer";
            input_hash: string;
            verdict: "pass" | "reject" | "needs_evidence" | "defer";
            policy_digest: string;
            evidence_snapshot_hash?: string;
            rubric_hash?: string;
            limitations?: string[];
            idempotency_key?: string;
            reviewer_capability?: "deterministic" | "model" | "human";
            reviewer_model?: string;
            prompt_digest?: string;
            ruleset_digest?: string;
        }) {
            const response = authorize(principal, "review.submit", input.engagement_id);
            if (!response.ok)
                return response;
            if (input.reviewer_id !== principal.id || input.reviewer_kind !== "reviewer")
                return error("authorization_error", "reviewer identity is bound to the authenticated principal");
            if (["reviewer_capability", "reviewer_model", "prompt_digest", "ruleset_digest"].some((field) => Object.prototype.hasOwnProperty.call(input, field)))
                return error("authorization_error", "reviewer attestation is assigned by the authenticated transport");
            return (await safe(async () => {
                const proposal = (await store.proposals(input.engagement_id)).find((item) => item.id === input.proposal_id);
                if (!proposal)
                    return error("conflict", "proposal not found in this engagement");
                const attestation = verifiedReviewerAttestations.get(principal);
                return { ok: true as const, data: (await store.submitReview({ proposal_id: input.proposal_id, reviewer_id: principal.id, reviewer_kind: "reviewer", input_hash: input.input_hash, verdict: input.verdict, policy_digest: input.policy_digest, evidence_snapshot_hash: input.evidence_snapshot_hash, rubric_hash: input.rubric_hash, limitations: input.limitations, idempotencyKey: input.idempotency_key, principal: principal.id, reviewer_capability: attestation?.capability ?? "model", reviewer_model: attestation?.model, prompt_digest: attestation?.prompt_digest, ruleset_digest: attestation?.ruleset_digest })) };
            }));
        },
        async admitProposal(principal: Principal, input: {
            engagement_id: string;
            proposal_id: string;
            policy_digest: string;
            expected_version: number;
            idempotency_key?: string;
        }) {
            const response = authorize(principal, "admission.evaluate", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                if (!(await store.proposals(input.engagement_id)).some((item) => item.id === input.proposal_id))
                    return error("conflict", "proposal not found in this engagement");
                if (!Number.isInteger(input.expected_version) || input.expected_version < 0 || !/^sha256:[a-f0-9]{64}$/.test(input.policy_digest))
                    return error("validation_error", "admission requires expected_version and a policy digest");
                const result = (await store.admitProposal(input.proposal_id, input.policy_digest, { expectedBaseVersion: input.expected_version, idempotencyKey: input.idempotency_key, operation: "admission.evaluate", principal: principal.id, engagement_id: input.engagement_id }));
                return { ok: true as const, data: result as unknown as Record<string, unknown> };
            }));
        },
        async promoteFinding(principal: Principal, input: PromotionL2) {
            const response = authorize(principal, "admission.promote_l2", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const validate = schemaValidator.compile({ $defs: coreSchema.$defs, $ref: "#/$defs/promotionL2" });
                if (!validate(input))
                    return error("validation_error", "invalid L2 promotion request");
                if (!(await store.proposals(input.engagement_id)).some((proposal) => proposal.id === input.proposal_id))
                    return error("conflict", "proposal not found in this engagement");
                const result = (await store.promoteFinding(input.proposal_id, { expectedBaseVersion: input.expected_version, policyDigest: input.policy_digest, targetId: input.target_id, inputHash: input.input_hash, evidenceSnapshotHash: input.evidence_snapshot_hash, reviewRefs: input.review_refs, idempotencyKey: input.idempotency_key, principal: principal.id }));
                if (!result.ok)
                    return error("validation_error", result.reason ?? "L2 policy gates rejected promotion");
                return { ok: true as const, data: result as unknown as Record<string, unknown> };
            }));
        },
        async listProposals(principal: Principal, input: {
            engagement_id: string;
            cursor?: string;
            page_size?: number;
        }) {
            const response = authorize(principal, "proposal.list", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.proposalsPage({ ...input, principal_id: principal.id, cursor_key_root: contentRoot })) })));
        },
        async workClaim(principal: Principal, input: {
            engagement_id: string;
            work_item_id: string;
            host_id: string;
            agent_id: string;
            ttl_ms?: number;
            task_session_ref?: string;
        }) {
            const response = authorize(principal, "work.claim", input.engagement_id);
            if (!response.ok)
                return response;
            const sessionId = verifiedTransportSessions.get(principal);
            if (input.task_session_ref !== undefined && input.task_session_ref !== sessionId)
                return error("authorization_error", "task session association is assigned by the trusted transport");
            return (await safe(async () => ({ ok: true as const, data: (await store.claimWorkRun({ ...input, task_session_ref: sessionId, host_id: principal.id })) })));
        },
        async workRenew(principal: Principal, input: {
            engagement_id: string;
            work_run_id: string;
            generation: number;
            ttl_ms?: number;
        }) {
            const response = authorize(principal, "work.renew", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.renewWorkRun(input.work_run_id, input.generation, principal.id, input.ttl_ms)) })));
        },
        async workReclaim(principal: Principal, input: {
            engagement_id: string;
            work_run_id: string;
            agent_id: string;
            ttl_ms?: number;
        }) {
            const response = authorize(principal, "work.reclaim", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const run = (await store.getWorkRun(input.work_run_id));
                if (!run || run.engagement_id !== input.engagement_id)
                    return error("conflict", "work run not found");
                return { ok: true as const, data: (await store.reclaimWorkRun(input.work_run_id, principal.id, input.agent_id, input.ttl_ms)) };
            }));
        },
        async auditReconcile(principal: Principal, input: {
            action?: "preview" | "replay" | "rebuild" | "reconcile";
        } = {}) {
            const response = authorize(principal, "audit.reconcile");
            if (!response.ok)
                return response;
            return (await safe<Record<string, unknown>>(async () => {
                if (input.action !== undefined && !["preview", "replay", "rebuild", "reconcile"].includes(input.action))
                    return error("validation_error", "audit reconcile action must be preview, replay, rebuild, or reconcile");
                if (input.action === "preview")
                    return { ok: true as const, data: (await store.maintenanceRead(async () => ({ ...(await store.previewRecovery()), artifacts: (await artifactStore.reconcile({ read_only: true })) }))) };
                const source = (await store.maintenanceRead((watermarks) => watermarks));
                const result = input.action ? (await store.reconcileDerived(input.action)) : { applied: (await store.consumeOutbox()) };
                const artifacts = input.action === "reconcile" || !input.action ? (await artifactStore.reconcile()) : undefined;
                return { ok: true as const, data: (await store.maintenanceRead((watermarks) => ({ ...result, artifacts, source_read_seq: source.read_seq, read_seq: watermarks.read_seq, watermarks: { committed_seq: watermarks.committed_seq, projected_seq: watermarks.projected_seq } }))) };
            }));
        },
        async errorReport(principal: Principal, input: {
            engagement_id: string;
            work_run_id?: string;
            generation?: number;
            error_ref?: string;
            message?: string;
        }) {
            const response = authorize(principal, "error.report", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.recordHostError({ ...input, host_id: principal.id })) })));
        },
        async checkpointPropose(principal: Principal, input: {
            engagement_id: string;
            work_run_id: string;
            generation: number;
            checkpoint: Record<string, unknown>;
        }) {
            const response = authorize(principal, "checkpoint.propose", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const sessionError = await checkHostTransportSession(store, principal, input.engagement_id, { work_run_id: input.work_run_id, generation: input.generation, request: input as unknown as Record<string, unknown> });
                if (sessionError)
                    return sessionError;
                if (!Number.isInteger(input.generation) || input.generation < 1)
                    return error("validation_error", "current generation is required");
                const run = (await store.getWorkRun(input.work_run_id));
                if (!run || run.engagement_id !== input.engagement_id)
                    return error("conflict", "work run not found");
                if (containsCheckpointReasoning(input.checkpoint))
                    return error("validation_error", "checkpoint proposal cannot contain hidden reasoning");
                const workItem = (await store.get(String(run.work_item_id)));
                if (!workItem || workItem.engagement_id !== input.engagement_id)
                    return error("conflict", "WorkItem is unavailable");
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
                const { id: _id, ...candidate } = content;
                return { ok: true as const, data: (await store.submitProposal({ engagement_id: input.engagement_id, subject_type: "checkpoint", expected_version: 0, content: candidate as ProposalCandidate }, { operation: "checkpoint.propose", principal: principal.id, engagement_id: input.engagement_id, workRunId: input.work_run_id, generation: input.generation, principalRole: principal.role })) as unknown as Record<string, unknown> };
            }));
        },
        async checkpointCommit(principal: Principal, input: {
            engagement_id: string;
            work_run_id: string;
            host_id: string;
            generation: number;
            checkpoint: Record<string, unknown>;
        }) {
            const response = authorize(principal, "checkpoint.commit", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const sessionError = await checkHostTransportSession(store, principal, input.engagement_id, { work_run_id: input.work_run_id, generation: input.generation, request: input as unknown as Record<string, unknown> });
                if (sessionError)
                    return sessionError;
                return { ok: true as const, data: (await store.commitCheckpoint(input.work_run_id, input.generation, principal.id, input.checkpoint)) };
            }));
        },
        async actionRecommend(principal: Principal, input: {
            engagement_id: string;
            work_run_id?: string;
            generation?: number;
            target: string;
            method: string;
            rationale: string;
            uncertainty?: string;
            scope?: string;
            constraints?: string[];
            limitations?: string[];
            memory_refs?: string[];
            evidence_refs?: string[];
        }) {
            const response = authorize(principal, "action.recommend", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const allowed = new Set(["engagement_id", "work_run_id", "generation", "target", "method", "rationale", "uncertainty", "scope", "constraints", "limitations", "memory_refs", "evidence_refs"]);
                if (Object.keys(input as unknown as Record<string, unknown>).some((key) => !allowed.has(key)))
                    return error("validation_error", "action recommendation contains unsupported fields");
                if (![input.target, input.method, input.rationale].every((value) => typeof value === "string" && value.trim().length > 0))
                    return error("validation_error", "target, method and rationale are required");
                for (const field of ["constraints", "limitations", "memory_refs", "evidence_refs"] as const) {
                    if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field]!.some((value) => typeof value !== "string")))
                        return error("validation_error", `${field} must be a string array`);
                }
                const sessionError = await checkHostTransportSession(store, principal, input.engagement_id, { work_run_id: input.work_run_id, generation: input.generation, request: input as unknown as Record<string, unknown> });
                if (sessionError)
                    return sessionError;
                const run = input.work_run_id ? (await store.getWorkRun(input.work_run_id)) : undefined;
                if (input.work_run_id && (!run || run.engagement_id !== input.engagement_id))
                    return error("conflict", "work run not found");
                if (input.work_run_id && (!Number.isInteger(input.generation) || input.generation !== run!.generation))
                    return error("stale_version", "action recommendation requires the active generation");
                const workRunId = typeof run?.run_id === "string" ? run.run_id : undefined;
                const generation = typeof run?.generation === "number" ? run.generation : undefined;
                const content = {
                    id: uuidv7(), engagement_id: input.engagement_id, kind: "action_intent", status: "recommended",
                    target: input.target, method: input.method, rationale: input.rationale, uncertainty: input.uncertainty, scope: input.scope ?? input.engagement_id,
                    constraints: input.constraints ?? [], limitations: input.limitations ?? [], memory_refs: input.memory_refs ?? [], evidence_refs: input.evidence_refs ?? [],
                    work_run_ref: workRunId, attempt_ref: run?.attempt_ref, generation,
                } as CanonicalRecord;
                if (run) {
                    const action = (await store.recordActionIntent({ action_id: content.id, run_id: workRunId!, generation: generation!, mode: "llm_recommend", target: input.target, method: input.method, rationale: input.rationale, uncertainty: input.uncertainty, scope: input.scope ?? input.engagement_id, constraints: input.constraints ?? [], limitations: input.limitations ?? [], memory_refs: input.memory_refs ?? [], evidence_refs: input.evidence_refs ?? [], status: "recommended", host_id: principal.id, actor_role: principal.role === "model" ? "model" : "host" }));
                    return { ok: true as const, data: { recommendation_id: action.action_id, target: input.target, method: input.method, rationale: input.rationale, uncertainty: input.uncertainty, scope: input.scope ?? input.engagement_id, constraints: input.constraints ?? [], limitations: input.limitations ?? [], memory_refs: input.memory_refs ?? [], evidence_refs: input.evidence_refs ?? [] } };
                }
                const { id: _id, ...candidate } = content;
                const proposal = (await store.submitProposal({ engagement_id: input.engagement_id, subject_type: "action_recommendation", expected_version: 0, content: { schema_version: SCHEMA_VERSION, ...candidate } as ProposalCandidate }, {
                    operation: "action.recommend", principal: principal.id, engagement_id: input.engagement_id,
                    workRunId, generation, principalRole: principal.role,
                }));
                return { ok: true as const, data: { recommendation_id: proposal.id, target: input.target, method: input.method, rationale: input.rationale, uncertainty: input.uncertainty, scope: input.scope ?? input.engagement_id, constraints: input.constraints ?? [], limitations: input.limitations ?? [], memory_refs: input.memory_refs ?? [], evidence_refs: input.evidence_refs ?? [] } };
            }));
        },
        async actionHostDecision(principal: Principal, input: {
            engagement_id: string;
            work_run_id: string;
            action_id: string;
            generation: number;
            mode: "llm_recommend" | "authorized_autonomous" | "host_hitl";
            host_decision_ref?: string;
            status: "authorized" | "denied";
        }) {
            const response = authorize(principal, "action.host-decision", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const sessionError = await checkHostTransportSession(store, principal, input.engagement_id, { work_run_id: input.work_run_id, generation: input.generation, request: input as unknown as Record<string, unknown> });
                if (sessionError)
                    return sessionError;
                return { ok: true as const, data: (await store.recordActionIntent({ ...input, host_id: principal.id, action_id: input.action_id, run_id: input.work_run_id, status: input.status })) };
            }));
        },
        async actionHostResult(principal: Principal, input: {
            engagement_id: string;
            work_run_id: string;
            action_id: string;
            generation: number;
            mode: "llm_recommend" | "authorized_autonomous" | "host_hitl";
            status: "executed" | "failed" | "unknown";
            result_ref?: string;
            host_decision_ref?: string;
        }) {
            const response = authorize(principal, "action.host-result", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const sessionError = await checkHostTransportSession(store, principal, input.engagement_id, { work_run_id: input.work_run_id, generation: input.generation, request: input as unknown as Record<string, unknown> });
                if (sessionError)
                    return sessionError;
                return { ok: true as const, data: (await store.recordActionIntent({ ...input, host_id: principal.id, action_id: input.action_id, run_id: input.work_run_id, status: input.status })) };
            }));
        },
        async actionReconcile(principal: Principal, input: {
            engagement_id: string;
            work_run_id: string;
            action_id: string;
            generation: number;
            result_ref: string;
            status: "executed" | "failed";
        }) {
            const response = authorize(principal, "action.reconcile", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => {
                const sessionError = await checkHostTransportSession(store, principal, input.engagement_id, { work_run_id: input.work_run_id, generation: input.generation, request: input as unknown as Record<string, unknown> });
                if (sessionError)
                    return sessionError;
                return { ok: true as const, data: (await store.reconcileAction(input.work_run_id, input.generation, input.result_ref, input.status, input.action_id, principal.id)) };
            }));
        },
        async observeControl(principal: Principal, input: ControlObservationInput) {
            const response = authorize(principal, "control.observe", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await createControlObservation(store, input)) as unknown as Record<string, unknown> })));
        },
        async observeAccess(principal: Principal, input: AccessDecisionObservationInput) {
            const response = authorize(principal, "access.observe", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await createAccessDecisionObservation(store, input)) as unknown as Record<string, unknown> })));
        },
        async controlList(principal: Principal, input: {
            engagement_id: string;
        }) {
            const response = authorize(principal, "control.list", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.snapshot(input.engagement_id, { includeCandidates: true })).records.filter((record) => ["protective_control", "control_observation", "access_decision_observation"].includes(String(record.kind))) as Array<Record<string, unknown>> })));
        },
        async hostState(principal: Principal, input: { engagement_id: string; limit?: number }) {
            const response = authorize(principal, "host.state", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.hostStateView(input.engagement_id, input.limit)) })));
        },
        async resume(principal: Principal, input: {
            engagement_id: string;
            work_run_id: string;
            host_id: string;
        }) {
            const response = authorize(principal, "work.resume", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.resumePacket(input.work_run_id, principal.id)) })));
        },
        async auditVerify(principal: Principal) {
            const response = authorize(principal, "audit.verify");
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.verifyAudit()) })));
        },
        async auditDoctor(principal: Principal) {
            const response = authorize(principal, "audit.doctor");
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.maintenanceRead(async () => ({ ...(await store.doctor()), artifacts: (await artifactStore.reconcile({ read_only: true })) }))) as unknown as Record<string, unknown> })));
        },
        async snapshotExport(principal: Principal, input: {
            engagement_id: string;
            as_of?: number;
        }) {
            const response = authorize(principal, "snapshot.export", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.exportSnapshot(input.engagement_id, input.as_of)) as unknown as Record<string, unknown> })));
        },
        async snapshotImport(principal: Principal, input: {
            engagement_id: string;
            snapshot: unknown;
        }) {
            return error("unsupported_capability", "public snapshot import is unsupported; use isolated backend backup/restore", "evolve-engagement-memory");
        },
        async adapterStatus(principal: Principal) {
            const response = authorize(principal, "adapter.status");
            if (!response.ok)
                return response;
            const configured = readAdapterConfig().adapters;
            const adapters = (["pi", "deepseek-harness", "hermes"] as const).map((host) => {
                const manifest = TARIC_COMPATIBILITY_MANIFEST.hosts[host];
                const capabilityId = host === "pi" ? "pi_native_adapter" : host === "deepseek-harness" ? "deepseek_native_adapter" : "hermes_native_adapter";
                const manifestCapability = TARIC_COMPATIBILITY_MANIFEST.capabilities.find((capability) => capability.id === capabilityId);
                const entry = configured && typeof configured === "object" && !Array.isArray(configured)
                    ? (configured as Record<string, unknown>)[host]
                    : undefined;
                const config = entry && typeof entry === "object" && !Array.isArray(entry)
                    ? entry as Record<string, unknown>
                    : undefined;
                const expectedVersion = "version" in manifest ? manifest.version : "1.1.0";
                const expectedCommit = "commit" in manifest ? manifest.commit : "7c10bd4";
                const version = typeof config?.version === "string" ? config.version : undefined;
                const commit = typeof config?.commit === "string" ? config.commit : undefined;
                return {
                    host_id: host,
                    support_state: manifestCapability?.state ?? manifest.state,
                    manifest_capability: manifestCapability,
                    configured: config?.enabled === true,
                    configured_version: version,
                    configured_commit: commit,
                    configuration_matches_manifest: config?.enabled === true && version === expectedVersion && commit === expectedCommit,
                    instance_registration_state: "not_observed",
                    runtime_health_state: "not_observed",
                };
            });
            return { ok: true as const, data: { adapters } };
        },
        async resourceRevise(principal: Principal, input: Record<string, unknown>) {
            const response = authorize(principal, "resource.revise", typeof input.engagement_id === "string" ? input.engagement_id : undefined);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.createResourceRevision({ ...input, principal: principal.id } as never)) as unknown as Record<string, unknown> })));
        },
        async resourcePatch(principal: Principal, input: Record<string, unknown>) {
            const response = authorize(principal, "resource.patch", typeof input.engagement_id === "string" ? input.engagement_id : undefined);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.applyPatchSet({ ...input, principal: principal.id } as never)) as unknown as Record<string, unknown> })));
        },
        async resourceRelation(principal: Principal, input: Record<string, unknown>) {
            const response = authorize(principal, "resource.relation", typeof input.engagement_id === "string" ? input.engagement_id : undefined);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.addRelation({ ...input, provenance: { host_id: principal.id, producer_id: principal.id, source_kind: "host" } } as never)) as unknown as Record<string, unknown> })));
        },
        async resourceImpact(principal: Principal, input: {
            engagement_id: string;
            source_id: string;
            limit?: number;
            continuation?: string;
        }) {
            const response = authorize(principal, "resource.impact", input.engagement_id);
            if (!response.ok)
                return response;
            return (await safe(async () => ({ ok: true as const, data: (await store.impact(input.source_id, input)) as unknown as Record<string, unknown> })));
        },
        async capabilityStatus(principal?: Principal) {
            if (principal) {
                const access = authorize(principal, "capability.status");
                if (!access.ok)
                    return access;
            }
            // 诊断必须与 compat manifest 同源，避免 CLI/MCP/Pi 各自维护支持名单。
        const postgresEnabled = (store as AuthorityStore & { manifest?: () => { runtime_state: string } }).manifest?.().runtime_state === "enabled";
        const compatibilityManifest = postgresEnabled ? {
            ...TARIC_COMPATIBILITY_MANIFEST,
            capabilities: TARIC_COMPATIBILITY_MANIFEST.capabilities.map((item) => item.id === "storage.postgresql" ? { ...item, runtime_state: "enabled" as const } : item),
        } : TARIC_COMPATIBILITY_MANIFEST;
        const unsupported = Object.fromEntries(compatibilityManifest.capabilities.filter((item) => item.state === "unsupported").map((item) => [item.id, item.follow_up ?? "complete-taric-runtime-gaps"]));
            return { ok: true as const, data: {
                    schema_version: API_CONTRACT_VERSION,
                compatibility_manifest: compatibilityManifest,
                    // 支持名单必须来自统一操作注册表，避免 Core、CLI、MCP 与 Pi 各维护一份。
                    supported_operations: operationContracts.map((contract) => contract.operation),
                    unsupported_capabilities: { ...unsupported, ...deferred },
                } };
        },
        async adapterInstall(principal: Principal, input: Record<string, unknown>) {
            const access = authorize(principal, "adapter.install");
            if (!access.ok)
                return access;
            const host = input.host;
            if (host !== "pi" && host !== "deepseek-harness" && host !== "hermes")
                return error("validation_error", "host must be pi, deepseek-harness, or hermes");
            const manifestHost = host === "deepseek-harness" ? "deepseek-harness" : host;
            const evidence = TARIC_COMPATIBILITY_MANIFEST.hosts[manifestHost];
            if (evidence.state !== "supported")
                return error("unsupported_capability", `${host} has no verified native hooks`, "MCP/CLI fallback remains available");
            const config = readAdapterConfig();
            const adapters = (config.adapters && typeof config.adapters === "object" ? config.adapters : {}) as Record<string, unknown>;
            adapters[host] = { enabled: true, version: "version" in evidence ? evidence.version : "1.1.0", commit: "commit" in evidence ? evidence.commit : "7c10bd4" };
            config.adapters = adapters;
            saveAdapterConfig(config);
            return { ok: true as const, data: { host, installed: true, config_path: adapterConfigPath() } };
        },
        async adapterRemove(principal: Principal, input: Record<string, unknown>) {
            const access = authorize(principal, "adapter.remove");
            if (!access.ok)
                return access;
            const host = input.host;
            if (host !== "pi" && host !== "deepseek-harness" && host !== "hermes")
                return error("validation_error", "host must be pi, deepseek-harness, or hermes");
            const config = readAdapterConfig();
            const adapters = (config.adapters && typeof config.adapters === "object" ? config.adapters : {}) as Record<string, unknown>;
            delete adapters[host];
            config.adapters = adapters;
            saveAdapterConfig(config);
            return { ok: true as const, data: { host, installed: false, config_path: adapterConfigPath() } };
        },
        async adapterConfig(principal: Principal, input: Record<string, unknown>) {
            const access = authorize(principal, "adapter.config");
            if (!access.ok)
                return access;
            const host = input.host;
            if (host !== "pi" && host !== "deepseek-harness" && host !== "hermes")
                return error("validation_error", "host must be pi, deepseek-harness, or hermes");
            const patch = input.config;
            if (!patch || typeof patch !== "object" || Array.isArray(patch))
                return error("validation_error", "config must be an object");
            const config = readAdapterConfig();
            const adapters = (config.adapters && typeof config.adapters === "object" ? config.adapters : {}) as Record<string, unknown>;
            const current = (adapters[host] && typeof adapters[host] === "object" ? adapters[host] : {}) as Record<string, unknown>;
            adapters[host] = { ...current, ...(patch as Record<string, unknown>) };
            config.adapters = adapters;
            saveAdapterConfig(config);
            return { ok: true as const, data: { host, config: adapters[host], config_path: adapterConfigPath() } };
        }
    };
    return {
        ...api,
        close: () => store.close(),
        async dispatch(operation, principal, request) {
            if (Object.prototype.hasOwnProperty.call(deferred, operation))
                return error("unsupported_capability", `operation is deferred to ${deferred[operation as keyof typeof deferred]}`, deferred[operation as keyof typeof deferred]);
            if (!operationContract(operation))
                return error("unsupported_capability", "operation is not supported", "complete-taric-runtime-gaps");
            if (!request || typeof request !== "object" || Array.isArray(request))
                return error("validation_error", "request must be an object");
            if (request.contract_version !== undefined && request.contract_version !== API_CONTRACT_VERSION)
                return error("unsupported_schema_version", "unsupported API contract version");
            const requestedEngagement = typeof request.engagement_id === "string" ? request.engagement_id : undefined;
            const access = authorize(principal, operation, requestedEngagement);
            if (!access.ok)
                return access;
            if (operation.startsWith("artifact.")) {
                const requestContract = operationContract(operation)!.request as ContractName;
                let validate = operationRequestValidators.get(requestContract);
                if (!validate) {
                    validate = schemaValidator.compile({ $id: `${coreSchema.$id}/requests/${requestContract}.json`, $defs: coreSchema.$defs, $ref: `#/$defs/${requestContract}` });
                    operationRequestValidators.set(requestContract, validate);
                }
                if (!validate || !validate(request))
                    return error("validation_error", `invalid ${operation} request`);
            }
            const aliases: Record<string, string> = { "engagement.init": "init", "engagement.status": "status", "adapter.status": "adapterStatus", "adapter.install": "adapterInstall", "adapter.remove": "adapterRemove", "adapter.config": "adapterConfig", "capability.status": "capabilityStatus", "audit.verify": "auditVerify", "audit.doctor": "auditDoctor", "audit.reconcile": "auditReconcile", "error.report": "errorReport", "snapshot.export": "snapshotExport", "resource.revise": "resourceRevise", "resource.patch": "resourcePatch", "resource.relation": "resourceRelation", "resource.impact": "resourceImpact", "context.build": "buildContext", "context.query": "buildContext", "proposal.submit": "submitProposal", "capture": "captureObservation", "capture.observation": "captureObservation", "proposal.list": "listProposals", "review.submit": "submitReview", "admission.evaluate": "admitProposal", "admission.commit": "admitProposal", "admission": "admitProposal", "work.claim": "workClaim", "work.renew": "workRenew", "work.reclaim": "workReclaim", "checkpoint.propose": "checkpointPropose", "checkpoint.commit": "checkpointCommit", "action.recommend": "actionRecommend", "action.host-decision": "actionHostDecision", "action.host-result": "actionHostResult", "action.reconcile": "actionReconcile", "control.list": "controlList", "control.observe": "observeControl", "access.observe": "observeAccess", "work.resume": "resume", "resource.query": "query", "evidence.query": "query", "artifact.session.bind": "artifactSessionBind", "artifact.store.begin": "artifactStoreBegin", "artifact.store.append": "artifactStoreAppend", "artifact.store.commit": "artifactStoreCommit", "artifact.metadata": "artifactMetadata", "artifact.content.read": "artifactContentRead", "artifact.content.list": "artifactContentList", "artifact.session.output": "artifactSessionOutput" };
            aliases["host.state"] = "hostState";
            const methodName = aliases[operation] ?? operation;
            if (operation === "admission.promote_l2")
                return (await api.promoteFinding(principal, request as unknown as PromotionL2));
            if (!Object.prototype.hasOwnProperty.call(api, methodName))
                return error("unsupported_capability", "operation is not supported", "complete-taric-runtime-gaps");
            return (await safe(async () => {
                if (methodName === "status") {
                    return (await api.status()) as ApiResponse<unknown>;
                }
                if (methodName === "init") {
                    if (Object.keys(request).some((field) => !["name", "scope", "contract_version"].includes(field)))
                        return error("validation_error", "engagement identity and fields are assigned by Core");
                    if (request.name !== undefined && typeof request.name !== "string")
                        return error("validation_error", "engagement name must be a string");
                    return (await api.init({ name: typeof request.name === "string" ? request.name : undefined, scope: request.scope as Parameters<CoreService["init"]>[0]["scope"] }));
                }
                if (methodName === "capabilityStatus")
                    return (await api.capabilityStatus(undefined)) as ApiResponse<unknown>;
                const method = api[methodName as keyof typeof api] as (p: Principal, r: Record<string, unknown>) => Promise<ApiResponse<unknown>>;
                return await method(principal, request);
            }));
        }
    };
}
function authorize(principal: Principal, operation: string, engagementId?: string): ApiResponse<{
    principal: Principal;
}> {
    if (!principal?.id || !principal.role || principal.transport_verified !== true || !verifiedPrincipals.has(principal))
        return error("authorization_error", "transport-verified principal is required");
    if (operation in deferred)
        return error("unsupported_capability", "operation is deferred", deferred[operation as keyof typeof deferred]);
    const contract = operationContract(operation);
    if (!contract || !contract.roles.includes(principal.role))
        return error("authorization_error", "principal role is not authorized for this operation");
    const requiredCapability = capabilityForOperation(operation);
    if (requiredCapability && !principal.capabilities?.includes(requiredCapability))
        return error("authorization_error", "principal lacks the required engagement capability");
    if (contract.engagement_scoped) {
        if (!engagementId)
            return error("validation_error", "engagement_id is required");
        if (operation !== "engagement.init" && ((principal.role !== "operator" && !principal.engagement_id) || (principal.engagement_id !== undefined && principal.engagement_id !== engagementId)))
            return error("authorization_error", "principal is not authorized for this engagement");
    }
    else if (engagementId && principal.engagement_id && principal.engagement_id !== engagementId) {
        return error("authorization_error", "principal is not authorized for this engagement");
    }
    return { ok: true as const, data: { principal } };
}
async function checkHostTransportSession(store: AuthorityStore, principal: Principal, engagementId: string, input: {
    work_run_id?: string;
    generation?: number;
    content?: Record<string, unknown>;
    request?: Record<string, unknown>;
}): Promise<ErrorEnvelope | undefined> {
    if (principal.role !== "host")
        return undefined;
    const body = input.request ?? {};
    const content = input.content ?? {};
    if (["session_id", "transport_session_id", "task_session_ref"].some((field) => Object.prototype.hasOwnProperty.call(body, field) || Object.prototype.hasOwnProperty.call(content, field)))
        return error("authorization_error", "session association is assigned by the trusted transport");

    const sessionId = verifiedTransportSessions.get(principal);
    if (!sessionId) {
        const runId = input.work_run_id ?? (typeof content.work_run_ref === "string" ? content.work_run_ref : undefined);
        if (runId) {
            const run = await store.getWorkRun(runId);
            if (run?.engagement_id === engagementId && typeof run.task_session_ref === "string")
                return error("authorization_error", "run-bound host writes require the matching transport session association");
        }
        return undefined;
    }

    const binding = (await store.artifactSessions({ engagement_id: engagementId, session_id: sessionId }))[0];
    if (!binding)
        return error("authorization_error", "trusted transport session has no persisted Engagement binding");
    if (binding.mode === "host-session") {
        const runId = input.work_run_id ?? (typeof content.work_run_ref === "string" ? content.work_run_ref : undefined);
        if (runId) {
            const run = await store.getWorkRun(runId);
            if (run?.engagement_id === engagementId && run.task_session_ref !== sessionId)
                return error("authorization_error", "WorkRun belongs to another trusted transport session");
            const owner = run?.owner as Record<string, unknown> | undefined;
            if (run?.engagement_id === engagementId && owner?.host_id !== principal.id)
                return error("authorization_error", "WorkRun belongs to another host principal");
        }
        return undefined;
    }

    if (binding.owner_host !== principal.id)
        return error("authorization_error", "transport principal does not own the run-bound session");
    if (!input.work_run_id || !Number.isSafeInteger(input.generation))
        return error("validation_error", "run-bound host writes require the WorkRun and generation from the trusted session binding");
    if (input.work_run_id !== binding.work_run_id || input.generation !== binding.generation)
        return error("stale_version", "host write does not match the persisted run-bound session generation");
    if (typeof content.work_run_ref === "string" && content.work_run_ref !== binding.work_run_id)
        return error("stale_version", "proposal WorkRun reference does not match the persisted session binding");
    if (typeof content.attempt_ref === "string" && content.attempt_ref !== binding.attempt_id)
        return error("stale_version", "proposal Attempt reference does not match the persisted session binding");
    if (typeof content.generation === "number" && content.generation !== binding.generation)
        return error("stale_version", "proposal generation does not match the persisted session binding");
    return undefined;
}
function checkArtifactTransportSession(principal: Principal, requestSessionId: string): ErrorEnvelope | undefined {
    if (principal.role !== "host")
        return undefined;
    const sessionId = verifiedTransportSessions.get(principal);
    return sessionId !== undefined && requestSessionId !== sessionId
        ? error("authorization_error", "Artifact session must match the trusted transport session")
        : undefined;
}
async function hostTransportAttribution(store: AuthorityStore, principal: Principal, engagementId: string, workRunId?: string, generation?: number): Promise<{ attempt_id?: string; session_id?: string } | undefined> {
    if (principal.role !== "host" || !workRunId)
        return undefined;
    const sessionId = verifiedTransportSessions.get(principal);
    if (!sessionId)
        return undefined;
    const run = await store.getWorkRun(workRunId);
    if (!run || run.engagement_id !== engagementId || run.task_session_ref !== sessionId || !Number.isSafeInteger(generation) || generation !== run.generation)
        return undefined;
    const binding = (await store.artifactSessions({ engagement_id: engagementId, session_id: sessionId }))[0];
    if (binding?.mode === "run-bound")
        return { attempt_id: binding.attempt_id, session_id: binding.session_id };
    return { attempt_id: typeof run.attempt_ref === "string" ? run.attempt_ref : undefined, session_id: sessionId };
}
function capabilityForOperation(operation: string): PrincipalCapability | undefined {
    if (operation === "admission.promote_l2")
        return "writer";
    if (["context.build", "context.query", "query", "resource.query", "evidence.query", "proposal.list", "control.list", "host.state", "engagement.status"].includes(operation))
        return "read";
    if (["proposal.submit", "capture.observation", "checkpoint.propose", "action.recommend"].includes(operation))
        return "propose";
    if (operation === "review.submit" || operation === "review.get")
        return "review";
    if (["admission.evaluate", "admission.commit"].includes(operation))
        return "admit";
    if (["work.claim", "work.renew", "work.reclaim", "work.resume", "error.report"].includes(operation))
        return "work";
    if (["checkpoint.commit"].includes(operation))
        return "checkpoint";
    if (["action.host-decision", "action.host-result", "action.reconcile"].includes(operation))
        return "action";
    if (["audit.verify", "audit.doctor", "audit.reconcile", "snapshot.export"].includes(operation))
        return "audit";
    if (operation === "artifact.content.read")
        return "content_read";
    if (operation.startsWith("artifact."))
        return "content";
    if (["resource.revise", "resource.patch", "resource.relation", "resource.impact"].includes(operation))
        return "propose";
    if (["engagement.init", "capability.status"].includes(operation))
        return "operator";
    return undefined;
}
function defaultContentRoot(store: AuthorityStore): string {
    if (store.filename === ":postgresql:") throw new ContractValidationError("validation_error", "shared authority requires an explicit content root");
    return store.filename === ":memory:" ? join(tmpdir(), "taric-content", uuidv7()) : join(dirname(store.filename), "content");
}
async function safe<T>(operation: () => ApiResponse<T> | Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
    try {
        return await operation();
    }
    catch (cause) {
        if (cause instanceof ContractValidationError) {
            return error(cause.code, cause.message, typeof cause.details === "string" ? cause.details : undefined);
        }
        if (cause instanceof InvalidCursorError || cause instanceof ContextBudgetError)
            return error(cause.code, cause.message);
        // Unknown exceptions never cross a transport boundary. Error codes are
        // declared by typed errors above; free-form messages are not classified.
        return error("internal_error", "internal error");
    }
}
function error(code: ApiErrorCode, message: string, follow_up?: string): ErrorEnvelope { return { ok: false, error: { code, message, follow_up } }; }
