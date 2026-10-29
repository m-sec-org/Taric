import { SqliteAuthorityDriver, type AuthoritySqlDriver } from "./sql-driver.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { InvalidCursorError, loadAuthorityCursorKey } from "./cursor-key.js";
import { uuidv7 } from "./identity.js";
import { DEFAULT_ADMISSION_POLICY, evaluateAdmission, policyDigest, riskClassOf, type AdmissionDecision, type AdmissionPolicy, type AdmissionReview, type PinnedEvidence, type RiskClass } from "./policy.js";
import { contractNames, SCHEMA_VERSION, type ContractName } from "@taric/schemas";
import { ContractValidationError, authorityReferenceIds, UUID_V7_PATTERN, validateCanonicalRecord, validateContract, validateAuthorityReferences, validateProposalEnvelope, validateProposalCandidate } from "./validation.js";
import type { ProposalEnvelope, ProposalCandidate } from "@taric/schemas";
export type TrustLevel = "L0" | "L1" | "L2";
export interface CanonicalRecord {
    id: string;
    engagement_id: string;
    trust_level?: TrustLevel;
    version?: number;
    [key: string]: unknown;
}
export interface Proposal extends ProposalEnvelope {
    id: string;
    proposal_id: string;
    content: ProposalCandidate;
    canonical_id?: string;
    canonical_version?: number;
    status: "pending" | "rejected" | "admitted" | "needs_evidence";
    content_hash: string;
}
export interface AuditEvent {
    event_id: string;
    commit_seq: number;
    event_type: string;
    subject_id?: string;
    payload: Record<string, unknown>;
    prev_hash: string | null;
    hash: string;
    created_at: string;
    actor_id?: string;
    host_id?: string;
    worker_id?: string;
    dispatch_id?: string;
    work_item_id?: string;
    attempt_id?: string;
    proposal_id?: string;
    review_id?: string;
    entity_id?: string;
    policy_digest?: string;
    input_hash?: string;
    evidence_refs?: string[];
    idempotency_key?: string;
    changed_fields?: string[];
}
export interface AdmissionResult {
    ok: boolean;
    reason?: string;
    record?: CanonicalRecord;
    proposal: Proposal;
    trust_phase?: "proposal" | "machine_approved" | "independently_verified";
    policy_digest?: string;
    policy_version?: string;
    remaining_l2_requirements?: string[];
}
export interface ReadSnapshot {
    read_seq: number;
    committed_seq: number;
    projected_seq: number;
    read_time: string;
    records: CanonicalRecord[];
}
export interface IdempotencyContext {
    operation: string;
    principal: string;
    engagement_id: string;
    expected_version?: number;
}
export interface GovernanceWriteOptions extends Partial<IdempotencyContext> {
    idempotencyKey?: string;
    /** Run-scoped proposals and observations must arrive from the active Attempt. */
    workRunId?: string;
    attemptId?: string;
    sessionId?: string;
    generation?: number;
    principalRole?: string;
}
export interface OperationMarker {
    operation_id: string;
    event_id: string;
    engagement_id?: string;
    commit_seq: number;
    kind: string;
    input_hash: string;
    status: "pending" | "applied" | "indexed" | "failed" | "recovered";
    error?: string;
    retry_owner?: string;
    updated_at: string;
}
export interface DoctorReport {
    valid: boolean;
    schema_version: string;
    committed_seq: number;
    projected_seq: number;
    pending_outbox: number;
    operation_markers: Record<OperationMarker["status"], number>;
    authority: {
        valid: boolean;
        errors: string[];
    };
    derived: {
        valid: boolean;
        errors: string[];
        repair_actions: string[];
    };
    audit: Awaited<ReturnType<AuthorityStore["verifyAudit"]>>;
    errors: string[];
    read_seq?: number;
    watermarks?: {
        committed_seq: number;
        projected_seq: number;
    };
}
export interface OperationRecoveryPreview {
    action: "preview";
    committed_seq: number;
    pending_outbox: number;
    failed_markers: number;
    missing_outbox: number;
    missing_markers: number;
    authority_valid: boolean;
    authority_writable: boolean;
    repair_actions: string[];
    read_seq?: number;
    projected_seq?: number;
    watermarks?: {
        committed_seq: number;
        projected_seq: number;
    };
}
export interface ResourceRevisionInput {
    engagement_id: string;
    resource_id?: string;
    expected_version?: number;
    asset_type?: string;
    identity?: Record<string, unknown>;
    variant?: Record<string, unknown>;
    method?: string;
    path?: string;
    parameter?: string;
    content_type?: string;
    principal_ref?: string;
    tenant_ref?: string;
    content_hash: string;
    source_observation_refs?: string[];
    valid_from?: string;
    valid_until?: string;
    principal?: string;
}
export interface PatchOperation {
    op?: "upsert" | "replace" | "add_relation" | "remove_relation";
    kind?: string;
    id?: string;
    entity_id?: string;
    patch?: Record<string, unknown>;
    changes?: Record<string, unknown>;
    base?: Record<string, unknown>;
    record?: ProposalCandidate;
    relation?: ProposalCandidate;
    expected_version?: number;
}
export interface PatchSetInput {
    id?: string;
    engagement_id: string;
    base_generation: number;
    base_versions?: Record<string, number>;
    read_set?: Array<string | {
        entity_ref: string;
        version: number;
    }>;
    write_set?: Array<string | {
        entity_ref: string;
        base_version: number;
    }>;
    operations: Array<PatchOperation | "upsert_resource" | "upsert_relation" | "replace_property" | "add_relation" | "remove_relation" | "revise_claim" | "revise_hypothesis" | "attach_observation">;
    source_observation_refs?: string[];
    principal?: string;
    work_run_id?: string;
    attempt_ref?: string;
    generation?: number;
}
export interface PatchSetResult {
    patch_id: string;
    status: "merged" | "conflict";
    generation: number;
    records: CanonicalRecord[];
    conflicts: CanonicalRecord[];
}
export interface ImpactResult {
    event_id: string;
    affected_ids: string[];
    revalidation_work_item_ids: string[];
    continuation?: string;
    pending_watermark: number;
}
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function encodeListCursor(state: Record<string, unknown>, secret: Buffer): string {
    const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    return `v1.${body}.${sig}`;
}
function decodeListCursor(value: string, secret: Buffer): Record<string, unknown> {
    const [version, body, signature, extra] = value.split(".");
    if (version !== "v1" || !body || !signature || extra)
        throw new InvalidCursorError("invalid authority page cursor");
    const expected = createHmac("sha256", secret).update(body).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new InvalidCursorError("invalid authority page cursor");
    try {
        const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
        if (parsed.v !== 1)
            throw new Error();
        return parsed;
    }
    catch {
        throw new InvalidCursorError("invalid authority page cursor");
    }
}
const impactCursorKey = randomBytes(32);
function payloadWithRecords(payload: Record<string, unknown>, records: unknown[]): Record<string, unknown> {
    return { schema_version: payload.schema_version, core_version: payload.core_version, engagement_id: payload.engagement_id, read_seq: payload.read_seq, committed_seq: payload.committed_seq, projected_seq: payload.projected_seq, format: payload.format, records };
}
const json = (value: unknown) => JSON.stringify(value);
function exactPayload(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(exactPayload);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, exactPayload(item)]));
    return value;
}
const samePayload = (left: unknown, right: unknown): boolean => json(exactPayload(left)) === json(exactPayload(right));
function proposalEnvelope(proposal: Proposal): ProposalEnvelope {
    return { engagement_id: proposal.engagement_id, subject_type: proposal.subject_type, expected_version: proposal.expected_version, proposal_id: proposal.proposal_id, target_id: proposal.target_id, client_request_id: proposal.client_request_id, content: proposal.content };
}
/** 必须经过共享校验器的 Phase 1 领域合同 kind。 */
const phaseOneContracts = new Set<string>(contractNames.filter((name) => !["apiSuccess", "apiError", "auditEvent"].includes(name)));
const recordContractNames: Record<string, ContractName> = {
    resource_revision: "resourceRevision", test_hypothesis: "testHypothesis", attack_path: "attackPath", patch_set: "patchSet", conflict: "conflict", impact_event: "impactEvent", protective_control_revision: "protectiveControlRevision", control_applicability_event: "controlApplicabilityEvent",
};
/** ActionIntent 的合法状态迁移；denied 不得再进入执行态。 */
const actionTransitions: Record<string, string[]> = {
    recommended: ["authorized", "denied"],
    authorized: ["executed", "failed", "unknown"],
    unknown: ["executed", "failed"],
    executed: [],
    failed: [],
    denied: [],
};
const workTransitions: Record<string, string[]> = {
    queued: ["claimed", "cancelled"],
    claimed: ["running", "checkpointed", "blocked", "completed", "failed", "cancelled", "lost"],
    running: ["checkpointed", "blocked", "completed", "failed", "cancelled", "lost"],
    checkpointed: ["running", "blocked", "completed", "failed", "cancelled", "lost"],
    blocked: ["running", "checkpointed", "completed", "failed", "cancelled", "lost"],
    lost: ["claimed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
};
const attemptTransitions: Record<string, string[]> = {
    claimed: ["running", "checkpointed", "blocked", "completed", "failed", "cancelled", "lost"],
    running: ["checkpointed", "blocked", "completed", "failed", "cancelled", "lost"],
    checkpointed: ["running", "blocked", "completed", "failed", "cancelled", "lost"],
    blocked: ["running", "checkpointed", "completed", "failed", "cancelled", "lost"],
    lost: [],
    completed: [],
    failed: [],
    cancelled: [],
};
const checkpointForbiddenFields = new Set(["reasoning", "hidden_reasoning", "chain_of_thought", "thoughts", "internal_reasoning", "private_reasoning"]);
function sanitizeSnapshotRecord(value: unknown, sensitive: RegExp): unknown {
    if (Array.isArray(value))
        return value.map((item) => sanitizeSnapshotRecord(item, sensitive)).filter((item) => item !== undefined);
    if (!value || typeof value !== "object")
        return value;
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "host_ref") || Object.prototype.hasOwnProperty.call(record, "content_ref")) {
        if (typeof record.content_ref !== "string")
            return undefined;
        const allowed = new Set(["content_ref", "artifact_id", "version", "storage_mode", "content_status", "integrity_status", "payload_kind", "media_type", "byte_length", "chunk_count", "content_hash", "manifest_hash", "captured_at", "stored_at", "provenance_ref", "derived_from", "child_refs"]);
        return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, sanitizeSnapshotRecord(item, sensitive)]));
    }
    if (typeof record.content_ref === "string") {
        const allowed = new Set(["content_ref", "artifact_id", "version", "storage_mode", "content_status", "integrity_status", "payload_kind", "media_type", "byte_length", "chunk_count", "content_hash", "manifest_hash", "captured_at", "stored_at", "provenance_ref", "derived_from", "child_refs"]);
        return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, sanitizeSnapshotRecord(item, sensitive)]));
    }
    return Object.fromEntries(Object.entries(record).filter(([key]) => !sensitive.test(key)).map(([key, item]) => [key, sanitizeSnapshotRecord(item, sensitive)]));
}
function sanitizeExecutionMetadata(value: unknown): unknown {
    const forbidden = /(?:token|secret|credential|password|cookie|authorization|bearer|body|packet|hidden_reasoning|chain_of_thought|private_key)/i;
    if (Array.isArray(value))
        return value.map(sanitizeExecutionMetadata).filter((item) => item !== undefined);
    if (!value || typeof value !== "object")
        return typeof value === "string" ? value.slice(0, 512) : value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !forbidden.test(key))
        .map(([key, item]) => [key, sanitizeExecutionMetadata(item)]));
}
/** 规范化 JSON 对象键序，保证等价 payload 产生同一 request hash。 */
function stablePayload(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(stablePayload);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([key]) => !["version", "created_at", "trust_level", "display_id"].includes(key))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stablePayload(item)]));
    }
    return value;
}
/** SQLite WAL authority store. Node 22+ supplies the synchronous sqlite binding. */
export class AuthorityStore {
    protected readonly sql: AuthoritySqlDriver;
    readonly #filename: string;
    #writeBlocked = false;
    #verifiedDataVersion: number | string = -1;
    readonly #unitOfWork = new AsyncLocalStorage<{ active: boolean }>();
    readonly #memoryListKey = randomBytes(32);
    constructor(filename: string | AuthoritySqlDriver = ":memory:") {
        this.sql = typeof filename === "string" ? new SqliteAuthorityDriver(filename) : filename;
        this.#filename = this.sql.filename;
    }
    async close(): Promise<void> { await this.sql.close(); }
    /** The authority path is exposed only for Core-owned key/run-root binding. */
    get filename(): string { return this.#filename; }
    get authorityId(): string { return this.sql.authorityId; }
    get ready(): Promise<void> { return this.sql.ready; }
    /** Maintenance callers share one read transaction and its exact watermarks. */
    async maintenanceRead<T>(reader: (watermarks: {
        read_seq: number;
        committed_seq: number;
        projected_seq: number;
    }) => T): Promise<Awaited<T>> {
        return (await this.readTransaction(async () => {
            const committed = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as {
                seq: number;
            }).seq);
            return reader({ read_seq: committed, committed_seq: committed, projected_seq: (await this.projectedSequence()) });
        }));
    }
    async hostStateView(engagementId: string, limit = 100): Promise<Awaited<Record<string, unknown>>> {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ContractValidationError("validation_error", "host state limit must be between 1 and 1000");
        return (await this.readTransaction(async () => {
            const readTime = await this.sql.now();
            const expiresAt = this.sql.jsonValue("body", "expires_at");
            const reviewAfter = this.sql.jsonValue("body", "review_after");
            const recordSample = await this.sql.all<{ id: string; trust_level: string; kind: string; expires_at?: string; review_after?: string }>(`SELECT id,trust_level,kind,${expiresAt} AS expires_at,${reviewAfter} AS review_after FROM records WHERE engagement_id=? ORDER BY id LIMIT ?`, engagementId, limit + 1);
            const sampledRecords = recordSample.slice(0, limit);
            const l1 = await this.sql.all<{ id: string }>("SELECT id FROM records WHERE engagement_id=? AND trust_level='L1' AND kind NOT IN ('conflict','impact_event') ORDER BY kind,id LIMIT ?", engagementId, limit + 1);
            const freshnessDue = sampledRecords.filter((record) => [record.expires_at, record.review_after].some((deadline) => typeof deadline === "string" && Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) <= Date.parse(readTime)));
            const conflicts = await this.sql.all<{ id: string }>("SELECT id FROM records WHERE engagement_id=? AND kind='conflict' ORDER BY id LIMIT ?", engagementId, limit + 1);
            const impacts = await this.sql.all<{ id: string }>("SELECT id FROM records WHERE engagement_id=? AND kind='impact_event' ORDER BY id LIMIT ?", engagementId, limit + 1);
            const unknown = await this.sql.all<{ action_id: string }>("SELECT a.action_id FROM work_runs w JOIN action_intents a ON a.run_id=w.run_id WHERE w.engagement_id=? AND a.status='unknown' ORDER BY w.run_id,a.action_id LIMIT ?", engagementId, limit + 1);
            const expired = await this.sql.all<{ run_id: string }>("SELECT run_id FROM work_runs WHERE engagement_id=? AND lease_expires_at<=? AND status IN ('claimed','running','checkpointed','blocked') ORDER BY status,lease_expires_at,run_id LIMIT ?", engagementId, readTime, limit + 1);
            const scopedSequence = await this.sql.get<{ latest_seq: number }>("SELECT COALESCE(MAX(commit_seq),0) AS latest_seq FROM record_versions WHERE engagement_id=?", engagementId);
            const count = (rows: readonly unknown[]) => Math.min(rows.length, limit);
            const complete = (rows: readonly unknown[]) => rows.length <= limit;
            const aggregate = { l1_pending: count(l1), conflicts: count(conflicts), impacts: count(impacts), unknown_actions: count(unknown), expired_leases: count(expired), freshness_due: count(freshnessDue) };
            const completeness = { l1_pending: complete(l1), conflicts: complete(conflicts), impacts: complete(impacts), unknown_actions: complete(unknown), expired_leases: complete(expired), freshness_due: recordSample.length <= limit };
            const scopeWatermark = hash(json({ engagement_id: engagementId, latest_record_sequence: Number(scopedSequence?.latest_seq ?? 0), aggregates: aggregate, completeness }));
            return { engagement_id: engagementId, read_time: readTime, freshness: { evaluated_at: readTime, due_records_at_read: aggregate.freshness_due, due_record_count_complete: completeness.freshness_due, lease_expired_at_read: aggregate.expired_leases > 0, expired_lease_count_complete: completeness.expired_leases }, watermark: { scope: scopeWatermark }, bounded: true, limit, aggregates: aggregate, aggregate_completeness: completeness };
        }));
    }
    private listCursorKey(create: boolean, contentRoot?: string): Buffer {
        return this.#filename === ":memory:" && !contentRoot ? this.#memoryListKey : loadAuthorityCursorKey(contentRoot ?? join(dirname(this.#filename), "content"), this.authorityId, create);
    }
    private async referenceIndex(record: Record<string, unknown>, engagementId: string): Promise<Awaited<{
        engagement: Map<string, string>;
        kind: Map<string, string>;
        status: Map<string, string>;
    }>> {
        return (await this.referenceIdsIndex(authorityReferenceIds(record)));
    }
    private async referenceIdsIndex(ids: readonly string[]): Promise<Awaited<{
        engagement: Map<string, string>;
        kind: Map<string, string>;
        status: Map<string, string>;
    }>> {
        const engagement = new Map<string, string>();
        const kind = new Map<string, string>();
        const status = new Map<string, string>();
        if (ids.length === 0)
            return { engagement, kind, status };
        for (let offset = 0; offset < ids.length; offset += 500) {
            const batch = ids.slice(offset, offset + 500);
            const placeholders = batch.map(() => "?").join(",");
            const refs = (await this.sql.all(`SELECT refs.id,refs.engagement_id,refs.kind,${this.sql.jsonValue("records.body", "status")} AS status FROM object_refs refs LEFT JOIN records ON records.id=refs.id WHERE refs.id IN (${placeholders})`, ...batch)) as Array<{
                id: string;
                engagement_id: string;
                kind: string;
                status: string | null;
            }>;
            for (const row of refs) {
                engagement.set(row.id, row.engagement_id);
                kind.set(row.id, row.kind);
                status.set(row.id, row.status ?? "active");
            }
        }
        return { engagement, kind, status };
    }
    private artifactScope(scope?: { engagement_id?: string; session_id?: string }): { where: string; values: string[] } {
        const predicates: string[] = []; const values: string[] = [];
        if (scope?.engagement_id !== undefined) { predicates.push("engagement_id=?"); values.push(scope.engagement_id); }
        if (scope?.session_id !== undefined) { predicates.push("session_id=?"); values.push(scope.session_id); }
        return { where: predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "", values };
    }
    async artifactSessions(scope?: { engagement_id?: string; session_id?: string }): Promise<Awaited<Array<{
        engagement_id: string;
        session_id: string;
        root: string;
        binding_id: string;
        created_at: string;
        mode: "host-session" | "run-bound";
        work_run_id?: string;
        attempt_id?: string;
        generation?: number;
        owner_host?: string;
    }>>> { const filter = this.artifactScope(scope); return (await this.sql.all(`SELECT engagement_id,session_id,root,binding_id,created_at,mode,work_run_id,attempt_id,generation,owner_host FROM artifact_sessions${filter.where}`, ...filter.values)) as Array<{
        engagement_id: string;
        session_id: string;
        root: string;
        binding_id: string;
        created_at: string;
        mode: "host-session" | "run-bound";
        work_run_id?: string;
        attempt_id?: string;
        generation?: number;
        owner_host?: string;
    }>; }
    async recordsPage(input: {
        engagement_id: string;
        principal_id?: string;
        cursor_key_root?: string;
        cursor?: string;
        page_size?: number;
        as_of?: number;
        trust_level?: TrustLevel;
        include_candidates?: boolean;
        kind?: string;
    }): Promise<Awaited<{
        records: CanonicalRecord[];
        next_cursor?: string;
        read_seq: number;
        committed_seq: number;
        projected_seq: number;
    }>> {
        const limit = input.page_size ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new ContractValidationError("validation_error", "page_size must be an integer between 1 and 1000");
        return (await this.readTransaction(async () => {
            const current = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as {
                seq: number;
            }).seq);
            const cursor = input.cursor ? decodeListCursor(input.cursor, this.listCursorKey(false, input.cursor_key_root)) : undefined;
            const readSeq = input.as_of ?? (cursor?.read_seq as number | undefined) ?? current;
            if (!Number.isSafeInteger(readSeq) || readSeq < 0 || readSeq > current)
                throw new ContractValidationError("conflict", `unsupported authority sequence: ${readSeq}`);
            if (cursor && (cursor.list !== "records" || cursor.principal_id !== (input.principal_id ?? "local") || cursor.engagement_id !== input.engagement_id || cursor.read_seq !== readSeq || cursor.trust_level !== (input.trust_level ?? null) || cursor.include_candidates !== Boolean(input.include_candidates) || cursor.kind !== (input.kind ?? null) || cursor.page_size !== limit))
                throw new InvalidCursorError("authority page cursor binding mismatch");
            const after = typeof cursor?.after_id === "string" ? cursor.after_id : "";
            const asOfTime = cursor ? String(cursor.read_time) : input.as_of === undefined ? (await this.sql.now()) : String(((await this.sql.get("SELECT created_at FROM events WHERE commit_seq<=? ORDER BY commit_seq DESC LIMIT 1", readSeq)) as {
                created_at?: string;
            } | undefined)?.created_at ?? "1970-01-01T00:00:00.000Z");
            const trustFilter = input.trust_level ? "rv.trust_level=? AND rv.trust_level<>'L0'" : input.include_candidates ? "rv.trust_level IN ('L1','L2')" : "rv.trust_level='L2'";
            const values: Array<string | number> = [input.engagement_id, readSeq, after, readSeq];
            if (input.trust_level)
                values.push(input.trust_level);
            const kindPredicate = input.kind ? `AND ${this.sql.jsonValue("rv.body", "kind") }=?` : "";
            if (input.kind)
                values.push(input.kind);
            const status = this.sql.jsonValue("rv.body", "status");
            const excluded = this.sql.jsonValue("rv.body", "recall_excluded", "boolean");
            const expires = this.sql.jsonValue("rv.body", "expires_at");
            const review = this.sql.jsonValue("rv.body", "review_after");
            const recalledPredicate = `AND (${status} IS NULL OR ${status} NOT IN ('stale','retracted','superseded','archived','expired','inconclusive','contradicted')) AND COALESCE(${excluded},0)<>1 AND (${expires} IS NULL OR ${this.sql.dateValue(expires)} > ${this.sql.dateValue("?")}) AND (${review} IS NULL OR ${this.sql.dateValue(review)} > ${this.sql.dateValue("?")})`;
            values.push(asOfTime, asOfTime);
            const rows = (await this.sql.all(`SELECT rv.body FROM record_versions rv WHERE rv.engagement_id=? AND rv.commit_seq<=? AND rv.id>? AND NOT EXISTS (SELECT 1 FROM record_versions newer WHERE newer.id=rv.id AND newer.commit_seq<=? AND newer.commit_seq>rv.commit_seq) AND ${trustFilter} ${kindPredicate} ${recalledPredicate} ORDER BY rv.id LIMIT ?`, ...values, limit + 1)) as Array<{
                body: string;
            }>;
            const hasMore = rows.length > limit;
            const selected = rows.slice(0, limit).map((row) => JSON.parse(row.body) as CanonicalRecord);
            const last = selected.at(-1);
            const projected = (await this.projectedSequence());
            return { records: selected, next_cursor: hasMore && last ? encodeListCursor({ v: 1, list: "records", principal_id: input.principal_id ?? "local", engagement_id: input.engagement_id, page_size: limit, read_seq: readSeq, read_time: asOfTime, trust_level: input.trust_level ?? null, include_candidates: Boolean(input.include_candidates), kind: input.kind ?? null, after_id: last.id }, this.listCursorKey(true, input.cursor_key_root)) : undefined, read_seq: readSeq, committed_seq: current, projected_seq: Math.min(projected, readSeq) };
        }));
    }
    /**
     * Bounded Context candidate read. The query intentionally returns only a
     * keyset page of the fixed record-version view; callers must carry the
     * returned after-id into the next request instead of hydrating a snapshot.
     */
    async contextRecordsPage(input: {
        engagement_id: string;
        after_id?: string;
        after_priority?: number;
        after_time?: string;
        page_size?: number;
        as_of?: number;
        read_time?: string;
        include_candidates?: boolean;
        reviewer_mode?: boolean;
        work_item_id?: string;
        delta_ids?: string[];
        filters?: Record<string, unknown>;
        kind?: string;
    }): Promise<Awaited<{
        records: CanonicalRecord[];
        next_after_id?: string;
        next_after_priority?: number;
        next_after_time?: string;
        read_seq: number;
        committed_seq: number;
        read_time: string;
        has_more: boolean;
        scanned_rows: number;
        returned_rows: number;
    }>> {
        const limit = input.page_size ?? 256;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new ContractValidationError("validation_error", "context page_size must be an integer between 1 and 1000");
        return (await this.readTransaction(async () => {
            const current = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as { seq: number }).seq);
            const readSeq = input.as_of ?? current;
            if (!Number.isSafeInteger(readSeq) || readSeq < 0 || readSeq > current)
                throw new ContractValidationError("conflict", `unsupported authority sequence: ${readSeq}`);
            const readTime = input.read_time ?? (input.as_of === undefined
                ? await this.sql.now()
                : String(((await this.sql.get("SELECT created_at FROM events WHERE commit_seq<=? ORDER BY commit_seq DESC LIMIT 1", readSeq)) as { created_at?: string } | undefined)?.created_at ?? "1970-01-01T00:00:00.000Z"));
            if (!Number.isFinite(Date.parse(readTime))) throw new ContractValidationError("validation_error", "context read time is invalid");
            const status = this.sql.jsonValue("rv.body", "status");
            const kind = this.sql.jsonValue("rv.body", "kind");
            const staleReason = this.sql.jsonValue("rv.body", "stale_reason");
            const coverageStatus = this.sql.jsonValue("rv.body", "coverage_status");
            const coverageGap = this.sql.jsonValue("rv.body", "coverage_gap", "boolean");
            const excluded = this.sql.jsonValue("rv.body", "recall_excluded", "boolean");
            const expires = this.sql.jsonValue("rv.body", "expires_at");
            const review = this.sql.jsonValue("rv.body", "review_after");
            const checkpointTime = `COALESCE(${this.sql.jsonValue("rv.body", "updated_at")},${this.sql.jsonValue("rv.body", "created_at")},'')`;
            const sortTime = `CASE WHEN ${kind}='checkpoint' THEN ${checkpointTime} ELSE '' END`;
            const deltaIds = input.delta_ids ?? [];
            if (deltaIds.length > 500) throw new ContractValidationError("validation_error", "context delta priority exceeds 500 subjects");
            const deltaClause = deltaIds.length ? ` OR rv.id IN (${deltaIds.map(() => "?").join(",")})` : "";
            const workItemId = input.work_item_id ?? null;
            const sortPriority = `CASE
                WHEN ${kind} IN ('engagement','scope','rule_of_engagement') THEN 0
                WHEN (? IS NOT NULL AND rv.id=?) THEN 1
                WHEN ${kind}='checkpoint' THEN 2
                WHEN ${status}='stale' OR ${staleReason} IS NOT NULL OR ${coverageStatus}='gap' OR ${coverageGap}=1 OR ${kind} IN ('conflict','impact_event','coverage_gap','delta') OR (${kind}='coverage' AND ${status} IN ('not_tested','queued','in_progress','tested_no_observation','inconclusive','blocked','blocked_by_control'))${deltaClause} THEN 3
                WHEN ${kind} IN ('work_item','workitem','observation','evidence','coverage','control_observation','access_decision_observation','finding','claim','resource') THEN 4
                ELSE 5 END`;
            const staleExcluded = `${status} IN ('retracted','superseded','archived','expired','inconclusive','contradicted')`;
            const predicates = [
                "rv.engagement_id=?", "rv.commit_seq<=?", "NOT EXISTS (SELECT 1 FROM record_versions newer WHERE newer.id=rv.id AND newer.commit_seq<=? AND newer.commit_seq>rv.commit_seq)",
                input.include_candidates ? "rv.trust_level IN ('L1','L2')" : "rv.trust_level='L2'",
                `(${status}='stale' OR ((${status} IS NULL OR NOT ${staleExcluded}) AND COALESCE(${excluded},0)<>1 AND (${expires} IS NULL OR ${this.sql.dateValue(expires)}>${this.sql.dateValue("?")}) AND (${review} IS NULL OR ${this.sql.dateValue(review)}>${this.sql.dateValue("?")})))`
            ];
            if (input.reviewer_mode) predicates.push(`${kind}<>'review'`);
            if (input.kind) predicates.push(`${kind}=?`);
            const filters = input.filters ?? {};
            const filterValues: unknown[] = [];
            for (const [field, value] of Object.entries(filters)) {
                if (!/^[a-z_][a-z0-9_]*$/i.test(field) || field === "__proto__") throw new ContractValidationError("validation_error", `unsupported context filter: ${field}`);
                if (value !== null && typeof value === "object") throw new ContractValidationError("validation_error", `context filter ${field} must be scalar`);
                if (value === null) predicates.push(`${this.sql.jsonValue("rv.body", field)} IS NULL`);
                else if (typeof value === "boolean") { predicates.push(`${this.sql.jsonValue("rv.body", field, "boolean")}=?`); filterValues.push(value ? 1 : 0); }
                else if (typeof value === "number") { predicates.push(`${this.sql.jsonValue("rv.body", field, "number")}=?`); filterValues.push(value); }
                else { predicates.push(`${this.sql.jsonValue("rv.body", field)}=?`); filterValues.push(value); }
            }
            const afterPriority = input.after_priority ?? -1;
            const afterTime = input.after_time ?? "";
            const afterId = input.after_id ?? "";
            const seek = "sort_priority>? OR (sort_priority=? AND ((sort_priority=2 AND (sort_time<? OR (sort_time=? AND id>?))) OR (sort_priority<>2 AND id>?)))";
            const rows = (await this.sql.all<{ id: string; body: string; sort_priority: number; sort_time: string }>(`WITH candidates AS (
                SELECT rv.id,rv.body,${sortPriority} AS sort_priority,${sortTime} AS sort_time
                FROM record_versions rv WHERE ${predicates.join(" AND ")}
            ) SELECT id,body,sort_priority,sort_time FROM candidates WHERE ${seek}
            ORDER BY sort_priority,CASE WHEN sort_priority=2 THEN sort_time END DESC,id LIMIT ?`,
            workItemId, workItemId, ...deltaIds,
            input.engagement_id, readSeq, readSeq, readTime, readTime,
            ...(input.kind ? [input.kind] : []), ...filterValues,
            afterPriority, afterPriority, afterTime, afterTime, afterId, afterId, limit + 1));
            const hasMore = rows.length > limit;
            const selected = rows.slice(0, limit).map((row) => JSON.parse(row.body) as CanonicalRecord);
            const lastRow = rows[limit - 1];
            return { records: selected, next_after_id: hasMore ? lastRow?.id : undefined, next_after_priority: hasMore ? Number(lastRow?.sort_priority) : undefined, next_after_time: hasMore ? String(lastRow?.sort_time ?? "") : undefined, read_seq: readSeq, committed_seq: current, read_time: readTime, has_more: hasMore, scanned_rows: rows.length, returned_rows: selected.length };
        }));
    }
    /** Return changed subjects in a bounded sequence range for resume deltas. */
    async changedRecordSubjects(input: {
        engagement_id: string;
        from_read_seq: number;
        to_read_seq: number;
        limit?: number;
    }): Promise<Awaited<{ ids: string[]; has_more: boolean; scanned_rows: number }>> {
        const limit = input.limit ?? 1000;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000 || !Number.isSafeInteger(input.from_read_seq) || input.from_read_seq < 0 || !Number.isSafeInteger(input.to_read_seq) || input.to_read_seq < input.from_read_seq)
            throw new ContractValidationError("validation_error", "invalid bounded resume subject range");
        return (await this.readTransaction(async () => {
            const rows = (await this.sql.all<{ id: string }>("SELECT id FROM record_versions WHERE engagement_id=? AND commit_seq>? AND commit_seq<=? ORDER BY commit_seq,id LIMIT ?", input.engagement_id, input.from_read_seq, input.to_read_seq, limit + 1));
            return { ids: [...new Set(rows.slice(0, limit).map((row) => row.id))], has_more: rows.length > limit, scanned_rows: rows.length };
        }));
    }
    /** Read audit events for an already bounded subject set and sequence range. */
    async eventsForSubjects(input: {
        engagement_id: string;
        from_read_seq: number;
        to_read_seq: number;
        subject_ids: string[];
        include_candidates?: boolean;
        limit?: number;
    }): Promise<Awaited<{ events: AuditEvent[]; has_more: boolean; scanned_rows: number }>> {
        const limit = input.limit ?? 2000;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000 || !Number.isSafeInteger(input.from_read_seq) || input.from_read_seq < 0 || !Number.isSafeInteger(input.to_read_seq) || input.to_read_seq < input.from_read_seq)
            throw new ContractValidationError("validation_error", "invalid bounded event range");
        if (input.subject_ids.length === 0) return { events: [], has_more: false, scanned_rows: 0 };
        return (await this.readTransaction(async () => {
            const placeholders = input.subject_ids.map(() => "?").join(",");
            const trust = input.include_candidates ? "('L1','L2')" : "('L2')";
            const rows = (await this.sql.all<{ commit_seq: number; event_id: string; event_type: string; subject_id: string | null; payload: string; prev_hash: string | null; hash: string; created_at: string }>(`SELECT e.commit_seq,e.event_id,e.event_type,e.subject_id,e.payload,e.prev_hash,e.hash,e.created_at FROM events e
                WHERE e.commit_seq>? AND e.commit_seq<=? AND e.subject_id IN (${placeholders})
                AND EXISTS (SELECT 1 FROM record_versions rv WHERE rv.id=e.subject_id AND rv.engagement_id=? AND rv.commit_seq<=? AND rv.trust_level IN ${trust})
                ORDER BY e.commit_seq LIMIT ?`, input.from_read_seq, input.to_read_seq, ...input.subject_ids, input.engagement_id, input.to_read_seq, limit + 1));
            const selected = rows.slice(0, limit).map((row) => ({ commit_seq: row.commit_seq, event_id: row.event_id, event_type: row.event_type, subject_id: row.subject_id ?? undefined, payload: JSON.parse(row.payload) as Record<string, unknown>, prev_hash: row.prev_hash, hash: row.hash, created_at: row.created_at }));
            return { events: selected, has_more: rows.length > limit, scanned_rows: rows.length };
        }));
    }
    async executionCatalogRows(input: {
        engagement_id: string;
        session_id: string;
        work_run_id?: string;
        attempt_id?: string;
    }): Promise<Awaited<Array<Record<string, unknown>>>> {
        return (await this.executionCatalogPage({ ...input, page_size: 1000 })).items;
    }
    async executionCatalogPage(input: {
        engagement_id: string;
        session_id: string;
        work_run_id?: string;
        attempt_id?: string;
        cursor?: string;
        page_size: number;
    }): Promise<Awaited<{
        items: Array<Record<string, unknown>>;
        next_cursor?: string;
        index_watermark: number;
    }>> {
        const limit = Math.min(1000, Math.max(1, Math.trunc(input.page_size)));
        const cursor = input.cursor ? (() => { const [sequence, executionId] = input.cursor.split("\0"); const parsed = Number(sequence); if (!Number.isSafeInteger(parsed) || !executionId)
            throw new ContractValidationError("validation_error", "invalid execution cursor"); return { sequence: parsed, executionId }; })() : undefined;
        const where = ["engagement_id=?", "session_id=?"];
        const values: Array<string | number> = [input.engagement_id, input.session_id];
        if (input.work_run_id) {
            where.push("work_run_id=?");
            values.push(input.work_run_id);
        }
        if (input.attempt_id) {
            where.push("attempt_id=?");
            values.push(input.attempt_id);
        }
        if (cursor) {
            where.push("(sequence>? OR (sequence=? AND execution_id>?))");
            values.push(cursor.sequence, cursor.sequence, cursor.executionId);
        }
        const rows = (await this.sql.all(`SELECT execution_id,sequence,body FROM execution_catalog WHERE ${where.join(" AND ")} ORDER BY sequence,execution_id LIMIT ?`, ...values, limit + 1)) as Array<{
            execution_id: string;
            sequence: number;
            body: string;
        }>;
        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;
        const root = (await this.sql.get("SELECT root FROM artifact_sessions WHERE engagement_id=? AND session_id=?", input.engagement_id, input.session_id)) as {
            root?: string;
        } | undefined;
        const items = selected.map((row) => {
            const body = JSON.parse(row.body) as Record<string, unknown>;
            if (body.sealed === true || body.quarantine === true)
                return { ...body, sidecar_status: body.quarantine === true ? "quarantined" : "sealed" };
            if (typeof body.sidecar_path !== "string" || typeof body.sidecar_hash !== "string")
                return { ...body, sidecar_status: "unavailable" };
            try {
                const rootPath = resolve(root?.root ?? "");
                const path = realpathSync(join(rootPath, body.sidecar_path));
                if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`))
                    return { ...body, sidecar_status: "integrity_failed" };
                const content = readFileSync(path);
                return hash(content.toString("utf8")) === body.sidecar_hash ? { ...body, sidecar_status: "available" } : { ...body, sidecar_status: "integrity_failed" };
            }
            catch {
                return { ...body, sidecar_status: "unavailable" };
            }
        });
        const last = selected.at(-1);
        return { items, next_cursor: hasMore && last ? `${last.sequence}\0${last.execution_id}` : undefined, index_watermark: Number(((await this.sql.get("SELECT COALESCE(MAX(sequence),0) AS value FROM execution_catalog WHERE engagement_id=? AND session_id=?", input.engagement_id, input.session_id)) as {
                value: number;
            }).value) };
    }
    private async writeExecutionSidecar(input: {
        engagement_id: string;
        session_id?: string;
        work_run_id?: string;
        attempt_id?: string;
        generation?: number;
        kind: "checkpoint" | "action" | "result" | "error";
        reference_id: string;
        metadata: Record<string, unknown>;
    }): Promise<Awaited<Record<string, unknown>>> {
        if (!input.session_id)
            return { execution_id: input.reference_id, sidecar_status: "unbound" };
        const binding = (await this.sql.get("SELECT root FROM artifact_sessions WHERE engagement_id=? AND session_id=?", input.engagement_id, input.session_id)) as {
            root?: string;
        } | undefined;
        if (!binding?.root)
            throw new ContractValidationError("authorization_error", "execution sidecar requires a registered task session");
        if (input.work_run_id && input.generation !== undefined && input.metadata.quarantine !== true) {
            const runRow = (await this.sql.get("SELECT engagement_id,generation,status,lease_expires_at,body FROM work_runs WHERE run_id=?", input.work_run_id)) as {
                engagement_id?: string;
                generation?: number;
                status?: string;
                lease_expires_at?: string;
                body?: string;
            } | undefined;
            const runBody = runRow?.body ? JSON.parse(runRow.body) as Record<string, unknown> : {};
            const attemptRow = input.attempt_id ? (await this.sql.get("SELECT status,generation,owner_host,body FROM attempts WHERE attempt_id=? AND run_id=?", input.attempt_id, input.work_run_id)) as {
                status?: string;
                generation?: number;
                owner_host?: string;
                body?: string;
            } | undefined : undefined;
            const attemptBody = attemptRow?.body ? JSON.parse(attemptRow.body) as Record<string, unknown> : {};
            if (!runRow || runRow.engagement_id !== input.engagement_id || runBody.task_session_ref !== input.session_id || Number(runRow.generation) !== input.generation || runBody.attempt_ref !== input.attempt_id || !runRow.lease_expires_at || runRow.lease_expires_at <= (await this.sql.now()) || !["claimed", "running", "checkpointed", "blocked"].includes(String(runRow.status)) || !attemptRow || Number(attemptRow.generation) !== input.generation || !["claimed", "running", "checkpointed", "blocked"].includes(String(attemptRow.status)) || attemptBody.task_session_ref !== input.session_id)
                throw new ContractValidationError("stale_version", "execution sidecar is fenced by an inactive or stale Attempt");
        }
        const executionId = uuidv7();
        const storedAt = (await this.sql.now());
        const day = storedAt.slice(0, 10).split("-");
        const run = input.work_run_id ?? "unbound";
        const attempt = input.attempt_id ?? "unbound";
        const sequence = Number(((await this.sql.get("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM execution_catalog WHERE engagement_id=? AND session_id=?", input.engagement_id, input.session_id)) as {
            next: number;
        }).next);
        const dir = join(binding.root, "execution", ...day, run.slice(0, 2), run, attempt);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const body = { schema_version: "1.0.0", execution_id: executionId, kind: input.kind, engagement_id: input.engagement_id, session_id: input.session_id, work_run_id: input.work_run_id, attempt_id: input.attempt_id, generation: input.generation, sequence, reference_id: input.reference_id, stored_at: storedAt, ...sanitizeExecutionMetadata(input.metadata) as Record<string, unknown> };
        const text = `# Execution ${executionId}\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
        const temporary = join(dir, `.segment-${executionId}.tmp`);
        const path = join(dir, `${input.kind}-${String(sequence).padStart(8, "0")}.md`);
        writeFileSync(temporary, text, { mode: 0o600 });
        renameSync(temporary, path);
        const catalogBody = { ...body, sidecar_path: path.slice(binding.root.length + 1), sidecar_hash: hash(text) };
        (await this.sql.run("INSERT INTO execution_catalog(execution_id,engagement_id,session_id,work_run_id,attempt_id,sequence,body) VALUES(?,?,?,?,?,?,?)", executionId, input.engagement_id, input.session_id, input.work_run_id ?? null, input.attempt_id ?? null, sequence, JSON.stringify(catalogBody)));
        return catalogBody;
    }
    async saveArtifactSession(binding: {
        engagement_id: string;
        session_id: string;
        root: string;
        binding_id: string;
        created_at: string;
        mode: "host-session" | "run-bound";
        work_run_id?: string;
        attempt_id?: string;
        generation?: number;
        owner_host?: string;
    }): Promise<Awaited<void>> { (await this.transaction(async () => {
        if (binding.mode !== "host-session" && binding.mode !== "run-bound") throw new ContractValidationError("validation_error", "session binding mode is required");
        if (binding.mode === "run-bound") {
            if (!binding.work_run_id || !binding.attempt_id || !Number.isSafeInteger(binding.generation) || !binding.owner_host) throw new ContractValidationError("validation_error", "run-bound session requires complete run attribution");
            const run = await this.sql.get<{ engagement_id: string; generation: number; owner_host: string; lease_expires_at: string; status: string; body: string }>("SELECT engagement_id,generation,owner_host,lease_expires_at,status,body FROM work_runs WHERE run_id=?", binding.work_run_id);
            const attempt = await this.sql.get<{ engagement_id: string; generation: number; owner_host: string; lease_expires_at: string; status: string; body: string }>("SELECT engagement_id,generation,owner_host,lease_expires_at,status,body FROM attempts WHERE attempt_id=? AND run_id=?", binding.attempt_id, binding.work_run_id);
            const runBody = run ? JSON.parse(run.body) as Record<string, unknown> : {};
            const attemptBody = attempt ? JSON.parse(attempt.body) as Record<string, unknown> : {};
            const now = await this.sql.now();
            if (!run || !attempt || run.engagement_id !== binding.engagement_id || attempt.engagement_id !== binding.engagement_id || Number(run.generation) !== binding.generation || Number(attempt.generation) !== binding.generation || run.owner_host !== binding.owner_host || attempt.owner_host !== binding.owner_host || run.lease_expires_at !== attempt.lease_expires_at || run.lease_expires_at <= now || !["claimed", "running", "checkpointed", "blocked"].includes(run.status) || !["claimed", "running", "checkpointed", "blocked"].includes(attempt.status) || runBody.attempt_ref !== binding.attempt_id || attemptBody.task_session_ref !== undefined && attemptBody.task_session_ref !== binding.session_id || runBody.task_session_ref !== undefined && runBody.task_session_ref !== binding.session_id) throw new ContractValidationError("stale_version", "run-bound session requires the current active WorkRun and Attempt");
            runBody.task_session_ref = binding.session_id;
            attemptBody.task_session_ref = binding.session_id;
            await this.sql.run("UPDATE work_runs SET body=?,updated_at=? WHERE run_id=? AND engagement_id=? AND generation=? AND owner_host=? AND lease_expires_at>?", json(runBody), now, binding.work_run_id, binding.engagement_id, binding.generation, binding.owner_host, now);
            await this.sql.run("UPDATE attempts SET body=?,updated_at=? WHERE attempt_id=? AND run_id=? AND engagement_id=? AND generation=? AND owner_host=? AND lease_expires_at>?", json(attemptBody), now, binding.attempt_id, binding.work_run_id, binding.engagement_id, binding.generation, binding.owner_host, now);
        } else if (binding.work_run_id !== undefined || binding.attempt_id !== undefined || binding.generation !== undefined || binding.owner_host !== undefined) {
            throw new ContractValidationError("validation_error", "host-session binding cannot include run attribution");
        }
        const roots = (await this.sql.all("SELECT engagement_id,session_id,root FROM artifact_sessions WHERE NOT (engagement_id=? AND session_id=?)", binding.engagement_id, binding.session_id)) as Array<{
        engagement_id: string;
        session_id: string;
        root: string;
    }>; const path = resolve(binding.root); if (roots.some((owner) => { const other = resolve(owner.root); return path === other || path.startsWith(`${other}${sep}`) || other.startsWith(`${path}${sep}`); }))
        throw new ContractValidationError("authorization_error", "task session roots cannot overlap"); const owner = (await this.sql.get("SELECT engagement_id,session_id FROM artifact_sessions WHERE root=?", binding.root)) as {
        engagement_id: string;
        session_id: string;
    } | undefined; if (owner && (owner.engagement_id !== binding.engagement_id || owner.session_id !== binding.session_id))
        throw new ContractValidationError("authorization_error", "session root is already bound"); (await this.sql.run("INSERT INTO artifact_sessions(engagement_id,session_id,root,binding_id,created_at,mode,work_run_id,attempt_id,generation,owner_host) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(engagement_id,session_id) DO UPDATE SET binding_id=artifact_sessions.binding_id,created_at=artifact_sessions.created_at WHERE artifact_sessions.root=excluded.root AND artifact_sessions.mode=excluded.mode AND artifact_sessions.work_run_id IS NOT DISTINCT FROM excluded.work_run_id AND artifact_sessions.attempt_id IS NOT DISTINCT FROM excluded.attempt_id AND artifact_sessions.generation IS NOT DISTINCT FROM excluded.generation AND artifact_sessions.owner_host IS NOT DISTINCT FROM excluded.owner_host", binding.engagement_id, binding.session_id, binding.root, binding.binding_id, binding.created_at, binding.mode, binding.work_run_id ?? null, binding.attempt_id ?? null, binding.generation ?? null, binding.owner_host ?? null)); const row = (await this.sql.get("SELECT root,mode,work_run_id,attempt_id,generation,owner_host FROM artifact_sessions WHERE engagement_id=? AND session_id=?", binding.engagement_id, binding.session_id)) as {
        root?: string;
        mode?: string;
        work_run_id?: string;
        attempt_id?: string;
        generation?: number;
        owner_host?: string;
    } | undefined; if (!row || row.root !== binding.root || row.mode !== binding.mode || (row.work_run_id ?? undefined) !== binding.work_run_id || (row.attempt_id ?? undefined) !== binding.attempt_id || (row.generation ?? undefined) !== binding.generation || (row.owner_host ?? undefined) !== binding.owner_host)
        throw new ContractValidationError("conflict", "task session is already bound with different authority"); })); }
    async artifactCatalogRows(scope?: { engagement_id?: string; session_id?: string }): Promise<Awaited<Array<Record<string, unknown>>>> { const filter = this.artifactScope(scope); return ((await this.sql.all(`SELECT body FROM artifact_catalog${filter.where} ORDER BY stored_at,content_ref`, ...filter.values)) as Array<{
        body: string;
    }>).map((row) => JSON.parse(row.body) as Record<string, unknown>); }
    async artifactCatalogRow(engagementId: string, sessionId: string, contentRef: string): Promise<Awaited<Record<string, unknown> | undefined>> { const row = (await this.sql.get("SELECT body FROM artifact_catalog WHERE engagement_id=? AND session_id=? AND content_ref=?", engagementId, sessionId, contentRef)) as {
        body?: string;
    } | undefined; return row?.body ? JSON.parse(row.body) as Record<string, unknown> : undefined; }
    async artifactCatalogWatermark(engagementId: string, sessionId: string): Promise<Awaited<{
        catalog_watermark: number;
        index_watermark: number;
        index_status: string;
    }>> { const row = (await this.sql.get("SELECT catalog_watermark,index_watermark,index_status FROM artifact_catalog_watermarks WHERE engagement_id=? AND session_id=?", engagementId, sessionId)) as {
        catalog_watermark: number;
        index_watermark: number;
        index_status: string;
    } | undefined; return row ? { catalog_watermark: Number(row.catalog_watermark), index_watermark: Number(row.index_watermark), index_status: row.index_status } : { catalog_watermark: 0, index_watermark: 0, index_status: "current" }; }
    async queryArtifactCatalog(input: {
        engagement_id: string;
        session_id: string;
        category?: string;
        media_type?: string;
        work_run_id?: string;
        after?: {
            stored_at: string;
            content_ref: string;
        };
        limit: number;
    }): Promise<Awaited<{
        items: Array<Record<string, unknown>>;
        has_more: boolean;
        watermark: Awaited<ReturnType<AuthorityStore["artifactCatalogWatermark"]>>;
    }>> {
        const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit)));
        const where = ["engagement_id=?", "session_id=?"];
        const values: Array<string | number | null> = [input.engagement_id, input.session_id];
        if (input.category) {
            where.push("category=?");
            values.push(input.category);
        }
        if (input.media_type) {
            where.push("media_type=?");
            values.push(input.media_type);
        }
        if (input.work_run_id) {
            where.push("work_run_id=?");
            values.push(input.work_run_id);
        }
        if (input.after) {
            where.push("(stored_at>? OR (stored_at=? AND content_ref>?))");
            values.push(input.after.stored_at, input.after.stored_at, input.after.content_ref);
        }
        const rows = (await this.sql.all(`SELECT body FROM artifact_catalog WHERE ${where.join(" AND ")} ORDER BY stored_at,content_ref LIMIT ?`, ...values, limit + 1)) as Array<{
            body: string;
        }>;
        const has_more = rows.length > limit;
        return { items: rows.slice(0, limit).map((row) => JSON.parse(row.body) as Record<string, unknown>), has_more, watermark: (await this.artifactCatalogWatermark(input.engagement_id, input.session_id)) };
    }
    async explainArtifactCatalog(input: {
        engagement_id: string;
        session_id: string;
        category?: string;
        media_type?: string;
        work_run_id?: string;
    }): Promise<Awaited<string[]>> {
        const where = ["engagement_id=?", "session_id=?"];
        const values: string[] = [input.engagement_id, input.session_id];
        if (input.category) {
            where.push("category=?");
            values.push(input.category);
        }
        if (input.media_type) {
            where.push("media_type=?");
            values.push(input.media_type);
        }
        if (input.work_run_id) {
            where.push("work_run_id=?");
            values.push(input.work_run_id);
        }
        if (this.sql.backend === "postgresql") return (await this.sql.all<Record<string, string>>(`EXPLAIN SELECT body FROM artifact_catalog WHERE ${where.join(" AND ")} ORDER BY stored_at,content_ref LIMIT 101`, ...values)).map((row) => row["QUERY PLAN"]!);
        return ((await this.sql.all(`EXPLAIN QUERY PLAN SELECT body FROM artifact_catalog WHERE ${where.join(" AND ")} ORDER BY stored_at,content_ref LIMIT 101`, ...values)) as Array<{
            detail: string;
        }>).map((row) => row.detail);
    }
    async artifactPublications(scope?: { engagement_id?: string; session_id?: string }): Promise<Awaited<Array<{
        upload_id: string;
        engagement_id: string;
        session_id: string;
        content_ref: string;
        phase: string;
        body: Record<string, unknown>;
    }>>> { const filter = this.artifactScope(scope); return ((await this.sql.all(`SELECT upload_id,engagement_id,session_id,content_ref,phase,body FROM artifact_publications WHERE phase!='committed'${filter.where.replace(" WHERE ", " AND ")} ORDER BY updated_at,upload_id`, ...filter.values)) as Array<{
        upload_id: string;
        engagement_id: string;
        session_id: string;
        content_ref: string;
        phase: string;
        body: string;
    }>).map((row) => ({ ...row, body: JSON.parse(row.body) as Record<string, unknown> })); }
    async startArtifactPublication(uploadId: string, engagementId: string, sessionId: string, contentRef: string, publishPath: string): Promise<Awaited<void>> {
        (await this.transaction(async () => {
            const prior = (await this.sql.get("SELECT phase FROM artifact_publications WHERE upload_id=?", uploadId)) as {
                phase?: string;
            } | undefined;
            if (prior && prior.phase !== "quarantined")
                throw new ContractValidationError("conflict", "Artifact publication is already in progress");
            const event = (await this.nextEvent("artifact.publication.pending", { engagement_id: engagementId, session_id: sessionId, upload_id: uploadId, content_ref: contentRef }, uploadId));
            (await this.sql.run("INSERT INTO artifact_publications(upload_id,engagement_id,session_id,content_ref,phase,body,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(upload_id) DO UPDATE SET engagement_id=excluded.engagement_id,session_id=excluded.session_id,content_ref=excluded.content_ref,phase='publishing',body=excluded.body,updated_at=excluded.updated_at", uploadId, engagementId, sessionId, contentRef, "publishing", JSON.stringify({ publish_path: publishPath, marker_event_id: event.event_id, marker_commit_seq: event.commit_seq }), (await this.sql.now())));
        }));
    }
    async prepareArtifactPublication(uploadId: string, row: Record<string, unknown> & {
        content_ref: string;
        engagement_id: string;
        session_id: string;
    }, chunks: Array<{
        ordinal: number;
        offset: number;
        bytes: number;
        hash: string;
        path: string;
    }>, publishPath: string, idempotency?: {
        key: string;
        principal: string;
        request_hash: string;
        result: unknown;
    }): Promise<Awaited<void>> {
        (await this.transaction(async () => {
            const publication = (await this.sql.get("SELECT body FROM artifact_publications WHERE upload_id=? AND phase='publishing'", uploadId)) as {
                body?: string;
            } | undefined;
            if (!publication?.body)
                throw new ContractValidationError("conflict", "Artifact publication marker is unavailable");
            const prior = JSON.parse(publication.body) as Record<string, unknown>;
            const upload = await this.sql.get<{ body: string }>("SELECT body FROM artifact_uploads WHERE upload_id=? AND engagement_id=? AND session_id=?", uploadId, row.engagement_id, row.session_id);
            const principal = upload ? (JSON.parse(upload.body) as { principal?: string }).principal : undefined;
            await this.artifactWriteFence(row, principal);
            (await this.sql.run("UPDATE artifact_publications SET phase='ready',body=?,updated_at=? WHERE upload_id=?", JSON.stringify({ ...prior, row, chunks, publish_path: publishPath, idempotency, publication_principal: principal }), (await this.sql.now()), uploadId));
        }));
    }
    async completeArtifactPublication(uploadId: string, row: Record<string, unknown> & {
        content_ref: string;
        engagement_id: string;
        session_id: string;
        artifact_id: string;
        version: number;
        category?: string;
        stored_at: string;
        work_run_id?: string;
        attempt_id?: string;
        relative_dir: string;
        manifest_path: string;
    }, chunks: Array<{
        ordinal: number;
        offset: number;
        bytes: number;
        hash: string;
        path: string;
    }>, idempotency?: {
        key: string;
        principal: string;
        request_hash: string;
        result: unknown;
    }): Promise<Awaited<void>> {
        (await this.transaction(async () => {
            const publication = (await this.sql.get("SELECT engagement_id,session_id,content_ref,phase,body FROM artifact_publications WHERE upload_id=?", uploadId)) as {
                engagement_id: string;
                session_id: string;
                content_ref: string;
                phase?: string;
                body?: string;
            } | undefined;
            if (!publication || publication.engagement_id !== row.engagement_id || publication.session_id !== row.session_id || publication.content_ref !== row.content_ref)
                throw new ContractValidationError("conflict", "Artifact publication binding mismatch");
            const expected = publication.body ? JSON.parse(publication.body) as { row?: Record<string, unknown>; chunks?: unknown[]; idempotency?: unknown } : {};
            if (expected.row && (!samePayload(expected.row, row) || !samePayload(expected.chunks, chunks) || !samePayload(expected.idempotency, idempotency))) throw new ContractValidationError("conflict", "Artifact publication input differs from its prepared marker");
            if (publication.phase === "committed") {
                if (!expected.row || !Array.isArray(expected.chunks)) throw new ContractValidationError("conflict", "Artifact committed marker binding is incomplete");
                const stored = await this.artifactCatalogRow(row.engagement_id, row.session_id, row.content_ref);
                const storedChunks = await this.sql.all<{ ordinal: number; byte_offset: number; byte_count: number; chunk_hash: string; relative_path: string }>("SELECT ordinal,byte_offset,byte_count,chunk_hash,relative_path FROM artifact_chunks WHERE content_ref=? ORDER BY ordinal", row.content_ref);
                if (!samePayload(stored, row) || !samePayload(storedChunks.map((chunk) => ({ ordinal: chunk.ordinal, offset: chunk.byte_offset, bytes: chunk.byte_count, hash: chunk.chunk_hash, path: chunk.relative_path })), chunks)) throw new ContractValidationError("conflict", "Artifact committed catalog binding mismatch");
                if (idempotency?.key) {
                    const prior = await this.artifactIdempotencyResult(idempotency.key, "artifact.store.commit", idempotency.principal, row.engagement_id, idempotency.request_hash);
                    if (!samePayload(prior, idempotency.result)) throw new ContractValidationError("idempotency_conflict", "Artifact committed idempotency result mismatch");
                }
                return;
            }
            if (!["ready", "publishing", "published"].includes(String(publication.phase)))
                throw new ContractValidationError("conflict", "Artifact publication marker is unavailable");
            const upload = await this.sql.get<{ body: string }>("SELECT body FROM artifact_uploads WHERE upload_id=? AND engagement_id=? AND session_id=?", uploadId, row.engagement_id, row.session_id);
            const markerPrincipal = publication.body ? (JSON.parse(publication.body) as { publication_principal?: string }).publication_principal : undefined;
            await this.artifactWriteFence(row, upload ? (JSON.parse(upload.body) as { principal?: string }).principal : markerPrincipal);
            const category = typeof row.category === "string" ? row.category : null;
            const mediaType = typeof row.media_type === "string" ? row.media_type : null;
            (await this.sql.run("INSERT INTO artifact_catalog(content_ref,engagement_id,session_id,artifact_id,version,category,media_type,stored_at,work_run_id,attempt_id,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)", row.content_ref, row.engagement_id, row.session_id, row.artifact_id, row.version, category, mediaType, row.stored_at, typeof row.work_run_id === "string" ? row.work_run_id : null, typeof row.attempt_id === "string" ? row.attempt_id : null, JSON.stringify(row)));
            const add = "INSERT INTO artifact_chunks(content_ref,ordinal,byte_offset,byte_count,chunk_hash,relative_path) VALUES(?,?,?,?,?,?)";
            for (const chunk of chunks)
                (await this.sql.run(add, row.content_ref, chunk.ordinal, chunk.offset, chunk.bytes, chunk.hash, chunk.path));
            (await this.sql.run("DELETE FROM artifact_uploads WHERE upload_id=?", uploadId));
            if (idempotency?.key)
                (await this.sql.run("INSERT INTO artifact_idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", idempotency.key, "artifact.store.commit", idempotency.principal, row.engagement_id, idempotency.request_hash, JSON.stringify(idempotency.result)));
            (await this.sql.run("INSERT INTO artifact_catalog_watermarks(engagement_id,session_id,catalog_watermark,index_watermark,index_status) VALUES(?,?,1,1,'current') ON CONFLICT(engagement_id,session_id) DO UPDATE SET catalog_watermark=artifact_catalog_watermarks.catalog_watermark+1,index_watermark=artifact_catalog_watermarks.index_watermark+1,index_status='current'", row.engagement_id, row.session_id));
            const marker = JSON.parse(publication.body!) as {
                marker_commit_seq?: number;
            };
            if (marker.marker_commit_seq) {
                (await this.sql.run("UPDATE outbox SET status='applied' WHERE commit_seq=?", marker.marker_commit_seq));
                (await this.sql.run("UPDATE operation_markers SET status='indexed',updated_at=? WHERE commit_seq=? AND status='pending'", (await this.sql.now()), marker.marker_commit_seq));
            }
            (await this.sql.run("UPDATE artifact_publications SET phase='committed',updated_at=? WHERE upload_id=?", (await this.sql.now()), uploadId));
            (await this.nextEvent("artifact.content.committed", { engagement_id: row.engagement_id, session_id: row.session_id, content_ref: row.content_ref, byte_length: row.byte_length, content_hash: row.content_hash, chunk_count: row.chunk_count, work_run_id: row.work_run_id, attempt_id: row.attempt_id, generation: row.generation }, row.content_ref));
        }));
    }
    async updateArtifactCatalogRow(row: Record<string, unknown> & {
        content_ref: string;
        engagement_id: string;
        session_id: string;
    }, eventType: string): Promise<Awaited<void>> {
        (await this.transaction(async () => { (await this.sql.run("UPDATE artifact_catalog SET body=? WHERE engagement_id=? AND session_id=? AND content_ref=?", JSON.stringify(row), row.engagement_id, row.session_id, row.content_ref)); (await this.nextEvent(eventType, { engagement_id: row.engagement_id, session_id: row.session_id, content_ref: row.content_ref, content_status: row.content_status, integrity_status: row.integrity_status }, row.content_ref)); }));
    }
    async markArtifactPublication(uploadId: string, phase: "publishing" | "published" | "quarantined"): Promise<Awaited<void>> { (await this.transaction(async () => {
        const prior = await this.sql.get<{ phase: string }>("SELECT phase FROM artifact_publications WHERE upload_id=?", uploadId);
        if (prior?.phase === "committed" && phase === "published") return;
        const changed = (await this.sql.run("UPDATE artifact_publications SET phase=?,updated_at=? WHERE upload_id=? AND phase!='committed'", phase, (await this.sql.now()), uploadId)); if (Number(changed.changes) !== 1)
        throw new ContractValidationError("conflict", "Artifact publication marker is unavailable"); })); }
    async failArtifactPublication(uploadId: string, reason: string): Promise<Awaited<void>> { (await this.transaction(async () => { const row = (await this.sql.get("SELECT engagement_id,session_id,content_ref,phase,body FROM artifact_publications WHERE upload_id=?", uploadId)) as {
        engagement_id?: string;
        session_id?: string;
        content_ref?: string;
        phase?: string;
        body?: string;
    } | undefined; if (!row || row.phase === "committed")
        return; const marker = row.body ? JSON.parse(row.body) as {
        marker_commit_seq?: number;
    } : {}; const message = reason.slice(0, 512); (await this.sql.run("UPDATE artifact_publications SET phase='quarantined',body=?,updated_at=? WHERE upload_id=?", JSON.stringify({ ...(row.body ? JSON.parse(row.body) as Record<string, unknown> : {}), failure: message }), (await this.sql.now()), uploadId)); if (marker.marker_commit_seq) {
        (await this.sql.run("UPDATE outbox SET status='applied' WHERE commit_seq=?", marker.marker_commit_seq));
        (await this.sql.run("UPDATE operation_markers SET status='failed',error=?,updated_at=? WHERE commit_seq=?", message, (await this.sql.now()), marker.marker_commit_seq));
    } (await this.nextEvent("artifact.publication.quarantined", { engagement_id: row.engagement_id, session_id: row.session_id, content_ref: row.content_ref, reason: message }, uploadId)); })); }
    async saveArtifactCatalogRow(row: Record<string, unknown> & {
        content_ref: string;
        engagement_id: string;
        session_id: string;
        artifact_id: string;
        version: number;
        category?: string;
        stored_at: string;
        work_run_id?: string;
        attempt_id?: string;
        relative_dir: string;
        manifest_path: string;
    }, chunks: Array<{
        ordinal: number;
        offset: number;
        bytes: number;
        hash: string;
        path: string;
    }>, uploadId?: string, idempotency?: {
        key: string;
        principal: string;
        request_hash: string;
        result: unknown;
    }, principal?: string): Promise<Awaited<void>> {
        (await this.transaction(async () => { await this.artifactWriteFence(row, principal); const category = typeof row.category === "string" ? row.category : null; const mediaType = typeof row.media_type === "string" ? row.media_type : null; (await this.sql.run("INSERT INTO artifact_catalog(content_ref,engagement_id,session_id,artifact_id,version,category,media_type,stored_at,work_run_id,attempt_id,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)", row.content_ref, row.engagement_id, row.session_id, row.artifact_id, row.version, category, mediaType, row.stored_at, typeof row.work_run_id === "string" ? row.work_run_id : null, typeof row.attempt_id === "string" ? row.attempt_id : null, JSON.stringify(row))); const add = "INSERT INTO artifact_chunks(content_ref,ordinal,byte_offset,byte_count,chunk_hash,relative_path) VALUES(?,?,?,?,?,?)"; for (const chunk of chunks)
            (await this.sql.run(add, row.content_ref, chunk.ordinal, chunk.offset, chunk.bytes, chunk.hash, chunk.path)); if (uploadId)
            (await this.sql.run("DELETE FROM artifact_uploads WHERE upload_id=?", uploadId)); if (idempotency?.key)
            (await this.sql.run("INSERT INTO artifact_idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", idempotency.key, "artifact.store.commit", idempotency.principal, row.engagement_id, idempotency.request_hash, JSON.stringify(idempotency.result))); (await this.sql.run("INSERT INTO artifact_catalog_watermarks(engagement_id,session_id,catalog_watermark,index_watermark,index_status) VALUES(?,?,1,1,'current') ON CONFLICT(engagement_id,session_id) DO UPDATE SET catalog_watermark=artifact_catalog_watermarks.catalog_watermark+1,index_watermark=artifact_catalog_watermarks.index_watermark+1,index_status='current'", row.engagement_id, row.session_id)); (await this.nextEvent(row.content_status === "external" ? "artifact.reference.external" : "artifact.content.committed", { engagement_id: row.engagement_id, session_id: row.session_id, content_ref: row.content_ref, byte_length: row.byte_length, content_hash: row.content_hash, chunk_count: row.chunk_count, work_run_id: row.work_run_id, attempt_id: row.attempt_id, generation: row.generation }, row.content_ref)); }));
    }
    private async artifactWriteFence(row: Record<string, unknown>, principal?: string): Promise<void> {
        if (row.work_run_id === undefined && row.attempt_id === undefined && row.generation === undefined) return;
        if (typeof row.work_run_id !== "string" || typeof row.attempt_id !== "string" || !Number.isSafeInteger(row.generation) || typeof principal !== "string") throw new ContractValidationError("stale_version", "Artifact write requires an active owner and complete Attempt binding");
        await this.validateArtifactFence({ engagement_id: String(row.engagement_id), session_id: String(row.session_id), work_run_id: row.work_run_id, attempt_id: row.attempt_id, generation: row.generation as number, principal });
    }
    async saveArtifactUpload(uploadId: string, engagementId: string, sessionId: string, body: Record<string, unknown>): Promise<Awaited<void>> { (await this.transaction(async () => {
        const input = body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : body;
        await this.artifactWriteFence({ ...input, engagement_id: engagementId, session_id: sessionId }, typeof body.principal === "string" ? body.principal : undefined);
        (await this.sql.run("INSERT INTO artifact_uploads(upload_id,engagement_id,session_id,body,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(upload_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at", uploadId, engagementId, sessionId, JSON.stringify(body), (await this.sql.now())));
    })); }
    async artifactUploads(scope?: { engagement_id?: string; session_id?: string }): Promise<Awaited<Array<{
        upload_id: string;
        engagement_id: string;
        session_id: string;
        body: Record<string, unknown>;
    }>>> { const filter = this.artifactScope(scope); return ((await this.sql.all(`SELECT upload_id,engagement_id,session_id,body FROM artifact_uploads${filter.where}`, ...filter.values)) as Array<{
        upload_id: string;
        engagement_id: string;
        session_id: string;
        body: string;
    }>).map((row) => ({ ...row, body: JSON.parse(row.body) as Record<string, unknown> })); }
    async deleteArtifactUpload(uploadId: string): Promise<Awaited<void>> { (await this.transaction(async () => { (await this.sql.run("DELETE FROM artifact_uploads WHERE upload_id=?", uploadId)); })); }
    async artifactIdempotencyResult(key: string, operation: string, principal: string, engagementId: string, requestHash: string): Promise<Awaited<unknown | undefined>> { const row = (await this.sql.get("SELECT operation,principal,engagement_id,request_hash,result FROM artifact_idempotency WHERE key=?", key)) as {
        operation: string;
        principal: string;
        engagement_id: string;
        request_hash: string;
        result: string;
    } | undefined; if (!row)
        return undefined; if (row.operation !== operation || row.principal !== principal || row.engagement_id !== engagementId || row.request_hash !== requestHash)
        throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another Artifact request"); return JSON.parse(row.result) as unknown; }
    async saveArtifactIdempotency(key: string, operation: string, principal: string, engagementId: string, requestHash: string, result: unknown): Promise<Awaited<void>> { (await this.transaction(async () => { (await this.sql.run("INSERT INTO artifact_idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", key, operation, principal, engagementId, requestHash, JSON.stringify(result))); })); }
    async updateArtifactIdempotencyResult(key: string, operation: string, principal: string, engagementId: string, requestHash: string, result: unknown): Promise<Awaited<void>> { (await this.transaction(async () => { const changed = await this.sql.run("UPDATE artifact_idempotency SET result=? WHERE key=? AND operation=? AND principal=? AND engagement_id=? AND request_hash=?", JSON.stringify(result), key, operation, principal, engagementId, requestHash); if (changed.changes !== 1) throw new ContractValidationError("idempotency_conflict", "Artifact idempotency result is unavailable for update"); })); }
    async recordArtifactEvent(eventType: string, engagementId: string, subjectId: string, metadata: Record<string, unknown>): Promise<Awaited<void>> { (await this.transaction(async () => { (await this.nextEvent(eventType, { engagement_id: engagementId, ...metadata }, subjectId)); })); }
    /** Share the authority write lock across Artifact lookup, persistence and idempotency. */
    artifactMutation<T>(operation: () => Promise<T>): Promise<T> { return this.transaction(operation); }
    /** Authority corruption blocks further writes until an operator repairs the store. */
    private async authorityDrift(): Promise<Awaited<string[]>> {
        const errors: string[] = [];
        const events = (await this.sql.all("SELECT commit_seq FROM events ORDER BY commit_seq")) as Array<{
            commit_seq: number;
        }>;
        events.forEach((event, index) => { if (Number(event.commit_seq) !== index + 1)
            errors.push(`event sequence gap at ${event.commit_seq}`); });
        const counter = Number(((await this.sql.get("SELECT value FROM metadata WHERE key='display_sequence'")) as {
            value?: string;
        } | undefined)?.value ?? NaN);
        const aliases = (await this.sql.all("SELECT display_id FROM records WHERE display_id IS NOT NULL")) as Array<{
            display_id: string;
        }>;
        const maxAlias = aliases.reduce((max, row) => {
            const match = /^TAR-(\d+)$/.exec(row.display_id);
            if (!match)
                errors.push(`invalid display id in records: ${row.display_id}`);
            return match ? Math.max(max, Number(match[1])) : max;
        }, 0);
        if (!Number.isSafeInteger(counter) || counter < maxAlias + 1)
            errors.push(`display counter drift: ${Number.isFinite(counter) ? counter : "missing"} < ${maxAlias + 1}`);
        const idempotency = (await this.sql.all("SELECT key,operation,principal,engagement_id,request_hash,result FROM idempotency")) as Array<Record<string, unknown>>;
        for (const row of idempotency) {
            if (!["key", "operation", "principal", "engagement_id", "request_hash", "result"].every((field) => typeof row[field] === "string" && String(row[field]).length > 0))
                errors.push(`idempotency row ${String(row.key)} is incomplete`);
            if (typeof row.request_hash === "string" && !/^sha256:[a-f0-9]{64}$/.test(row.request_hash))
                errors.push(`idempotency row ${String(row.key)} has an invalid request hash`);
            try {
                JSON.parse(String(row.result));
            }
            catch {
                errors.push(`idempotency row ${String(row.key)} has invalid result`);
            }
        }
        const materialized = (await this.sql.all("SELECT r.id,r.version,r.body,r.engagement_id,r.kind,refs.engagement_id AS ref_engagement_id,refs.kind AS ref_kind FROM records r LEFT JOIN object_refs refs ON refs.id=r.id")) as Array<{
            id: string;
            version: number;
            body: string;
            engagement_id: string;
            kind: string;
            ref_engagement_id?: string;
            ref_kind?: string;
        }>;
        const histories = new Map<string, Array<{ body: string; payload: string | null }>>();
        for (const entry of await this.sql.all<{ id: string; body: string; payload: string | null }>("SELECT v.id,v.body,e.payload FROM record_versions v LEFT JOIN events e ON e.commit_seq=v.commit_seq ORDER BY v.id,v.commit_seq")) {
            const history = histories.get(entry.id) ?? [];
            history.push(entry);
            histories.set(entry.id, history);
        }
        for (const row of materialized) {
            const history = histories.get(row.id) ?? [];
            const latest = history.at(-1);
            const versions = history.map((entry) => Number((JSON.parse(entry.body) as CanonicalRecord).version));
            const baseline = history[0]?.payload;
            const importedVersion = baseline ? (JSON.parse(baseline) as { imported_version?: number }).imported_version : undefined;
            if (versions.some((version, index) => !Number.isSafeInteger(version) || version !== (importedVersion ?? 1) + index)) errors.push(`record version history drift: ${row.id}`);
            const currentVersion = versions.at(-1);
            if (!latest || latest.body !== row.body || currentVersion !== Number(row.version))
                errors.push(`record materialized view drift: ${row.id}`);
            if (row.ref_engagement_id !== row.engagement_id || row.ref_kind !== row.kind)
                errors.push(`object reference drift: ${row.id}`);
        }
        if (this.sql.backend === "sqlite" && this.#filename !== ":memory:") {
            try {
                const mode = statSync(this.#filename).mode;
                if ((mode & 0o200) === 0)
                    errors.push("authority store is not owner-writable");
                if ((mode & 0o022) !== 0)
                    errors.push("authority store is writable by group or other users");
            }
            catch {
                errors.push("authority store permissions could not be checked");
            }
        }
        const recordEvents = (await this.sql.all("SELECT e.commit_seq,e.subject_id,e.payload,v.body FROM events e LEFT JOIN record_versions v ON v.commit_seq=e.commit_seq WHERE e.event_type='record.commit'")) as Array<{
            commit_seq: number;
            subject_id: string | null;
            payload: string;
            body: string | null;
        }>;
        for (const row of recordEvents) {
            if (!row.body) {
                errors.push(`record event has no version row at sequence ${row.commit_seq}`);
                continue;
            }
            try {
                const payload = JSON.parse(row.payload) as Record<string, unknown>;
                if (payload.after_hash !== hash(row.body))
                    errors.push(`record event body drift at sequence ${row.commit_seq}`);
            }
            catch {
                errors.push(`record event payload is invalid at sequence ${row.commit_seq}`);
            }
        }
        return errors;
    }
    private async derivedDrift(): Promise<Awaited<{
        errors: string[];
        missingOutbox: number;
        missingMarkers: number;
    }>> {
        const errors: string[] = [];
        const missingOutbox = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM events e LEFT JOIN outbox o ON o.commit_seq=e.commit_seq WHERE o.commit_seq IS NULL")) as {
            count: number;
        }).count);
        const missingMarkers = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM events e LEFT JOIN operation_markers m ON m.commit_seq=e.commit_seq WHERE m.commit_seq IS NULL")) as {
            count: number;
        }).count);
        if (missingOutbox > 0)
            errors.push(`${missingOutbox} committed event(s) have no outbox row`);
        if (missingMarkers > 0)
            errors.push(`${missingMarkers} committed event(s) have no operation marker`);
        const invalidOutbox = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM outbox o LEFT JOIN events e ON e.commit_seq=o.commit_seq WHERE e.commit_seq IS NULL OR o.status NOT IN ('pending','applied')")) as {
            count: number;
        }).count);
        if (invalidOutbox > 0)
            errors.push(`${invalidOutbox} outbox row(s) reference missing events or have an invalid status`);
        const invalidMarkers = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM operation_markers m LEFT JOIN events e ON e.commit_seq=m.commit_seq AND e.event_id=m.event_id WHERE e.commit_seq IS NULL OR m.status NOT IN ('pending','applied','indexed','failed','recovered')")) as {
            count: number;
        }).count);
        if (invalidMarkers > 0)
            errors.push(`${invalidMarkers} operation marker(s) reference missing events or have an invalid status`);
        const inconsistentMarkers = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM operation_markers m JOIN outbox o ON o.commit_seq=m.commit_seq WHERE (m.status='pending' AND o.status!='pending') OR (m.status IN ('applied','indexed','recovered') AND o.status!='applied')")) as {
            count: number;
        }).count);
        if (inconsistentMarkers > 0)
            errors.push(`${inconsistentMarkers} operation marker(s) disagree with their outbox state`);
        const markerRows = (await this.sql.all("SELECT m.commit_seq,m.kind,m.input_hash,e.event_type,e.subject_id,e.payload FROM operation_markers m JOIN events e ON e.commit_seq=m.commit_seq")) as Array<{
            commit_seq: number;
            kind: string;
            input_hash: string;
            event_type: string;
            subject_id: string | null;
            payload: string;
        }>;
        for (const row of markerRows) {
            try {
                const payload = JSON.parse(row.payload) as Record<string, unknown>;
                if (row.kind !== row.event_type || row.input_hash !== hash(json({ event_type: row.event_type, subject_id: row.subject_id ?? undefined, payload })))
                    errors.push(`operation marker input drift at sequence ${row.commit_seq}`);
            }
            catch {
                errors.push(`operation marker payload is invalid at sequence ${row.commit_seq}`);
            }
        }
        return { errors, missingOutbox, missingMarkers };
    }
    private async assertAuthorityWritable(): Promise<Awaited<void>> {
        if (this.sql.backend === "sqlite" && this.#filename !== ":memory:") {
            const mode = statSync(this.#filename).mode;
            if ((mode & 0o200) === 0 || (mode & 0o022) !== 0)
                throw new ContractValidationError("conflict", "authority store permissions block writes");
        }
        const dataVersion = await this.sql.dataVersion();
        if (!this.#writeBlocked && this.#verifiedDataVersion === dataVersion)
            return;
        const errors = [...await this.authorityDrift(), ...(await this.verifyAudit()).errors];
        this.#writeBlocked = errors.length > 0;
        if (errors.length > 0)
            throw new ContractValidationError("conflict", `authority drift blocks writes: ${errors.join("; ")}`);
        this.#verifiedDataVersion = dataVersion;
    }
    private async projectedSequence(): Promise<Awaited<number>> {
        const committed = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as {
            seq: number;
        }).seq);
        const counts = (await this.sql.get("SELECT COUNT(*) AS count,COUNT(DISTINCT commit_seq) AS distinct_count FROM outbox")) as {
            count: number;
            distinct_count: number;
        };
        if (counts.count === committed && counts.distinct_count === committed) {
            const blocking = (await this.sql.get("SELECT MIN(commit_seq) AS seq FROM outbox WHERE status<>'applied'")) as {
                seq: number | null;
            };
            return blocking.seq === null ? committed : Number(blocking.seq) - 1;
        }
        // Only drift needs the full join. Ordinary page reads do not materialize the outbox.
        const blocking = (await this.sql.get("SELECT MIN(e.commit_seq) AS seq FROM events e LEFT JOIN outbox o ON o.commit_seq=e.commit_seq WHERE o.commit_seq IS NULL OR o.status<>'applied'")) as {
            seq: number | null;
        };
        return blocking.seq === null ? committed : Number(blocking.seq) - 1;
    }
    private isRecalled(record: CanonicalRecord, now: number): boolean {
        const status = String(record.status ?? "active");
        if (["stale", "retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(status) || record.recall_excluded === true)
            return true;
        return (typeof record.expires_at === "string" && Date.parse(record.expires_at) <= now)
            || (typeof record.review_after === "string" && Date.parse(record.review_after) <= now);
    }
    private async evidenceSnapshotHash(proposal: Proposal): Promise<Awaited<string>> {
        const references = [...new Set([
                ...(Array.isArray(proposal.content.evidence_refs) ? proposal.content.evidence_refs as string[] : []),
                ...(Array.isArray(proposal.content.claim_refs) ? proposal.content.claim_refs as string[] : []),
                ...(Array.isArray(proposal.content.counter_evidence_refs) ? proposal.content.counter_evidence_refs as string[] : []),
                ...(typeof proposal.content.applicable_scope_ref === "string" ? [proposal.content.applicable_scope_ref] : []),
            ])].sort();
        const referenceRows = (await this.referenceRecords(references));
        const now = Date.parse(await this.sql.now());
        const snapshot = references.map((id) => {
            const row = referenceRows.get(id);
            if (!row || row.engagement_id !== proposal.engagement_id)
                throw new ContractValidationError("validation_error", `review evidence is missing or outside the engagement: ${id}`);
            const record = JSON.parse(row.body!) as CanonicalRecord;
            if (this.isRecalled(record, now))
                throw new ContractValidationError("validation_error", `review evidence is not current: ${id}`);
            return { id, version: row.version, hash: hash(json(stablePayload(record))) };
        });
        return hash(json({ proposal_hash: proposal.content_hash, snapshot }));
    }
    private async captureReviewEvidenceSnapshot(proposal: Proposal): Promise<Awaited<{
        hash: string;
        evidence: Array<{ id: string; version: number; record?: CanonicalRecord; missing?: true }>;
    }>> {
        const references = [...new Set([
            ...(Array.isArray(proposal.content.evidence_refs) ? proposal.content.evidence_refs as string[] : []),
            ...(Array.isArray(proposal.content.claim_refs) ? proposal.content.claim_refs as string[] : []),
            ...(Array.isArray(proposal.content.counter_evidence_refs) ? proposal.content.counter_evidence_refs as string[] : []),
            ...(typeof proposal.content.applicable_scope_ref === "string" ? [proposal.content.applicable_scope_ref] : []),
        ])].sort();
        const referenceRows = await this.referenceRecords(references);
        const evidence: Array<{ id: string; version: number; record?: CanonicalRecord; missing?: true }> = [];
        const snapshot: Array<{ id: string; version: number; hash: string }> = [];
        for (const id of references) {
            const row = referenceRows.get(id);
            if (!row || row.engagement_id !== proposal.engagement_id) {
                evidence.push({ id, version: 0, missing: true });
                snapshot.push({ id, version: 0, hash: hash(json({ missing: true })) });
                continue;
            }
            const record = JSON.parse(row.body) as CanonicalRecord;
            evidence.push({ id, version: Number(row.version), record });
            snapshot.push({ id, version: Number(row.version), hash: hash(json(stablePayload(record))) });
        }
        return { hash: hash(json({ proposal_hash: proposal.content_hash, snapshot })), evidence };
    }
    /** Deterministic review material backed only by the immutable L1 admission snapshot. */
    async reviewPack(engagementId: string, proposalId: string): Promise<Awaited<{
        engagement_id: string;
        proposal_id: string;
        proposal_hash: string;
        policy_digest: string;
        evidence_snapshot_hash: string;
        admission_seq: number;
        proposal: Record<string, unknown>;
        evidence: Array<Record<string, unknown>>;
        pack_hash: string;
    }>> {
        return (await this.readTransaction(async () => {
            const binding = await this.sql.get<{ proposal_hash: string; canonical_id: string; policy_digest: string; evidence_snapshot_hash: string; admission_seq: number; evidence_snapshot: string }>(
                "SELECT proposal_hash,canonical_id,policy_digest,evidence_snapshot_hash,admission_seq,evidence_snapshot FROM admission_review_packs WHERE proposal_id=? AND engagement_id=?",
                proposalId, engagementId,
            );
            if (!binding) throw new ContractValidationError("conflict", "proposal has no admission-bound review snapshot");
            const proposalVersion = await this.sql.get<{ body: string }>(
                "SELECT body FROM proposal_versions WHERE id=? AND engagement_id=? AND commit_seq=?",
                proposalId, engagementId, binding.admission_seq,
            );
            if (!proposalVersion) throw new ContractValidationError("conflict", "admission-bound proposal snapshot is unavailable");
            const proposal = JSON.parse(proposalVersion.body) as Proposal;
            if (proposal.status !== "admitted" || proposal.content_hash !== binding.proposal_hash || proposal.canonical_id !== binding.canonical_id)
                throw new ContractValidationError("conflict", "admission-bound proposal snapshot does not match its binding");
            const sensitive = /(?:token|secret|credential|private_path|artifact_body|draft_body|raw_artifact|host_ref|location|summary|url|header|cookie|body|packet)/i;
            const safeProposal = sanitizeSnapshotRecord(proposal.content, sensitive) as Record<string, unknown>;
            const pinnedEvidence = JSON.parse(binding.evidence_snapshot) as Array<{ id: string; version: number; record?: CanonicalRecord; missing?: true }>;
            const snapshot = pinnedEvidence.map((item) => ({
                id: item.id,
                version: item.version,
                hash: item.missing ? hash(json({ missing: true })) : item.record ? hash(json(stablePayload(item.record))) : "",
            }));
            if (pinnedEvidence.some((item) => !item.id || (item.missing ? item.record !== undefined : !item.record || item.version !== item.record.version))
                || hash(json({ proposal_hash: binding.proposal_hash, snapshot })) !== binding.evidence_snapshot_hash)
                throw new ContractValidationError("conflict", "admission-bound evidence snapshot failed integrity validation");
            const evidence = pinnedEvidence.map((item) => ({
                id: item.id,
                version: item.version,
                ...(item.missing ? { missing: true } : {}),
                ...(item.record ? { record: sanitizeSnapshotRecord(item.record, sensitive) } : {}),
            }));
            const payload = {
                engagement_id: engagementId,
                proposal_id: proposalId,
                proposal_hash: binding.proposal_hash,
                policy_digest: binding.policy_digest,
                evidence_snapshot_hash: binding.evidence_snapshot_hash,
                admission_seq: Number(binding.admission_seq),
                proposal: safeProposal,
                evidence,
            };
            return { ...payload, pack_hash: hash(json(payload)) };
        }));
    }
    private async referenceRecords(ids: readonly string[]): Promise<Awaited<Map<string, {
        engagement_id: string;
        version: number;
        body: string;
    }>>> {
        const rows = new Map<string, {
            engagement_id: string;
            version: number;
            body: string;
        }>();
        for (let offset = 0; offset < ids.length; offset += 500) {
            const batch = ids.slice(offset, offset + 500);
            const selected = (await this.sql.all(`SELECT id,engagement_id,version,body FROM records WHERE id IN (${batch.map(() => "?").join(",")})`, ...batch)) as Array<{
                id: string;
                engagement_id: string;
                version: number;
                body: string;
            }>;
            for (const row of selected)
                rows.set(row.id, row);
        }
        return rows;
    }
    /**
     * Evidence snapshot digest that reports missing or recalled references instead of
     * throwing, so admission can return a structured reason rather than an exception
     * (task 1.2: invalid evidence must fail closed with an auditable cause).
     */
    private async evidenceSnapshot(proposal: Proposal): Promise<Awaited<{
        hash: string;
        errors: string[];
    }>> {
        try {
            return { hash: (await this.evidenceSnapshotHash(proposal)), errors: [] };
        }
        catch (cause) {
            return { hash: hash(json({ proposal_hash: proposal.content_hash, snapshot: "unavailable" })), errors: [cause instanceof Error ? cause.message : "evidence snapshot is unavailable"] };
        }
    }
    private transaction<T>(operation: () => T | Promise<T>): Promise<T> {
        return this.sql.transaction("write", async () => {
            if (this.#unitOfWork.getStore()?.active) return operation();
            const scope = { active: true };
            try { return await this.#unitOfWork.run(scope, async () => {
                await this.assertAuthorityWritable();
                const result = await operation();
                if (this.sql.backend === "sqlite") this.#verifiedDataVersion = await this.sql.dataVersion();
                return result;
            }); }
            finally { scope.active = false; }
        });
    }
    protected readTransaction<T>(operation: () => T | Promise<T>): Promise<T> {
        return this.sql.transaction("read", operation);
    }
    private async nextEvent(eventType: string, payload: Record<string, unknown>, subjectId?: string): Promise<Awaited<AuditEvent>> {
        // Every event carries attributable, content-free governance metadata. The
        // event payload remains extensible, while these fields make audit queries
        // deterministic across record, work, review, and action transitions.
        const metadata = {
            actor_id: String(payload.actor_id ?? "taric-core"),
            host_id: payload.host_id,
            worker_id: payload.worker_id ?? payload.agent_id,
            dispatch_id: payload.dispatch_id,
            work_item_id: payload.work_item_id,
            attempt_id: payload.attempt_id ?? payload.attempt_ref,
            proposal_id: payload.proposal_id,
            review_id: payload.review_id,
            entity_id: payload.entity_id ?? subjectId,
            policy_digest: payload.policy_digest,
            input_hash: payload.input_hash,
            evidence_refs: Array.isArray(payload.evidence_refs) ? payload.evidence_refs : undefined,
            idempotency_key: payload.idempotency_key,
            changed_fields: Array.isArray(payload.changed_fields) ? payload.changed_fields : undefined,
        };
        payload = { ...metadata, ...payload };
        const last = (await this.sql.get("SELECT hash FROM events ORDER BY commit_seq DESC LIMIT 1")) as {
            hash?: string;
        } | undefined;
        const created_at = (await this.sql.now());
        const prev_hash = last?.hash ?? null;
        const event_id = uuidv7();
        const canonical = json({ event_id, eventType, subjectId, payload, prev_hash, created_at });
        const event = { event_id, commit_seq: 0, event_type: eventType, subject_id: subjectId, payload, prev_hash, hash: hash(canonical), created_at, ...metadata } as AuditEvent;
        const sequence = (await this.sql.get<{ seq: number }>("SELECT COALESCE(MAX(commit_seq),0)+1 AS seq FROM events"))!.seq;
        await this.sql.run("INSERT INTO events(commit_seq,event_id,event_type,subject_id,payload,prev_hash,hash,created_at) VALUES(?,?,?,?,?,?,?,?)", sequence, event_id, eventType, subjectId ?? null, json(payload), prev_hash, event.hash, created_at);
        event.commit_seq = sequence;
        (await this.sql.run("INSERT INTO outbox(commit_seq) VALUES(?)", event.commit_seq));
        const owner = subjectId ? (await this.sql.get("SELECT engagement_id FROM object_refs WHERE id=? UNION SELECT engagement_id FROM proposals WHERE id=? UNION SELECT engagement_id FROM work_runs WHERE run_id=? LIMIT 1", subjectId, subjectId, subjectId)) as {
            engagement_id?: string;
        } | undefined : undefined;
        const engagementId = typeof payload.engagement_id === "string" ? payload.engagement_id : owner?.engagement_id;
        (await this.sql.run("INSERT INTO operation_markers(operation_id,event_id,engagement_id,commit_seq,kind,input_hash,status,updated_at) VALUES(?,?,?,?,?,?,?,?)", `operation:${event.event_id}`, event.event_id, engagementId ?? null, event.commit_seq, eventType, hash(json({ event_type: eventType, subject_id: subjectId, payload })), "pending", created_at));
        if (subjectId && eventType.startsWith("proposal.")) {
            const proposalRow = (await this.sql.get("SELECT * FROM proposals WHERE id=?", subjectId)) as {
                engagement_id: string;
                created_at: string;
            } | undefined;
            if (proposalRow)
                (await this.sql.run("INSERT INTO proposal_versions(id,engagement_id,commit_seq,body) VALUES(?,?,?,?)", subjectId, proposalRow.engagement_id, event.commit_seq, json({ ...this.proposalFromRow(proposalRow), created_at: proposalRow.created_at })));
        }
        return event;
    }
    private normalizeRecord(record: CanonicalRecord, trustLevel: TrustLevel, internal = false, now: string): CanonicalRecord {
        if (record.trust_level !== undefined && record.trust_level !== trustLevel)
            throw new ContractValidationError("validation_error", "caller cannot set trust level");
        if (!internal && record.display_id !== undefined)
            throw new ContractValidationError("validation_error", "caller cannot set display id");
        const kind = String(record.kind ?? record.type ?? "record");
        const source = internal ? Object.fromEntries(Object.entries(record).filter(([key]) => !["version", "trust_level", "display_id", "commit_seq"].includes(key))) : record;
        const normalized = { schema_version: SCHEMA_VERSION, created_at: now, provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" }, ...source } as unknown as CanonicalRecord;
        if (record.schema_version !== undefined && record.schema_version !== SCHEMA_VERSION)
            throw new ContractValidationError("unsupported_schema_version", "record schema version is not supported");
        // 声明了 schema_version 的 Phase 1 领域记录必须通过共享 JSON Schema 合同，不允许只做形状检查。
        // Internal updates originate from a previously validated canonical record. They still
        // pass cross-field validation below, while ordinary caller writes that declare a schema
        // version must satisfy the complete strict contract.
        if (!internal && record.schema_version !== undefined && (phaseOneContracts.has(kind) || recordContractNames[kind]))
            validateContract((recordContractNames[kind] ?? kind) as ContractName, normalized);
        // 跨字段安全护栏对每一条写入都生效，包括内部 writer 调用。
        validateCanonicalRecord(normalized, trustLevel);
        return normalized;
    }
    /** Core writer create path. Public callers submit candidates, never IDs. */
    async createRecord(record: Omit<CanonicalRecord, "id"> & {
        id?: never;
    }, trustLevel: TrustLevel = "L1", idempotencyKey?: string, context?: Partial<IdempotencyContext>): Promise<Awaited<CanonicalRecord>> {
        if (record.id !== undefined)
            throw new ContractValidationError("validation_error", "canonical create identity is assigned by Core");
        return (await this.transaction(async () => {
            const operation = context?.operation ?? "record.create";
            const principal = context?.principal ?? "core";
            const engagementId = String(record.engagement_id);
            const requestHash = hash(json(stablePayload({ record, assigned_trust: trustLevel })));
            if (idempotencyKey) {
                const prior = (await this.sql.get("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?", idempotencyKey)) as any;
                if (prior) {
                    if (prior.request_hash !== requestHash || prior.operation !== operation || prior.principal !== principal || prior.engagement_id !== engagementId)
                        throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
                    return JSON.parse(prior.result) as CanonicalRecord;
                }
            }
            const result = JSON.parse(json((await this.commit({ ...record, id: uuidv7() } as CanonicalRecord, trustLevel, undefined, context, false, 0)))) as CanonicalRecord;
            if (idempotencyKey)
                (await this.sql.run("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", idempotencyKey, operation, principal, engagementId, requestHash, json(result)));
            return result;
        }));
    }
    async initializeEngagement(input: {
        name?: string;
        scope?: {
            allowed_targets: string[];
            excluded_targets: string[];
            rules_of_engagement_ref: string;
        };
        [key: string]: unknown;
    }): Promise<Awaited<CanonicalRecord>> {
        if (input.id !== undefined || input.engagement_id !== undefined)
            throw new ContractValidationError("validation_error", "engagement identity is assigned by Core");
        if (!input.scope || typeof input.scope !== "object")
            throw new ContractValidationError("validation_error", "engagement initialization requires an explicit scope");
        if (Object.keys(input.scope).some((field) => !["allowed_targets", "excluded_targets", "rules_of_engagement_ref", "notes", "valid_from", "valid_until"].includes(field)))
            throw new ContractValidationError("validation_error", "engagement scope cannot set identity or writer fields");
        return (await this.transaction(async () => {
            const id = uuidv7();
            const scopeRef = (await this.commit({ ...input.scope, id: uuidv7(), schema_version: SCHEMA_VERSION, engagement_id: id, kind: "scope" }, "L2", undefined, undefined, false, 0)).id;
            return (await this.commit({ id, schema_version: SCHEMA_VERSION, engagement_id: id, kind: "engagement", name: input.name ?? "engagement", status: "active", scope_ref: scopeRef }, "L2", undefined, undefined, false, 0));
        }));
    }
    async commit(record: CanonicalRecord, trustLevel: TrustLevel = "L1", idempotencyKey?: string, context?: Partial<IdempotencyContext>, internal = false, expectedVersion?: number, importedDisplayId?: string, referencesValidated = false, importedVersion?: number): Promise<Awaited<CanonicalRecord>> {
        return (await this.transaction(async () => {
        expectedVersion ??= context?.expected_version;
        const normalized = this.normalizeRecord(record, trustLevel, internal, await this.sql.now());
        const operation = context?.operation ?? "record.commit";
        const principal = context?.principal ?? "core";
        const engagementId = context?.engagement_id ?? normalized.engagement_id;
        const requestHash = hash(json(stablePayload({ record, expected_version: expectedVersion })));
            if (idempotencyKey) {
                const prior = (await this.sql.get("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?", idempotencyKey)) as {
                    result?: string;
                    operation?: string;
                    principal?: string;
                    engagement_id?: string;
                    request_hash?: string;
                } | undefined;
                if (prior) {
                    if (prior.request_hash !== requestHash || prior.operation !== operation || prior.principal !== principal || prior.engagement_id !== engagementId)
                        throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
                    return JSON.parse(prior.result!) as CanonicalRecord;
                }
            }
            const now = (await this.sql.now());
            const existing = (await this.sql.get("SELECT version,body,display_id FROM records WHERE id=?", normalized.id)) as {
                version?: number;
                body?: string;
                display_id?: string;
            } | undefined;
            if (existing) {
                if (["resource_revision", "relation", "test_hypothesis", "attack_path", "protective_control_revision"].includes(String(normalized.kind ?? normalized.type)))
                    throw new ContractValidationError("conflict", "immutable revision records must be appended, not overwritten");
                if (expectedVersion === undefined || Number(existing.version) !== expectedVersion)
                    throw new ContractValidationError("stale_version", "canonical update requires the current expected version");
                const prior = JSON.parse(existing.body!) as CanonicalRecord;
                const nextKind = String(normalized.kind ?? normalized.type ?? "record");
                if (prior.engagement_id !== normalized.engagement_id || String(prior.kind ?? prior.type ?? "record") !== nextKind)
                    throw new ContractValidationError("conflict", "canonical engagement ownership and kind are immutable");
                const immutableFields = ["identity", "logical_identity", "resource_ref", "control_ref"];
                if (nextKind === "coverage") immutableFields.push("resource_revision_ref", "test_category", "identity_ref", "operation", "parameter", "conditions", "role", "tenant_ref", "path", "network_condition", "method");
                for (const field of immutableFields) {
                    if (prior[field] !== undefined && json(stablePayload(prior[field])) !== json(stablePayload(normalized[field])))
                        throw new ContractValidationError("conflict", "canonical logical identity is immutable");
                }
            }
            else if (expectedVersion !== undefined && expectedVersion !== 0) {
                throw new ContractValidationError("stale_version", "canonical create expected version must be zero");
            }
            if (importedVersion !== undefined && (existing || !internal || !importedDisplayId || !Number.isSafeInteger(importedVersion) || importedVersion < 1)) throw new ContractValidationError("validation_error", "snapshot version baseline is invalid");
            const version = importedVersion ?? (existing?.version ?? 0) + 1;
            const aliasSequence = existing || importedDisplayId ? undefined : Number(((await this.sql.get("SELECT value FROM metadata WHERE key='display_sequence'")) as {
                value: string;
            }).value);
            if (aliasSequence !== undefined)
                (await this.sql.run("UPDATE metadata SET value=? WHERE key='display_sequence'", String(aliasSequence + 1)));
            const old = existing?.body ? JSON.parse(existing.body) as CanonicalRecord : undefined;
            const committed = { ...normalized, version, trust_level: trustLevel, display_id: existing?.display_id ?? importedDisplayId ?? (aliasSequence === undefined ? undefined : `TAR-${String(aliasSequence).padStart(6, "0")}`) };
            if (!referencesValidated)
                validateAuthorityReferences(committed, (await this.referenceIndex(committed, normalized.engagement_id)), normalized.engagement_id);
            (await this.sql.run("INSERT INTO records(id,engagement_id,kind,trust_level,version,display_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,trust_level=excluded.trust_level,version=excluded.version,updated_at=excluded.updated_at", normalized.id, normalized.engagement_id, String(normalized.kind ?? normalized.type ?? "record"), trustLevel, version, committed.display_id ?? null, json(committed), now, now));
            (await this.sql.run("INSERT INTO object_refs(id,engagement_id,kind) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET engagement_id=excluded.engagement_id,kind=excluded.kind", normalized.id, normalized.engagement_id, String(normalized.kind ?? normalized.type ?? "record")));
            const event = (await this.nextEvent("record.commit", { version, imported_version: importedVersion, trust_level: trustLevel, actor_id: context?.principal ?? "taric-core", before_hash: old ? hash(json(old)) : null, after_hash: hash(json(committed)), changed_fields: Object.keys(committed).filter((key) => !old || json(old[key]) !== json((committed as Record<string, unknown>)[key])) }, normalized.id));
            (await this.sql.run("INSERT INTO record_versions(id,commit_seq,engagement_id,trust_level,body) VALUES(?,?,?,?,?)", normalized.id, event.commit_seq, normalized.engagement_id, trustLevel, json(committed)));
            const result = { ...committed, commit_seq: event.commit_seq };
            if (idempotencyKey)
                (await this.sql.run("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", idempotencyKey, operation, principal, engagementId, requestHash, json(result)));
            return result;
        }));
    }
    async get(id: string): Promise<Awaited<CanonicalRecord | undefined>> {
        const row = (await this.sql.get("SELECT body FROM records WHERE id=?", id)) as {
            body?: string;
        } | undefined;
        return row ? JSON.parse(row.body!) : undefined;
    }
    async getAt(id: string, readSeq: number): Promise<Awaited<CanonicalRecord | undefined>> {
        if (!Number.isSafeInteger(readSeq) || readSeq < 0)
            throw new ContractValidationError("validation_error", "read sequence must be a non-negative integer");
        const row = (await this.sql.get("SELECT body FROM record_versions WHERE id=? AND commit_seq<=? ORDER BY commit_seq DESC LIMIT 1", id, readSeq)) as {
            body: string;
        } | undefined;
        return row ? JSON.parse(row.body) as CanonicalRecord : undefined;
    }
    async list(engagementId: string, options: {
        trustLevel?: TrustLevel;
        includeCandidates?: boolean;
        includeRecalled?: boolean;
    } = {}): Promise<Awaited<CanonicalRecord[]>> {
        const now = Date.parse(await this.sql.now());
        const rows = (await this.sql.all("SELECT body,trust_level FROM records WHERE engagement_id=? ORDER BY updated_at,id", engagementId)) as Array<{
            body: string;
            trust_level: TrustLevel;
        }>;
        return rows.filter((row) => {
            const body = JSON.parse(row.body) as CanonicalRecord;
            return row.trust_level !== "L0" && (options.includeRecalled || !this.isRecalled(body, now)) && (options.includeCandidates || row.trust_level !== "L1" || options.trustLevel === "L1") && (!options.trustLevel || row.trust_level === options.trustLevel);
        }).map((row) => JSON.parse(row.body));
    }
    async snapshot(engagementId: string, options: {
        trustLevel?: TrustLevel;
        includeCandidates?: boolean;
        asOf?: number;
        readTime?: string;
        diagnostics?: (stage: "snapshot_hydration" | "snapshot_filter" | "snapshot_sort", elapsedMs: number) => void;
    } = {}): Promise<Awaited<ReadSnapshot>> {
        return (await this.readTransaction(async () => {
            const current = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as {
                seq: number;
            }).seq);
            const seq = options.asOf ?? current;
            if (!Number.isInteger(seq) || seq < 0 || seq > current)
                throw new ContractValidationError("conflict", `unsupported authority sequence: ${seq}`);
            const rows = (await this.sql.all("SELECT body,trust_level FROM record_versions WHERE engagement_id=? AND commit_seq<=? ORDER BY commit_seq DESC", engagementId, seq)) as Array<{
                body: string;
                trust_level: TrustLevel;
            }>;
            const readTime = options.readTime ?? (options.asOf === undefined ? (await this.sql.now()) : String(((await this.sql.get("SELECT created_at FROM events WHERE commit_seq<=? ORDER BY commit_seq DESC LIMIT 1", seq)) as {
                created_at?: string;
            } | undefined)?.created_at ?? "1970-01-01T00:00:00.000Z"));
            const asOfTime = Date.parse(readTime);
            if (!Number.isFinite(asOfTime))
                throw new ContractValidationError("validation_error", "snapshot read time is invalid");
            let records: CanonicalRecord[];
            if (options.diagnostics) {
                const hydrationStarted = performance.now();
                const hydrated = rows.map((row) => ({ row, body: JSON.parse(row.body) as CanonicalRecord }));
                options.diagnostics("snapshot_hydration", performance.now() - hydrationStarted);
                const filterStarted = performance.now();
                const seen = new Set<string>();
                records = hydrated.filter(({ row, body }) => {
                    if (seen.has(body.id)) return false;
                    seen.add(body.id);
                    const recalled = ["stale", "retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(String(body.status ?? "active")) || body.recall_excluded === true || (typeof body.expires_at === "string" && Date.parse(body.expires_at) <= asOfTime) || (typeof body.review_after === "string" && Date.parse(body.review_after) <= asOfTime);
                    return row.trust_level !== "L0" && !recalled && (options.includeCandidates || row.trust_level !== "L1" || options.trustLevel === "L1") && (!options.trustLevel || row.trust_level === options.trustLevel);
                }).map(({ body }) => body);
                options.diagnostics("snapshot_filter", performance.now() - filterStarted);
                const sortStarted = performance.now();
                records.sort((a, b) => a.id.localeCompare(b.id));
                options.diagnostics("snapshot_sort", performance.now() - sortStarted);
            } else {
                const seen = new Set<string>();
                records = rows.filter((row) => { const body = JSON.parse(row.body) as CanonicalRecord; if (seen.has(body.id))
                    return false; seen.add(body.id); const recalled = ["stale", "retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(String(body.status ?? "active")) || body.recall_excluded === true || (typeof body.expires_at === "string" && Date.parse(body.expires_at) <= asOfTime) || (typeof body.review_after === "string" && Date.parse(body.review_after) <= asOfTime); return row.trust_level !== "L0" && !recalled && (options.includeCandidates || row.trust_level !== "L1" || options.trustLevel === "L1") && (!options.trustLevel || row.trust_level === options.trustLevel); }).map((row) => JSON.parse(row.body) as CanonicalRecord).sort((a, b) => a.id.localeCompare(b.id));
            }
            const projected = (await this.projectedSequence());
            return { read_seq: seq, committed_seq: current, projected_seq: Math.min(projected, seq), read_time: readTime, records };
        }));
    }
    async doctor(): Promise<Awaited<DoctorReport>> {
        return (await this.readTransaction(async () => {
            const dataVersion = await this.sql.dataVersion();
            const schema = ((await this.sql.get("SELECT value FROM metadata WHERE key='schema_version'")) as {
                value?: string;
            } | undefined)?.value ?? "missing";
            const pending = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM outbox WHERE status != 'applied'")) as {
                count: number;
            }).count);
            const committed = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as {
                seq: number;
            }).seq);
            const projected = (await this.projectedSequence());
            const markerRows = (await this.sql.all("SELECT status,COUNT(*) AS count FROM operation_markers GROUP BY status")) as Array<{
                status: OperationMarker["status"];
                count: number;
            }>;
            const operation_markers = { pending: 0, applied: 0, indexed: 0, failed: 0, recovered: 0 } as Record<OperationMarker["status"], number>;
            for (const row of markerRows)
                if (row.status in operation_markers)
                    operation_markers[row.status] = Number(row.count);
            const audit = (await this.verifyAudit());
            const authorityErrors = [...(await this.authorityDrift())];
            if (schema !== SCHEMA_VERSION)
                authorityErrors.push(`unsupported schema version: ${schema}`);
            if (!audit.valid)
                authorityErrors.push(...audit.errors);
            this.#writeBlocked = authorityErrors.length > 0;
            if (!this.#writeBlocked)
                this.#verifiedDataVersion = dataVersion;
            const derivedState = (await this.derivedDrift());
            const derivedErrors = [...derivedState.errors];
            if (pending > 0)
                derivedErrors.push(`${pending} operation(s) remain pending in the outbox`);
            if (projected < committed)
                derivedErrors.push(`projection watermark is behind authority: ${projected} < ${committed}`);
            if (operation_markers.failed > 0)
                derivedErrors.push(`${operation_markers.failed} operation marker(s) failed and require recovery`);
            const errors = [...authorityErrors, ...derivedErrors];
            return {
                valid: errors.length === 0,
                schema_version: schema,
                committed_seq: committed,
                projected_seq: projected,
                pending_outbox: pending,
                operation_markers,
                authority: { valid: authorityErrors.length === 0, errors: authorityErrors },
                derived: { valid: derivedErrors.length === 0, errors: derivedErrors, repair_actions: derivedErrors.length > 0 ? ["run operator reconcile with action=preview, then action=replay or action=rebuild"] : [] },
                audit,
                errors,
                read_seq: committed,
                watermarks: { committed_seq: committed, projected_seq: projected },
            };
        }));
    }
    async operationMarkers(): Promise<Awaited<OperationMarker[]>> {
        return ((await this.sql.all("SELECT operation_id,event_id,engagement_id,commit_seq,kind,input_hash,status,error,retry_owner,updated_at FROM operation_markers ORDER BY commit_seq")) as Array<Record<string, unknown>>)
            .map((row) => ({ ...row, engagement_id: row.engagement_id ?? undefined, error: row.error ?? undefined, retry_owner: row.retry_owner ?? undefined, commit_seq: Number(row.commit_seq) }) as OperationMarker);
    }
    async previewRecovery(): Promise<Awaited<OperationRecoveryPreview>> {
        return (await this.readTransaction(async () => {
            const drift = (await this.derivedDrift());
            const failed = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM operation_markers WHERE status='failed'")) as {
                count: number;
            }).count);
            const authorityValid = (await this.authorityDrift()).length === 0 && (await this.verifyAudit()).valid;
            const writable = this.sql.backend === "postgresql" || this.#filename === ":memory:" || (() => { try {
                const mode = statSync(this.#filename).mode;
                return (mode & 0o200) !== 0 && (mode & 0o022) === 0;
            }
            catch {
                return false;
            } })();
            const repair_actions: string[] = [];
            if (drift.missingOutbox || drift.missingMarkers)
                repair_actions.push("rebuild derived outbox and operation markers from authority events");
            if (failed > 0)
                repair_actions.push("replay failed operations with an operator retry owner");
            if (!authorityValid)
                repair_actions.push("block authority writes and restore verified authority state before derived recovery");
            if (!writable)
                repair_actions.push("restore write permission for the authority store");
            const committed = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as {
                seq: number;
            }).seq);
            const projected = (await this.projectedSequence());
            return {
                action: "preview",
                committed_seq: committed,
                pending_outbox: Number(((await this.sql.get("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'")) as {
                    count: number;
                }).count),
                failed_markers: failed,
                missing_outbox: drift.missingOutbox,
                missing_markers: drift.missingMarkers,
                authority_valid: authorityValid,
                authority_writable: writable,
                repair_actions,
                read_seq: committed,
                projected_seq: projected,
                watermarks: { committed_seq: committed, projected_seq: projected },
            };
        }));
    }
    async exportSnapshot(engagementId: string, asOf?: number): Promise<Awaited<{
        schema_version: string;
        engagement_id: string;
        read_seq: number;
        committed_seq: number;
        projected_seq: number;
        records: CanonicalRecord[];
        hash: string;
    }>> {
        return (await this.readTransaction(async () => {
            const current = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as {
                seq: number;
            }).seq);
            const sequence = asOf ?? current;
            if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > current)
                throw new ContractValidationError("conflict", "unsupported authority sequence");
            const projected = Math.min((await this.projectedSequence()), sequence);
            const sensitive = /(?:token|secret|credential|private_path|artifact_body|draft_body|raw_artifact|host_ref|location|summary|url|header|cookie|body|packet)/i;
            // Export is an authority migration boundary, so retain L0 and recalled history
            // that the ordinary recall API intentionally hides.
            const rows = (await this.sql.all("SELECT rv.body FROM record_versions rv WHERE rv.engagement_id=? AND rv.commit_seq<=? AND NOT EXISTS(SELECT 1 FROM record_versions newer WHERE newer.id=rv.id AND newer.commit_seq<=? AND newer.commit_seq>rv.commit_seq) ORDER BY rv.id", engagementId, sequence, sequence)) as Array<{
                body: string;
            }>;
            const records = rows.map((row) => sanitizeSnapshotRecord(JSON.parse(row.body), sensitive) as CanonicalRecord);
            const payload = { schema_version: SCHEMA_VERSION, core_version: "1.0.2", engagement_id: engagementId, read_seq: sequence, committed_seq: current, projected_seq: projected, format: "taric-native-json", records };
            return { ...payload, hash: hash(json(payload)) };
        }));
    }
    async exportSnapshotJsonl(engagementId: string, asOf?: number): Promise<Awaited<string>> {
        const snapshot = (await this.exportSnapshot(engagementId, asOf));
        const header = { format: "taric-native-jsonl", schema_version: snapshot.schema_version, engagement_id: snapshot.engagement_id, read_seq: snapshot.read_seq, committed_seq: snapshot.committed_seq, projected_seq: snapshot.projected_seq, integrity_hash: snapshot.hash };
        return [json({ type: "manifest", ...header }), ...snapshot.records.map((record) => json({ type: "record", record }))].join("\n") + "\n";
    }
    async importSnapshot(snapshotInput: unknown): Promise<Awaited<{
        engagement_id: string;
        recovered_sequence: number;
        source_sequence: number;
        target_sequence: number;
        imported_records: number;
        integrity_verified: true;
        display_sequence: number;
    }>> {
        const snapshot = (typeof snapshotInput === "string"
            ? (snapshotInput.trim().includes("\n") ? { format: "taric-native-jsonl" } : JSON.parse(snapshotInput))
            : snapshotInput) as Record<string, unknown>;
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
            throw new ContractValidationError("validation_error", "snapshot must be an object or JSONL string");
        let normalized: Record<string, unknown>;
        if (snapshot.format === "taric-native-jsonl") {
            const lines = (typeof snapshotInput === "string" ? snapshotInput : "").trim().split(/\r?\n/);
            if (lines.length < 1)
                throw new ContractValidationError("validation_error", "snapshot JSONL is empty");
            const manifest = JSON.parse(lines[0]) as Record<string, unknown>;
            if (manifest.type !== "manifest" || lines.slice(1).some((line) => !line.trim()))
                throw new ContractValidationError("validation_error", "snapshot JSONL has an invalid manifest or empty row");
            const records = lines.slice(1).map((line) => {
                const row = JSON.parse(line) as Record<string, unknown>;
                if (row.type !== "record" || !row.record || typeof row.record !== "object")
                    throw new ContractValidationError("validation_error", "snapshot JSONL contains an invalid record row");
                return row.record;
            });
            normalized = { schema_version: manifest.schema_version, core_version: "1.0.2", engagement_id: manifest.engagement_id, read_seq: manifest.read_seq, committed_seq: manifest.committed_seq, projected_seq: manifest.projected_seq, format: "taric-native-json", records, hash: manifest.integrity_hash };
        }
        else
            normalized = snapshot;
        const { hash: suppliedHash, records, ...payload } = normalized;
        if (payload.schema_version !== SCHEMA_VERSION || payload.format !== "taric-native-json" || !UUID_V7_PATTERN.test(String(payload.engagement_id)) || !Number.isSafeInteger(payload.read_seq) || !Array.isArray(records) || typeof suppliedHash !== "string")
            throw new ContractValidationError("unsupported_schema_version", "snapshot metadata is incomplete or incompatible");
        if (hash(json(payloadWithRecords(payload, records))) !== suppliedHash)
            throw new ContractValidationError("validation_error", "snapshot integrity hash mismatch");
        const engagementId = String(payload.engagement_id);
        const candidates = records as CanonicalRecord[];
        if (!candidates.length || !candidates.some((record) => record.id === engagementId && String(record.kind) === "engagement"))
            throw new ContractValidationError("validation_error", "snapshot must contain its Engagement record");
        if (candidates.some((record) => !record || record.engagement_id !== engagementId || typeof record.id !== "string" || !/^TAR-[0-9]{6,}$/.test(String(record.display_id ?? ""))))
            throw new ContractValidationError("validation_error", "snapshot record ownership or display alias is invalid");
        const ids = new Set<string>();
        const aliases = new Set<string>();
        for (const record of candidates) {
            if (ids.has(record.id) || aliases.has(String(record.display_id)))
                throw new ContractValidationError("conflict", "snapshot contains duplicate record or display identity");
            ids.add(record.id);
            aliases.add(String(record.display_id));
            validateCanonicalRecord(record, record.trust_level);
            if (record.schema_version !== SCHEMA_VERSION)
                throw new ContractValidationError("unsupported_schema_version", "snapshot record schema version is incompatible");
            const kind = String(record.kind ?? "record");
            if (phaseOneContracts.has(kind) || recordContractNames[kind])
                validateContract((recordContractNames[kind] ?? kind) as ContractName, record);
        }
        return (await this.transaction(async () => {
            if ((await this.sql.get("SELECT 1 FROM records WHERE engagement_id=? LIMIT 1", engagementId)))
                throw new ContractValidationError("conflict", "snapshot destination Engagement already contains records");
            const referenceIds = [...new Set(candidates.flatMap(authorityReferenceIds))];
            const { engagement: allOwners, kind: allKinds, status: statuses } = (await this.referenceIdsIndex(referenceIds));
            for (const record of candidates) {
                allOwners.set(record.id, engagementId);
                allKinds.set(record.id, String(record.kind ?? "record"));
            }
            for (const record of candidates)
                statuses.set(record.id, String(record.status ?? "active"));
            for (const record of candidates)
                validateAuthorityReferences(record, { engagement: allOwners, kind: allKinds, status: statuses }, engagementId);
            let maxAlias = 0;
            for (const record of candidates)
                maxAlias = Math.max(maxAlias, Number(String(record.display_id).slice(4)));
            const displaySequence = Math.max(maxAlias + 1, Number((await this.sql.get<{ value: string }>("SELECT value FROM metadata WHERE key='display_sequence'"))?.value ?? 1));
            (await this.sql.run("UPDATE metadata SET value=? WHERE key='display_sequence'", String(displaySequence)));
            const importOrder = [...candidates].sort((a, b) => Number(a.kind !== "engagement") - Number(b.kind !== "engagement"));
            for (const record of importOrder)
                (await this.commit(record, (record.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, 0, String(record.display_id), true, Number(record.version)));
            const event = (await this.nextEvent("snapshot.import", { engagement_id: engagementId, source_sequence: payload.read_seq, imported_count: candidates.length, snapshot_hash: suppliedHash }));
            return { engagement_id: engagementId, recovered_sequence: event.commit_seq, source_sequence: Number(payload.read_seq), target_sequence: event.commit_seq, imported_records: candidates.length, integrity_verified: true as const, display_sequence: displaySequence };
        }));
    }
    async importSnapshotJsonl(source: string): Promise<Awaited<ReturnType<AuthorityStore["importSnapshot"]>>> { return (await this.importSnapshot(source)); }
    unsupported(operation: "snapshot.import" | "migration" | "backup.restore" | "remote.push"): never {
        throw new ContractValidationError("unsupported_capability", `unsupported capability: ${operation}`);
    }
    async createResourceRevision(input: ResourceRevisionInput): Promise<Awaited<{
        resource: CanonicalRecord;
        revision: CanonicalRecord;
    }>> {
        const rawInput = input as unknown as Record<string, unknown>;
        if (["id", "version", "trust_level", "trust_phase", "display_id", "commit_seq", "policy_digest", "policy_version", "review_ref", "review_refs"].some((field) => rawInput[field] !== undefined))
            throw new ContractValidationError("validation_error", "resource create identity and writer fields are assigned by Core");
        if (!/^sha256:[a-f0-9]{64}$/i.test(input.content_hash))
            throw new ContractValidationError("validation_error", "resource revision requires a sha256 content hash");
        if (input.valid_from && input.valid_until && Date.parse(input.valid_from) > Date.parse(input.valid_until))
            throw new ContractValidationError("validation_error", "valid_from must not be after valid_until");
        return (await this.transaction(async () => {
            let resource = input.resource_id ? (await this.get(input.resource_id)) : undefined;
            if (input.resource_id && !resource)
                throw new ContractValidationError("validation_error", "resource_id is an existing update target, not a create identity");
            if (resource && (resource.engagement_id !== input.engagement_id || resource.kind !== "resource"))
                throw new ContractValidationError("validation_error", "resource identity is unavailable in this Engagement");
            if (resource && resource.version !== input.expected_version)
                throw new ContractValidationError("stale_version", "resource revision requires the current expected_version");
            if (resource && input.identity && json(stablePayload(input.identity)) !== json(stablePayload(resource.identity)))
                throw new ContractValidationError("conflict", "resource logical identity is immutable");
            if (!resource && input.expected_version !== undefined && input.expected_version !== 0)
                throw new ContractValidationError("stale_version", "new resource expected_version must be zero");
            const identity = input.identity ?? (resource?.identity as Record<string, unknown> | undefined);
            if (!resource) {
                if (!input.asset_type || !identity || Object.values(identity).every((value) => value === undefined))
                    throw new ContractValidationError("validation_error", "new Resource requires asset_type and stable logical identity separate from its variant");
                const id = uuidv7();
                const resourceBody = { id, schema_version: SCHEMA_VERSION, created_at: (await this.sql.now()), engagement_id: input.engagement_id, kind: "resource", asset_type: input.asset_type, identity, revision: 1, provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "host" } } as CanonicalRecord;
                validateContract("resource", resourceBody);
                resource = (await this.commit(resourceBody, "L1"));
            }
            const prior = (await this.sql.get(`SELECT COUNT(*) AS count FROM records WHERE engagement_id=? AND kind='resource_revision' AND ${this.sql.jsonValue("body", "resource_ref")}=?`, input.engagement_id, resource.id)) as {
                count: number;
            };
            const revisionNumber = Number(prior.count) + 1;
            const sourceRefs = input.source_observation_refs ?? [];
            if (!sourceRefs.length)
                throw new ContractValidationError("validation_error", "ResourceRevision requires at least one source observation");
            const variant = Object.fromEntries(Object.entries({ method: input.method, path_template: input.path, parameters: input.parameter ? [input.parameter] : undefined, content_type: input.content_type, principal_ref: input.principal_ref, tenant_ref: input.tenant_ref }).filter(([, value]) => value !== undefined));
            const revisionBody = {
                id: uuidv7(), schema_version: SCHEMA_VERSION, created_at: (await this.sql.now()), engagement_id: input.engagement_id,
                provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "import", source_refs: sourceRefs },
                kind: "resource_revision", resource_ref: resource.id,
                revision: revisionNumber, logical_identity: identity, variant: input.variant ?? variant,
                content_hash: input.content_hash, source_observation_refs: sourceRefs, valid_from: input.valid_from ?? (await this.sql.now()), valid_until: input.valid_until,
                supersedes: prior.count ? (await this.sql.get(`SELECT id FROM records WHERE engagement_id=? AND kind='resource_revision' AND ${this.sql.jsonValue("body", "resource_ref")}=? ORDER BY version DESC,created_at DESC LIMIT 1`, input.engagement_id, resource.id))?.id : undefined,
            } as CanonicalRecord;
            validateContract("resourceRevision", revisionBody);
            const revision = (await this.commit(revisionBody, "L1", undefined, undefined, true, 0));
            const currentResource = (await this.get(resource.id))!;
            resource = (await this.commit({ ...currentResource, revision: revisionNumber, content_hash: input.content_hash }, (currentResource.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, Number(currentResource.version)));
            (await this.impact(revision.id, { engagement_id: input.engagement_id, limit: 100 }));
            return { resource, revision };
        }));
    }
    async reviseProtectiveControl(input: {
        engagement_id: string;
        control_ref: string;
        layer: "edge" | "network" | "origin" | "unknown";
        protected_resource_revision_refs: string[];
        identity_conditions: string[];
        network_conditions: string[];
        source_observation_refs: string[];
        policy_snapshot_hash?: string | null;
        principal?: string;
    }): Promise<Awaited<{
        revision: CanonicalRecord;
        applicability_event: CanonicalRecord;
    }>> {
        if (!input.source_observation_refs.length || !input.protected_resource_revision_refs.length)
            throw new ContractValidationError("validation_error", "control revision requires source observations and protected resource revisions");
        return (await this.transaction(async () => {
            const control = (await this.get(input.control_ref));
            if (!control || control.kind !== "protective_control" || control.engagement_id !== input.engagement_id)
                throw new ContractValidationError("validation_error", "ProtectiveControl is unavailable in this Engagement");
            const priorRows = (await this.sql.all(`SELECT body FROM records WHERE engagement_id=? AND kind='protective_control_revision' AND ${this.sql.jsonValue("body", "control_ref")}=? ORDER BY version DESC`, input.engagement_id, input.control_ref)) as Array<{
                body: string;
            }>;
            const prior = priorRows[0] ? JSON.parse(priorRows[0].body) as CanonicalRecord : undefined;
            const revisionBody = { id: uuidv7(), schema_version: SCHEMA_VERSION, created_at: (await this.sql.now()), engagement_id: input.engagement_id, provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "host", source_refs: input.source_observation_refs }, kind: "protective_control_revision", control_ref: input.control_ref, revision: priorRows.length + 1, layer: input.layer, policy_snapshot_hash: input.policy_snapshot_hash ?? null, protected_resource_revision_refs: input.protected_resource_revision_refs, identity_conditions: input.identity_conditions, network_conditions: input.network_conditions, valid_from: (await this.sql.now()), source_observation_refs: input.source_observation_refs, supersedes: prior?.id ?? null } as CanonicalRecord;
            validateContract("protectiveControlRevision", revisionBody);
            const revision = (await this.commit(revisionBody, "L1", undefined, undefined, true, 0));
            const applicability = (await this.commit({ id: uuidv7(), schema_version: SCHEMA_VERSION, created_at: (await this.sql.now()), engagement_id: input.engagement_id, provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "host", source_refs: input.source_observation_refs }, kind: "control_applicability_event", subject_refs: [input.control_ref], changed_dependency_ref: revision.id, previous_policy_hash: prior?.policy_snapshot_hash ?? null, current_policy_hash: input.policy_snapshot_hash ?? null, affected_current_view_refs: [], disposition: "requires_revalidation", reason_code: "control_changed", committed_at: (await this.sql.now()) } as CanonicalRecord, "L1", undefined, undefined, true, 0));
            (await this.impact(revision.id, { engagement_id: input.engagement_id, limit: 100 }));
            return { revision, applicability_event: applicability };
        }));
    }
    async addRelation(input: Omit<CanonicalRecord, "id" | "schema_version" | "created_at" | "provenance"> & {
        id?: string;
        source_observation_refs?: string[];
        valid_from?: string;
        valid_until?: string;
        criticality?: string;
    }): Promise<Awaited<CanonicalRecord>> {
        const body = input as Record<string, unknown>;
        if (["id", "version", "trust_level", "trust_phase", "display_id", "commit_seq", "policy_digest", "policy_version", "review_ref", "review_refs"].some((field) => body[field] !== undefined))
            throw new ContractValidationError("validation_error", "relation create identity and writer fields are assigned by Core");
        if (body.kind !== undefined && body.kind !== "relation")
            throw new ContractValidationError("validation_error", "relation candidate kind must be relation");
        if (typeof body.from_ref !== "string" || typeof body.to_ref !== "string" || typeof body.predicate !== "string")
            throw new ContractValidationError("validation_error", "typed Relation requires from_ref, predicate and to_ref");
        if (body.from_ref === body.to_ref && body.predicate !== "depends_on")
            throw new ContractValidationError("validation_error", "self relation is not allowed");
        const from = (await this.get(String(body.from_ref)));
        const to = (await this.get(String(body.to_ref)));
        if (!from || !to || from.engagement_id !== input.engagement_id || to.engagement_id !== input.engagement_id)
            throw new ContractValidationError("validation_error", "relation endpoints must belong to the same Engagement");
        const sourceRefs = Array.isArray(body.source_observation_refs) ? body.source_observation_refs : [];
        if (!sourceRefs.length)
            throw new ContractValidationError("validation_error", "typed Relation requires source observation references");
        const relation = { ...body, id: uuidv7(), kind: "relation", version: 1, engagement_id: input.engagement_id, from_type: body.from_type ?? from.kind, to_type: body.to_type ?? to.kind, source_observation_refs: sourceRefs, valid_from: body.valid_from ?? (await this.sql.now()), criticality: body.criticality ?? "medium", provenance: (body.provenance as Record<string, unknown>) ?? { host_id: "taric-core", producer_id: "taric-core", source_kind: "import", source_refs: sourceRefs } } as CanonicalRecord;
        validateContract("relation", { schema_version: SCHEMA_VERSION, created_at: (await this.sql.now()), ...relation });
        return (await this.commit(relation, "L1"));
    }
    async applyPatchSet(input: PatchSetInput): Promise<Awaited<PatchSetResult>> {
        if (input.id !== undefined)
            throw new ContractValidationError("validation_error", "PatchSet create identity is assigned by Core");
        if (!Number.isSafeInteger(input.base_generation) || input.base_generation < 0 || !Array.isArray(input.read_set) || !Array.isArray(input.write_set) || !Array.isArray(input.operations) || input.operations.length === 0)
            throw new ContractValidationError("validation_error", "PatchSet requires base generation, read_set, write_set and operations");
        if (!input.source_observation_refs?.length)
            throw new ContractValidationError("validation_error", "PatchSet requires source observation references");
        return (await this.transaction(async () => {
            const readEntries = input.read_set!.map((entry) => typeof entry === "string" ? { entity_ref: entry, version: Number(input.base_versions?.[entry] ?? 0) } : entry);
            const writeEntries = input.write_set!.map((entry) => typeof entry === "string" ? { entity_ref: entry, base_version: Number(input.base_versions?.[entry] ?? 0) } : entry);
            const baseVersions = input.base_versions ?? Object.fromEntries(readEntries.map((entry) => [entry.entity_ref, entry.version]));
            const writeIds = writeEntries.map((entry) => entry.entity_ref);
            const currentSeq = (await this.snapshot(input.engagement_id, { includeCandidates: true })).committed_seq;
            if (input.base_generation > currentSeq)
                throw new ContractValidationError("stale_version", "PatchSet base generation is ahead of authority");
            const runScoped = input.work_run_id !== undefined || input.attempt_ref !== undefined || input.generation !== undefined;
            if (runScoped) {
                if (!input.work_run_id || !input.attempt_ref || !Number.isSafeInteger(input.generation))
                    throw new ContractValidationError("validation_error", "run-scoped PatchSet requires WorkRun, Attempt and generation attribution");
                const run = (await this.sql.get("SELECT engagement_id,generation,lease_expires_at,status,body FROM work_runs WHERE run_id=?", input.work_run_id)) as {
                    engagement_id?: string;
                    generation?: number;
                    lease_expires_at?: string;
                    status?: string;
                    body?: string;
                } | undefined;
                const runBody = run?.body ? JSON.parse(run.body) as Record<string, unknown> : undefined;
                if (!run || run.engagement_id !== input.engagement_id || run.generation !== input.generation || run.lease_expires_at! <= (await this.sql.now()) || ["completed", "failed", "cancelled", "lost"].includes(String(run.status)) || runBody?.attempt_ref !== input.attempt_ref)
                    throw new ContractValidationError("stale_version", "PatchSet belongs to a stale or inactive Attempt");
            }
            const patchId = uuidv7();
            const changed: CanonicalRecord[] = [];
            const conflicts: CanonicalRecord[] = [];
            const allowedWriteIds = new Set(writeIds);
            for (const rawOperation of input.operations) {
                const op = typeof rawOperation === "string" ? { op: rawOperation === "upsert_resource" || rawOperation === "upsert_relation" ? "upsert" : rawOperation === "add_relation" ? "add_relation" : rawOperation === "remove_relation" ? "remove_relation" : "replace" } as PatchOperation : rawOperation;
                const operation = op.op ?? "replace";
                if (operation === "add_relation") {
                    const relation = op.relation ?? op.record;
                    if (!relation)
                        throw new ContractValidationError("validation_error", "add_relation requires a Relation record");
                    if (["id", "version", "trust_level", "trust_phase", "display_id", "commit_seq", "policy_digest", "policy_version", "review_ref", "review_refs"].some((field) => relation[field] !== undefined))
                        throw new ContractValidationError("validation_error", "relation create identity and writer fields are assigned by Core");
                    const from = String(relation.from_ref ?? "");
                    const to = String(relation.to_ref ?? "");
                    const predicate = String(relation.predicate ?? "");
                    const prior = (await this.sql.all("SELECT body FROM records WHERE engagement_id=? AND kind='relation'", input.engagement_id)) as Array<{
                        body: string;
                    }>;
                    const matching = prior.map((row) => JSON.parse(row.body) as CanonicalRecord).find((item) => item.from_ref === from && item.to_ref === to && item.predicate === predicate && String(item.status ?? "active") === "active");
                    if (matching) {
                        changed.push(matching);
                        continue;
                    }
                    const created = (await this.addRelation({ ...relation, engagement_id: input.engagement_id } as never));
                    changed.push(created);
                    writeEntries.push({ entity_ref: created.id, base_version: 0 });
                    continue;
                }
                if (operation === "remove_relation") {
                    const relationId = op.entity_id ?? op.id;
                    if (!relationId || !Number.isInteger(op.expected_version))
                        throw new ContractValidationError("validation_error", "relation removal requires an entity id and explicit expected_version CAS");
                    const relation = (await this.get(relationId));
                    if (!relation || relation.engagement_id !== input.engagement_id || relation.kind !== "relation")
                        throw new ContractValidationError("validation_error", "relation is unavailable in this Engagement");
                    if (Number(relation.version) !== op.expected_version)
                        throw new ContractValidationError("stale_version", "relation removal CAS failed");
                    changed.push((await this.transitionRecall(relationId, "stale", `removed by PatchSet ${patchId}`)));
                    continue;
                }
                const entityId = op.entity_id ?? op.id;
                if (!entityId && operation === "upsert") {
                    const candidate = op.record;
                    if (!candidate || candidate.engagement_id !== input.engagement_id || op.expected_version !== 0)
                        throw new ContractValidationError("validation_error", "PatchSet create requires a candidate and expected_version zero");
                    validateProposalCandidate(String(candidate.kind), candidate);
                    const created = (await this.createRecord({ ...candidate, provenance: { ...candidate.provenance, host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "host" } } as Omit<CanonicalRecord, "id"> & {
                        id?: never;
                    }, "L1"));
                    changed.push(created);
                    writeEntries.push({ entity_ref: created.id, base_version: 0 });
                    continue;
                }
                if (!entityId)
                    throw new ContractValidationError("validation_error", "PatchSet update requires an explicit entity id");
                if (input.write_set && !allowedWriteIds.has(entityId))
                    throw new ContractValidationError("validation_error", "PatchSet write_set does not contain the mutated entity");
                const existing = (await this.get(entityId));
                const body = op.record ?? op.patch ?? op.changes;
                if (!body || typeof body !== "object")
                    throw new ContractValidationError("validation_error", "PatchSet operation requires record or changes");
                if (!existing) {
                    throw new ContractValidationError("conflict", "PatchSet update target does not exist; creates cannot specify canonical identity");
                }
                if (existing.engagement_id !== input.engagement_id)
                    throw new ContractValidationError("validation_error", "PatchSet entity is unavailable in this Engagement");
                const baseVersion = input.base_versions?.[entityId] ?? op.expected_version;
                if (!Number.isInteger(baseVersion) || Number(baseVersion) > Number(existing.version))
                    throw new ContractValidationError("stale_version", "PatchSet requires the base version of each entity");
                const versionNumber = Number(baseVersion);
                const historical = (await this.sql.get(`SELECT body FROM record_versions WHERE id=? AND ${this.sql.jsonValue("body", "version", "number")}=? ORDER BY commit_seq DESC LIMIT 1`, entityId, versionNumber)) as {
                    body?: string;
                } | undefined;
                const base = historical ? JSON.parse(historical.body!) as CanonicalRecord : op.base;
                if (!base)
                    throw new ContractValidationError("conflict", "three-way merge requires base field values for a stale object");
                if (base.id !== entityId || base.engagement_id !== input.engagement_id || Number(base.version) !== Number(baseVersion))
                    throw new ContractValidationError("validation_error", "PatchSet base record does not match its declared identity/version");
                const changes = (operation === "replace" && op.patch === undefined && op.changes === undefined ? body : (op.patch ?? op.changes ?? body)) as Record<string, unknown>;
                const forbidden = new Set(["id", "engagement_id", "kind", "version", "trust_level", "trust_phase", "display_id", "commit_seq", "schema_version", "provenance", "policy_digest", "policy_version", "review_ref", "review_refs", "admission_status", "policy_result", "accept"]);
                if (Object.keys(changes).some((field) => forbidden.has(field)))
                    throw new ContractValidationError("validation_error", "PatchSet cannot write Core-managed identity fields");
                if (changes.status === "verified" || changes.status === "supported")
                    throw new ContractValidationError("validation_error", "PatchSet cannot assert an independently verified status");
                const merged: Record<string, unknown> = { ...existing };
                const fieldConflicts: Record<string, unknown> = {};
                const casFields = new Set(["status", "scope_ref", "applicable_scope_ref", "asset_type", "identity", "revision", "deleted", "recall_excluded"]);
                for (const [field, candidate] of Object.entries(changes)) {
                    const priorValue = existing[field];
                    const baseValue = base[field];
                    if (json(priorValue) === json(candidate))
                        continue;
                    if (json(priorValue) !== json(baseValue)) {
                        if (!casFields.has(field) && json(candidate) === json(baseValue))
                            continue;
                        fieldConflicts[field] = { base: baseValue, current: priorValue, candidate };
                        continue;
                    }
                    if (casFields.has(field) && Number(baseVersion) !== Number(existing.version)) {
                        fieldConflicts[field] = { base: baseValue, current: priorValue, candidate, requires_cas: true };
                        continue;
                    }
                    merged[field] = candidate;
                }
                if (Object.keys(fieldConflicts).length) {
                    const conflictId = uuidv7();
                    const sourceRefs = [...new Set([...(input.source_observation_refs ?? []), entityId])];
                    const candidateValues = Object.entries(fieldConflicts).flatMap(([field, value]) => {
                        const details = value as Record<string, unknown>;
                        return [{ value: details.current, source_refs: sourceRefs }, { value: details.candidate, source_refs: input.source_observation_refs }];
                    });
                    const conflictBody = { id: conflictId, schema_version: SCHEMA_VERSION, created_at: (await this.sql.now()), engagement_id: input.engagement_id, kind: "conflict", provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "import", source_refs: sourceRefs }, subject_ref: entityId, field_path: Object.keys(fieldConflicts).join(","), base_version: baseVersion, current_version: Number(existing.version), base_value: base, candidates: candidateValues, source_refs: sourceRefs, diff: changes, merge_status: "open" } as CanonicalRecord;
                    validateContract("conflict", conflictBody);
                    const conflict = (await this.commit(conflictBody, "L1", undefined, undefined, true, 0));
                    conflicts.push(conflict);
                }
                if (Object.keys(merged).some((field) => json(merged[field]) !== json(existing[field]))) {
                    const changedFinding = existing.kind === "finding";
                    if (changedFinding) {
                        merged.status = "draft";
                        merged.trust_level = "L1";
                        merged.trust_phase = "machine_approved";
                        delete merged.review_ref;
                        delete merged.review_refs;
                        delete merged.policy_digest;
                        delete merged.policy_version;
                    }
                    changed.push((await this.commit(merged as CanonicalRecord, changedFinding ? "L1" : (existing.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, Number(existing.version))));
                }
            }
            const status = conflicts.length ? "conflict" : "merged";
            const patchSourceRefs = [...new Set(input.source_observation_refs)];
            const patchOperations = input.operations.map((operation) => typeof operation === "string" ? operation : operation.op === "add_relation" ? "add_relation" : operation.op === "remove_relation" ? "remove_relation" : operation.op === "upsert" ? "upsert_resource" : "replace_property");
            const patchBody = { id: patchId, schema_version: SCHEMA_VERSION, created_at: (await this.sql.now()), engagement_id: input.engagement_id, kind: "patch_set", provenance: { host_id: "taric-core", producer_id: input.principal ?? "taric-core", source_kind: "import", source_refs: patchSourceRefs }, base_generation: input.base_generation, read_set: readEntries, write_set: writeEntries, operations: patchOperations, source_refs: patchSourceRefs, content_hash: hash(json(input.operations)), merge_status: status === "conflict" ? "conflict" : "merged" } as CanonicalRecord;
            validateContract("patchSet", patchBody);
            const patch = (await this.commit(patchBody, "L1", undefined, undefined, true, 0));
            (await this.nextEvent("patch.merge", { patch_id: patch.id, base_generation: input.base_generation, read_set: input.read_set ?? [], write_set: input.write_set ?? [], merge_status: status, merge_result_refs: changed.map((record) => record.id), conflict_refs: conflicts.map((record) => record.id) }, patch.id));
            return { patch_id: patch.id, status, generation: Number((await this.snapshot(input.engagement_id, { includeCandidates: true })).committed_seq), records: changed, conflicts };
        }));
    }
    async impact(sourceId: string, options: {
        engagement_id: string;
        limit?: number;
        continuation?: string;
    }): Promise<Awaited<ImpactResult>> {
        const limit = options.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            throw new ContractValidationError("validation_error", "impact limit must be between 1 and 1000");
        let state: {
            v: 1;
            engagement_id: string;
            source_id: string;
            queue: string[];
            visited: string[];
            event_id: string;
        };
        if (options.continuation) {
            const [payload, signature] = options.continuation.split(".");
            const expected = createHmac("sha256", impactCursorKey).update(payload ?? "").digest("base64url");
            if (!payload || !signature || Buffer.byteLength(expected) !== Buffer.byteLength(signature) || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
                throw new ContractValidationError("validation_error", "invalid ImpactEvent continuation");
            state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof state;
            if (state.v !== 1 || state.engagement_id !== options.engagement_id || state.source_id !== sourceId)
                throw new ContractValidationError("validation_error", "ImpactEvent continuation binding mismatch");
        }
        else
            state = { v: 1, engagement_id: options.engagement_id, source_id: sourceId, queue: [sourceId], visited: [], event_id: uuidv7() };
        const processed: string[] = [];
        return (await this.transaction(async () => {
            const event = (await this.get(state.event_id));
            if (options.continuation && (!event || event.continuation !== options.continuation))
                throw new ContractValidationError("stale_version", "ImpactEvent continuation is stale or already consumed");
            if (!event) {
                const source = (await this.get(state.source_id))!;
                const reasonCode = String(source.kind).includes("control") ? "control_changed" : source.kind === "claim" ? "claim_withdrawn" : "resource_changed";
                const body = { id: state.event_id, schema_version: SCHEMA_VERSION, created_at: (await this.sql.now()), engagement_id: state.engagement_id, kind: "impact_event", source_ref: state.source_id, changed_dependency_ref: state.source_id, affected_refs: [], criticality: (source.criticality as string) ?? "high", disposition: "requires_revalidation", reason_code: reasonCode, provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" } } as CanonicalRecord;
                validateContract("impactEvent", body);
                (await this.commit(body, "L1", undefined, undefined, true, 0));
            }
            while (state.queue.length && processed.length < limit) {
                const premise = state.queue.shift()!;
                if (state.visited.includes(premise))
                    continue;
                const initialPremiseRecord = (await this.get(premise));
                if (!initialPremiseRecord || initialPremiseRecord.engagement_id !== state.engagement_id)
                    throw new ContractValidationError("validation_error", "impact source is unavailable in this Engagement");
                state.visited.push(premise);
                processed.push(premise);
                const rows = (await this.sql.all("SELECT id,body FROM records WHERE engagement_id=?", state.engagement_id)) as Array<{
                    id: string;
                    body: string;
                }>;
                const premiseRecord = (await this.get(premise))!;
                const premiseAliases = new Set([premise, ...["resource_ref", "control_ref"].map((field) => premiseRecord[field]).filter((value): value is string => typeof value === "string")]);
                for (const row of rows) {
                    const candidate = JSON.parse(row.body) as CanonicalRecord;
                    const dependsByField = Object.entries(candidate).some(([field, value]) => ["depends_on", "derived_from", "source_refs", "claim_refs", "evidence_refs", "observation_refs", "resource_ref", "resource_revision_ref", "control_ref", "control_observation_ref", "checkpoint_ref", "finding_refs", "hypothesis_refs", "attack_path_refs"].includes(field) && ([...premiseAliases].includes(value as string) || Array.isArray(value) && value.some((item) => premiseAliases.has(String(item)))));
                    const relationRows = (await this.sql.all("SELECT body FROM records WHERE engagement_id=? AND kind='relation'", state.engagement_id)) as Array<{
                        body: string;
                    }>;
                    const relationDependent = relationRows.some((edgeRow) => { const edge = JSON.parse(edgeRow.body) as CanonicalRecord; return ["depends_on", "derived_from"].includes(String(edge.predicate)) && premiseAliases.has(String(edge.to_ref)) && edge.from_ref === candidate.id; });
                    if ((dependsByField || relationDependent) && !state.visited.includes(candidate.id) && !state.queue.includes(candidate.id))
                        state.queue.push(candidate.id);
                }
            }
            const affected = processed.filter((id) => id !== state.source_id);
            const workItems: string[] = [];
            for (const id of affected) {
                const record = (await this.get(id));
                if (!record)
                    continue;
                if (["claim", "test_hypothesis", "finding", "coverage_cell", "checkpoint", "context_pack", "attack_path", "action_intent"].includes(String(record.kind))) {
                    let stale = record;
                    if (["checkpoint", "action_intent", "coverage_cell"].includes(String(record.kind))) {
                        const applicability = (await this.commit({ id: uuidv7(), engagement_id: state.engagement_id, kind: "control_applicability_event", subject_refs: [id], changed_dependency_ref: state.source_id, affected_current_view_refs: [id], disposition: "requires_revalidation", reason_code: "control_changed", committed_at: (await this.sql.now()), provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" } }, "L1"));
                        stale = { ...record, applicability_event_ref: applicability.id, applicability_status: "stale" };
                    }
                    else
                        stale = (await this.markStale(id, `dependency ${state.source_id} changed; ImpactEvent ${state.event_id}`));
                    if (["claim", "test_hypothesis", "finding", "attack_path", "action_intent"].includes(String(stale.kind))) {
                        const work = (await this.commit({ id: uuidv7(), engagement_id: state.engagement_id, kind: "work_item", title: `Revalidate ${String(stale.display_id ?? stale.id)}`, status: "queued", acceptance_criteria: [`Revalidate dependency ${state.source_id}`, "Record updated evidence and applicability"], related_entity_ref: id, impact_event_ref: state.event_id, risk_class: "informational", provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" } }, "L1"));
                        workItems.push(work.id);
                    }
                }
            }
            const done = state.queue.length === 0;
            const continuation = done ? undefined : (() => { const payload = Buffer.from(json(state)).toString("base64url"); const signature = createHmac("sha256", impactCursorKey).update(payload).digest("base64url"); return `${payload}.${signature}`; })();
            const eventRecord = (await this.get(state.event_id))!;
            const impactBody = { ...eventRecord, affected_refs: [...new Set([...(eventRecord.affected_refs as string[] ?? []), ...affected])], continuation, pending_watermark: done ? undefined : (await this.snapshot(state.engagement_id, { includeCandidates: true })).committed_seq } as CanonicalRecord;
            validateContract("impactEvent", impactBody);
            const updated = (await this.commit(impactBody, "L1", undefined, undefined, true, Number(eventRecord.version), undefined, true));
            return { event_id: updated.id, affected_ids: affected, revalidation_work_item_ids: workItems, continuation, pending_watermark: (await this.snapshot(state.engagement_id, { includeCandidates: true })).committed_seq };
        }));
    }
    async markDependentsStale(sourceId: string, engagementId: string, limit = 100): Promise<Awaited<ImpactResult>> { return (await this.impact(sourceId, { engagement_id: engagementId, limit })); }
    private proposalFromRow(row: any): Proposal {
        return { id: row.id, proposal_id: row.id, engagement_id: row.engagement_id, subject_type: row.subject_type, expected_version: Number(row.expected_version), target_id: row.target_id ?? undefined, client_request_id: row.client_request_id ?? undefined, canonical_id: row.canonical_id ?? undefined, canonical_version: row.canonical_version ?? undefined, status: row.status, content_hash: row.content_hash, content: JSON.parse(row.body) };
    }
    private async validateProposalTarget(proposal: ProposalEnvelope): Promise<Awaited<CanonicalRecord | undefined>> {
        const target = proposal.target_id ?? proposal.subject_ref;
        if (!target)
            return undefined;
        const current = (await this.get(target));
        if (!current)
            throw new ContractValidationError("validation_error", "proposal target does not exist");
        if (current.engagement_id !== proposal.engagement_id || current.kind !== proposal.content.kind)
            throw new ContractValidationError("conflict", "proposal target engagement ownership and kind must match");
        if (current.version !== proposal.expected_version)
            throw new ContractValidationError("stale_version", "proposal target version is stale");
        for (const field of ["identity", "logical_identity", "resource_ref", "control_ref"]) {
            if (current[field] !== undefined && json(stablePayload(current[field])) !== json(stablePayload(proposal.content[field])))
                throw new ContractValidationError("conflict", "proposal cannot change canonical logical identity");
        }
        return current;
    }
    async submitProposal(proposal: ProposalEnvelope, options: GovernanceWriteOptions = {}): Promise<Awaited<Proposal>> {
        validateProposalEnvelope(proposal);
        return (await this.transaction(async () => {
            const id = proposal.proposal_id ?? uuidv7();
            const inputProvenance = proposal.content.provenance as Record<string, unknown> | undefined;
            const content = {
                created_at: typeof proposal.content.created_at === "string" ? proposal.content.created_at : (await this.sql.now()),
                provenance: { host_id: String(inputProvenance?.host_id ?? options.principal ?? "taric-core"), producer_id: String(inputProvenance?.producer_id ?? options.principal ?? "taric-core"), source_kind: String(inputProvenance?.source_kind ?? "host"), ...inputProvenance },
                ...proposal.content,
            } as ProposalCandidate;
            const runId = options.workRunId ?? (typeof content.work_run_ref === "string" ? content.work_run_ref : undefined);
            const generation = options.generation ?? (typeof content.generation === "number" ? content.generation : undefined);
            const attemptId = options.attemptId ?? (typeof content.attempt_ref === "string" ? content.attempt_ref : undefined);
            const sessionId = options.sessionId;
            const runAttribution = runId && attemptId && Number.isSafeInteger(generation)
                ? { work_run_id: runId, attempt_id: attemptId, generation, ...(sessionId ? { session_id: sessionId } : {}) }
                : undefined;
            const content_hash = hash(json(stablePayload(content)));
            const result: Proposal = JSON.parse(json({ ...proposal, id, proposal_id: id, target_id: proposal.target_id ?? proposal.subject_ref, content, ...(runAttribution ? { run_attribution: runAttribution } : {}), content_hash, status: "pending" })) as Proposal;
            const requestHash = hash(json(stablePayload({ ...proposal, content, ...(runAttribution ? { run_attribution: runAttribution } : { work_run_id: runId, attempt_id: attemptId, generation, session_id: sessionId }) })));
            if (options.idempotencyKey) {
                const prior = (await this.sql.get("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?", options.idempotencyKey)) as any;
                if (prior) {
                    if (prior.request_hash !== requestHash || prior.operation !== (options.operation ?? "proposal.submit") || prior.principal !== (options.principal ?? "core") || prior.engagement_id !== proposal.engagement_id)
                        throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
                    return JSON.parse(prior.result) as Proposal;
                }
            }
            if ((await this.sql.get("SELECT 1 FROM proposals WHERE id=? UNION SELECT 1 FROM object_refs WHERE id=? LIMIT 1", id, id)))
                throw new ContractValidationError("conflict", "proposal request identity is already in use");
            validateProposalCandidate(proposal.subject_type, content);
            (await this.validateProposalTarget(proposal));
            validateAuthorityReferences(content, (await this.referenceIndex(content, proposal.engagement_id)), proposal.engagement_id);
            const hasRunAttribution = runId !== undefined || generation !== undefined || attemptId !== undefined;
            let staleAttemptReason: string | undefined;
            if (hasRunAttribution) {
                if (!runId || !Number.isInteger(generation) || !attemptId) {
                    staleAttemptReason = "run-scoped proposal requires WorkRun, Attempt, and generation attribution";
                }
                else {
                    const run = (await this.sql.get("SELECT * FROM work_runs WHERE run_id=?", runId)) as any;
                    const runBody = run ? JSON.parse(run.body) as Record<string, unknown> : undefined;
                    const actorMatches = options.principalRole === "host"
                        ? run?.owner_host === options.principal
                        : options.principalRole === "model"
                            ? run?.owner_agent === options.principal
                            : !options.principalRole && (run?.owner_host === options.principal || run?.owner_agent === options.principal);
                    const attempt = run
                        ? await this.sql.get<{ attempt_id: string; engagement_id: string; generation: number; status: string; owner_host: string; owner_agent: string; lease_expires_at: string; body: string }>("SELECT attempt_id,engagement_id,generation,status,owner_host,owner_agent,lease_expires_at,body FROM attempts WHERE attempt_id=? AND run_id=?", attemptId, runId)
                        : undefined;
                    const attemptBody = attempt?.body ? JSON.parse(attempt.body) as Record<string, unknown> : undefined;
                    const activeStatuses = ["claimed", "running", "checkpointed", "blocked"];
                    const now = await this.sql.now();
                    if (!run || run.engagement_id !== proposal.engagement_id || Number(run.generation) !== generation || run.lease_expires_at <= now || !activeStatuses.includes(String(run.status)) || runBody?.attempt_ref !== attemptId || !actorMatches || !attempt || attempt.engagement_id !== proposal.engagement_id || Number(attempt.generation) !== generation || !activeStatuses.includes(attempt.status) || attempt.owner_host !== run.owner_host || attempt.owner_agent !== run.owner_agent || attempt.lease_expires_at !== run.lease_expires_at || attempt.lease_expires_at <= now || attemptBody?.task_session_ref !== runBody?.task_session_ref) {
                        staleAttemptReason = "proposal is not bound to the active WorkRun Attempt and owner";
                    }
                }
            }
            const now = (await this.sql.now());
            if (staleAttemptReason) {
                const quarantined: Proposal = { ...result, status: "rejected" };
                (await this.sql.run("INSERT INTO proposals(id,engagement_id,subject_type,expected_version,target_id,client_request_id,status,content_hash,body,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, proposal.engagement_id, proposal.subject_type, proposal.expected_version, result.target_id ?? null, proposal.client_request_id ?? null, quarantined.status, content_hash, json(content), now));
                (await this.nextEvent("proposal.stale_attempt_quarantine", { input_hash: content_hash, work_run_id: runId, attempt_ref: attemptId, generation, session_id: sessionId, actor_id: options.principal, reason: staleAttemptReason }, id));
                if (options.idempotencyKey)
                    (await this.sql.run("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", options.idempotencyKey, options.operation ?? "proposal.submit", options.principal ?? "core", proposal.engagement_id, requestHash, json(quarantined)));
                return quarantined;
            }
            (await this.sql.run("INSERT INTO proposals(id,engagement_id,subject_type,expected_version,target_id,client_request_id,status,content_hash,body,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, proposal.engagement_id, proposal.subject_type, proposal.expected_version, result.target_id ?? null, proposal.client_request_id ?? null, result.status, content_hash, json(content), now));
            (await this.nextEvent("proposal.submit", { input_hash: content_hash, subject_type: proposal.subject_type, run_attribution: runAttribution, actor_id: options.principal ?? "core", idempotency_key: options.idempotencyKey }, id));
            if (options.idempotencyKey)
                (await this.sql.run("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", options.idempotencyKey, options.operation ?? "proposal.submit", options.principal ?? "core", proposal.engagement_id, requestHash, json(result)));
            return result;
        }));
    }
    async proposals(engagementId: string): Promise<Awaited<Proposal[]>> { return ((await this.sql.all("SELECT * FROM proposals WHERE engagement_id=? ORDER BY created_at,id", engagementId)) as any[]).map((row) => this.proposalFromRow(row)); }
    async proposalsPage(input: {
        engagement_id: string;
        principal_id?: string;
        cursor_key_root?: string;
        cursor?: string;
        page_size?: number;
    }): Promise<Awaited<{
        proposals: Proposal[];
        next_cursor?: string;
        read_seq: number;
    }>> {
        const limit = input.page_size ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            throw new ContractValidationError("validation_error", "page_size must be an integer between 1 and 1000");
        return (await this.readTransaction(async () => {
            const current = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as {
                seq: number;
            }).seq);
            const cursor = input.cursor ? decodeListCursor(input.cursor, this.listCursorKey(false, input.cursor_key_root)) : undefined;
            const readSeq = cursor ? Number(cursor.read_seq) : current;
            if (!Number.isSafeInteger(readSeq) || readSeq < 0 || readSeq > current)
                throw new InvalidCursorError("invalid proposal page read sequence");
            if (cursor && (cursor.list !== "proposals" || cursor.principal_id !== (input.principal_id ?? "local") || cursor.engagement_id !== input.engagement_id || cursor.page_size !== limit))
                throw new InvalidCursorError("proposal page cursor binding mismatch");
            const afterId = typeof cursor?.after_id === "string" ? cursor.after_id : "";
            const rows = (await this.sql.all("SELECT pv.body FROM proposal_versions pv WHERE pv.engagement_id=? AND pv.commit_seq<=? AND pv.id>? AND NOT EXISTS(SELECT 1 FROM proposal_versions newer WHERE newer.id=pv.id AND newer.commit_seq<=? AND newer.commit_seq>pv.commit_seq) ORDER BY pv.id LIMIT ?", input.engagement_id, readSeq, afterId, readSeq, limit + 1)) as Array<{
                body: string;
            }>;
            const selected = rows.slice(0, limit).map((row) => JSON.parse(row.body) as Proposal);
            const last = rows.length > limit ? selected.at(-1) : undefined;
            return { proposals: selected, next_cursor: last ? encodeListCursor({ v: 1, list: "proposals", principal_id: input.principal_id ?? "local", engagement_id: input.engagement_id, page_size: limit, read_seq: readSeq, after_id: last.id }, this.listCursorKey(true, input.cursor_key_root)) : undefined, read_seq: readSeq };
        }));
    }
    async admitProposal(id: string, policyDigest: string, options: {
        expectedBaseVersion?: number;
        validate?: (content: ProposalCandidate) => string | undefined;
    } & GovernanceWriteOptions = {}): Promise<Awaited<AdmissionResult>> {
        return (await this.transaction(async () => {
            const row = (await this.sql.get("SELECT * FROM proposals WHERE id=?", id)) as any;
            if (!row)
                throw new ContractValidationError("conflict", "proposal not found");
            const proposal = this.proposalFromRow(row);
            const requestHash = hash(json(stablePayload({ proposal_id: id, policy_digest: policyDigest, expected_base_version: options.expectedBaseVersion })));
            if (options.idempotencyKey) {
                const prior = (await this.sql.get("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?", options.idempotencyKey)) as any;
                if (prior) {
                    if (prior.request_hash !== requestHash || prior.operation !== (options.operation ?? "admission.evaluate") || prior.principal !== (options.principal ?? "core") || prior.engagement_id !== proposal.engagement_id)
                        throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
                    return JSON.parse(prior.result) as AdmissionResult;
                }
            }
            const finalize = async (result: AdmissionResult): Promise<Awaited<AdmissionResult>> => {
                const normalized = JSON.parse(json(result)) as AdmissionResult;
                if (options.idempotencyKey)
                    (await this.sql.run("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", options.idempotencyKey, options.operation ?? "admission.evaluate", options.principal ?? "core", proposal.engagement_id, requestHash, json(normalized)));
                return normalized;
            };
            if (row.status !== "pending")
                return finalize((await this.rejectProposal(proposal, "proposal is not pending")));
            if (!policyDigest)
                return finalize((await this.rejectProposal(proposal, "policy digest is required")));
            const current = proposal.target_id ? (await this.get(proposal.target_id)) : undefined;
            const currentVersion = current?.version ?? 0;
            if (options.expectedBaseVersion !== undefined && options.expectedBaseVersion !== currentVersion)
                return finalize((await this.rejectProposal(proposal, "base version mismatch")));
            if (proposal.expected_version !== currentVersion)
                return finalize((await this.rejectProposal(proposal, "proposal base version is stale")));
            const candidate: ProposalCandidate = { ...proposal.content, provenance: { host_id: proposal.content.provenance?.host_id ?? "taric-core", ...proposal.content.provenance, producer_id: proposal.content.provenance?.producer_id ?? "taric-core", source_kind: proposal.content.provenance?.source_kind ?? "host" } };
            try {
                validateProposalEnvelope(proposalEnvelope(proposal));
                (await this.validateProposalTarget(proposal));
                validateAuthorityReferences(candidate, (await this.referenceIndex(candidate, proposal.engagement_id)), proposal.engagement_id);
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : "deterministic admission check failed";
                return finalize((await this.rejectProposal(proposal, reason)));
            }
            const reason = options.validate?.(candidate);
            if (reason)
                return finalize((await this.rejectProposal(proposal, reason)));
            // Freeze the exact cited records while the admission write transaction
            // still protects the same authority state. The review profile reads only
            // this copy, never replacement evidence from the live records table.
            const reviewEvidence = proposal.subject_type === "finding"
                ? await this.captureReviewEvidenceSnapshot(proposal)
                : undefined;
            const record = (await this.commit({ ...proposal.content, id: proposal.target_id ?? uuidv7(), policy_digest: policyDigest, policy_version: "taric-l1-structural-v1", trust_phase: "machine_approved", provenance: { ...candidate.provenance, producer_id: options.principal ?? "taric-core", source_kind: "host" } } as CanonicalRecord, "L1", undefined, undefined, false, currentVersion));
            (await this.sql.run("UPDATE proposals SET status='admitted',canonical_id=?,canonical_version=? WHERE id=?", record.id, record.version!, id));
            const admissionEvent = await this.nextEvent("proposal.admit", { input_hash: proposal.content_hash, policy_digest: policyDigest, policy_version: "taric-l1-structural-v1", trust_phase: "machine_approved", actor_id: options.principal ?? "core", idempotency_key: options.idempotencyKey, canonical_id: record.id }, id);
            if (reviewEvidence) {
                await this.sql.run(
                    "INSERT INTO admission_review_packs(proposal_id,engagement_id,proposal_hash,canonical_id,policy_digest,evidence_snapshot_hash,admission_seq,evidence_snapshot) VALUES(?,?,?,?,?,?,?,?)",
                    id, proposal.engagement_id, proposal.content_hash, record.id, policyDigest, reviewEvidence.hash, admissionEvent.commit_seq, json(reviewEvidence.evidence),
                );
            }
            return finalize({ ok: true, proposal: { ...proposal, status: "admitted", canonical_id: record.id, canonical_version: record.version }, record, trust_phase: "machine_approved", policy_digest: policyDigest, policy_version: "taric-l1-structural-v1", remaining_l2_requirements: proposal.subject_type === "finding" ? ["fixed_proposal_evidence_snapshot", "evidence", "freshness", "independent_review", "risk_policy"] : [] });
        }));
    }
    private async rejectProposal(proposal: Proposal, reason: string): Promise<Awaited<AdmissionResult>> {
        (await this.sql.run("UPDATE proposals SET status='rejected' WHERE id=?", proposal.id));
        (await this.nextEvent("proposal.reject", { input_hash: proposal.content_hash, reason, actor_id: "core" }, proposal.id));
        return { ok: false, reason, proposal: { ...proposal, status: "rejected" } };
    }
    async claimWorkRun(input: {
        run_id?: string;
        work_item_id: string;
        engagement_id: string;
        host_id: string;
        agent_id: string;
        ttl_ms?: number;
        task_session_ref?: string;
    }): Promise<Awaited<Record<string, unknown>>> {
        if (input.ttl_ms !== undefined && (!Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1))
            throw new ContractValidationError("validation_error", "lease ttl must be a positive integer");
        const runId = input.run_id ?? uuidv7();
        return (await this.transaction(async () => {
            const now = new Date(await this.sql.now());
            const expiry = new Date(now.getTime() + (input.ttl_ms ?? 60000)).toISOString();
            const prior = (await this.sql.get("SELECT generation,status,lease_expires_at,engagement_id,work_item_id,body FROM work_runs WHERE run_id=?", runId)) as any;
            if (prior && prior.engagement_id !== input.engagement_id)
                throw new ContractValidationError("authorization_error", "work run belongs to another engagement");
            if (prior && prior.work_item_id !== input.work_item_id)
                throw new ContractValidationError("conflict", "work item cannot change for an existing run");
            const workItemRow = (await this.sql.get("SELECT engagement_id,version,body FROM records WHERE id=? AND kind='work_item'", input.work_item_id)) as {
                engagement_id?: string;
                version?: number;
                body?: string;
            } | undefined;
            if (!workItemRow || workItemRow.engagement_id !== input.engagement_id)
                throw new ContractValidationError("validation_error", "work_item_id must reference a WorkItem in the engagement");
            const item = JSON.parse(workItemRow.body!) as Record<string, unknown>;
            if (["completed", "failed", "cancelled", "lost", "stale", "retracted", "superseded", "archived", "expired"].includes(String(item.status)))
                throw new ContractValidationError("conflict", "terminal or recalled WorkItem cannot be claimed");
            const active = (await this.sql.get("SELECT run_id FROM work_runs WHERE work_item_id=? AND run_id<>? AND lease_expires_at>? AND status NOT IN ('completed','failed','cancelled','lost') LIMIT 1", input.work_item_id, runId, now.toISOString())) as {
                run_id?: string;
            } | undefined;
            if (active)
                throw new ContractValidationError("conflict", "WorkItem already has an active leased WorkRun");
            if (prior?.lease_expires_at && prior.lease_expires_at <= now.toISOString()) {
                (await this.sql.run("UPDATE attempts SET status='lost',updated_at=? WHERE run_id=? AND generation=? AND status NOT IN ('completed','failed','cancelled','lost')", now.toISOString(), runId, Number(prior.generation)));
                const oldAttempt = (await this.sql.get("SELECT attempt_id,body FROM attempts WHERE run_id=? AND generation=?", runId, Number(prior.generation))) as {
                    attempt_id?: string;
                    body?: string;
                } | undefined;
                if (oldAttempt?.body) {
                    const body = JSON.parse(oldAttempt.body) as Record<string, unknown>;
                    body.status = "lost";
                    body.ended_at = now.toISOString();
                    (await this.sql.run("UPDATE attempts SET body=? WHERE attempt_id=?", json(body), oldAttempt.attempt_id ?? ""));
                }
                (await this.sealExecutionSidecars(runId, Number(prior.generation), "attempt_lost"));
            }
            if (prior && ["completed", "failed", "cancelled"].includes(String(prior.status)))
                throw new ContractValidationError("conflict", "terminal work run cannot be reclaimed");
            if (prior && prior.lease_expires_at > now.toISOString() && !["lost", "completed", "failed", "cancelled"].includes(String(prior.status)))
                throw new ContractValidationError("conflict", "work run lease is still active");
            const generation = Number(prior?.generation ?? 0) + 1;
            const previousAttempt = prior ? (await this.sql.get("SELECT attempt_id FROM attempts WHERE run_id=? AND generation=?", runId, Number(prior.generation))) as {
                attempt_id?: string;
            } | undefined : undefined;
            const previousAttemptRef = previousAttempt?.attempt_id;
            const owner = { host_id: input.host_id, agent_id: input.agent_id };
            const priorBody = prior?.body ? JSON.parse(prior.body) as Record<string, unknown> : {};
            const taskSessionRef = input.task_session_ref ?? (typeof priorBody.task_session_ref === "string" ? priorBody.task_session_ref : undefined);
            if (taskSessionRef && !(await this.sql.get("SELECT 1 FROM artifact_sessions WHERE engagement_id=? AND session_id=?", input.engagement_id, taskSessionRef)))
                throw new ContractValidationError("authorization_error", "WorkRun task session is not registered in this Engagement");
            const body: Record<string, unknown> = { run_id: runId, work_item_id: input.work_item_id, engagement_id: input.engagement_id, status: "claimed", owner, generation, lease_expires_at: expiry, heartbeat_at: now.toISOString(), read_seq: Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as any).seq), work_item_version: Number(workItemRow.version), target_version: Number(item.target_version ?? workItemRow.version) };
            if (taskSessionRef)
                body.task_session_ref = taskSessionRef;
            const engagementBody = (await this.sql.get("SELECT body FROM records WHERE id=? AND kind='engagement'", input.engagement_id)) as {
                body?: string;
            } | undefined;
            const engagement = engagementBody?.body ? JSON.parse(engagementBody.body) as Record<string, unknown> : {};
            const scopeRef = typeof item.scope_ref === "string" ? item.scope_ref : typeof engagement.scope_ref === "string" ? engagement.scope_ref : undefined;
            const scopeVersion = scopeRef ? Number(((await this.sql.get("SELECT version FROM records WHERE id=? AND kind='scope' AND engagement_id=?", scopeRef, input.engagement_id)) as {
                version?: number;
            } | undefined)?.version ?? -1) : 0;
            if (scopeVersion < 0)
                throw new ContractValidationError("validation_error", "WorkItem scope must reference a Scope in the engagement");
            body.scope_ref = scopeRef;
            body.scope_version = scopeVersion;
            const attemptId = uuidv7();
            const attempt = { attempt_id: attemptId, run_id: runId, work_item_id: input.work_item_id, engagement_id: input.engagement_id, status: "claimed", generation, owner, lease_expires_at: expiry, heartbeat_at: now.toISOString(), ...(taskSessionRef ? { task_session_ref: taskSessionRef } : {}) };
            const provenance = { host_id: input.host_id, producer_id: input.agent_id, source_kind: "host" };
            const recordBase = { schema_version: SCHEMA_VERSION, engagement_id: input.engagement_id, created_at: now.toISOString(), provenance };
            validateContract("workRun", { ...recordBase, id: runId, kind: "work_run", work_item_ref: input.work_item_id, status: "claimed", generation, attempt_ref: attemptId, owner: body.owner, lease_expires_at: expiry, heartbeat_at: now.toISOString(), read_seq: body.read_seq });
            validateContract("attempt", { ...recordBase, id: attemptId, kind: "attempt", work_item_ref: input.work_item_id, work_run_ref: runId, status: "claimed", generation, owner: body.owner, lease_expires_at: expiry, heartbeat_at: now.toISOString(), started_at: now.toISOString() });
            (await this.sql.run("INSERT INTO work_runs(run_id,work_item_id,engagement_id,status,owner_host,owner_agent,generation,lease_expires_at,heartbeat_at,read_seq,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,owner_host=excluded.owner_host,owner_agent=excluded.owner_agent,generation=excluded.generation,lease_expires_at=excluded.lease_expires_at,heartbeat_at=excluded.heartbeat_at,read_seq=excluded.read_seq,body=excluded.body,updated_at=excluded.updated_at", runId, input.work_item_id, input.engagement_id, "claimed", input.host_id, input.agent_id, generation, expiry, now.toISOString(), body.read_seq as number, json(body), now.toISOString(), now.toISOString()));
            (await this.sql.run("INSERT INTO attempts(attempt_id,run_id,work_item_id,engagement_id,status,generation,owner_host,owner_agent,lease_expires_at,heartbeat_at,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", attemptId, runId, input.work_item_id, input.engagement_id, "claimed", generation, input.host_id, input.agent_id, expiry, now.toISOString(), json(attempt), now.toISOString(), now.toISOString()));
            body.attempt_ref = attemptId;
            (await this.sql.run("UPDATE work_runs SET body=? WHERE run_id=?", json(body), runId));
            (await this.sql.run("INSERT INTO object_refs(id,engagement_id,kind) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET engagement_id=excluded.engagement_id,kind=excluded.kind", runId, input.engagement_id, "work_run"));
            (await this.sql.run("INSERT INTO object_refs(id,engagement_id,kind) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET engagement_id=excluded.engagement_id,kind=excluded.kind", attemptId, input.engagement_id, "attempt"));
            (await this.nextEvent("work_run.claim", { generation, host_id: input.host_id, agent_id: input.agent_id, attempt_id: attemptId, previous_attempt_ref: previousAttemptRef }, runId));
            return body;
        }));
    }
    async renewWorkRun(runId: string, generation: number, hostId: string, ttlMs = 60000): Promise<Awaited<Record<string, unknown>>> {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
            throw new ContractValidationError("validation_error", "lease ttl must be a positive integer");
        return (await this.transaction(async () => {
            const row = (await this.sql.get("SELECT * FROM work_runs WHERE run_id=?", runId)) as any;
            const now = new Date(await this.sql.now());
            if (!row || row.owner_host !== hostId || Number(row.generation) !== generation || !row.lease_expires_at || row.lease_expires_at <= now.toISOString() || ["completed", "failed", "cancelled", "lost"].includes(String(row.status)))
                throw new ContractValidationError("stale_version", "work run lease is expired or fenced");
            const expiry = new Date(now.getTime() + ttlMs).toISOString();
            const updated = (await this.sql.run("UPDATE work_runs SET lease_expires_at=?,heartbeat_at=?,updated_at=? WHERE run_id=? AND generation=? AND owner_host=? AND lease_expires_at>? AND status NOT IN ('completed','failed','cancelled','lost')", expiry, now.toISOString(), now.toISOString(), runId, generation, hostId, now.toISOString()));
            if (Number(updated.changes) !== 1)
                throw new ContractValidationError("stale_version", "work run lease changed before renewal");
            const attemptRow = (await this.sql.get("SELECT attempt_id,body FROM attempts WHERE run_id=? AND generation=? AND owner_host=? AND status NOT IN ('completed','failed','cancelled','lost')", runId, generation, hostId)) as {
                attempt_id?: string;
                body?: string;
            } | undefined;
            if (!attemptRow?.attempt_id || !attemptRow.body)
                throw new ContractValidationError("stale_version", "active Attempt is unavailable for lease renewal");
            const attempt = JSON.parse(attemptRow.body) as Record<string, unknown>;
            attempt.lease_expires_at = expiry;
            attempt.heartbeat_at = now.toISOString();
            (await this.sql.run("UPDATE attempts SET lease_expires_at=?,heartbeat_at=?,body=?,updated_at=? WHERE attempt_id=? AND run_id=? AND generation=? AND owner_host=?", expiry, now.toISOString(), json(attempt), now.toISOString(), attemptRow.attempt_id, runId, generation, hostId));
            const body = { ...JSON.parse(row.body), lease_expires_at: expiry, heartbeat_at: now.toISOString() };
            (await this.sql.run("UPDATE work_runs SET body=? WHERE run_id=?", json(body), runId));
            (await this.nextEvent("work_run.renew", { generation, host_id: hostId, lease_expires_at: expiry }, runId));
            return body;
        }));
    }
    async reclaimWorkRun(runId: string, hostId: string, agentId: string, ttlMs = 60000): Promise<Awaited<Record<string, unknown>>> {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
            throw new ContractValidationError("validation_error", "lease ttl must be a positive integer");
        return (await this.transaction(async () => {
            const row = (await this.sql.get("SELECT * FROM work_runs WHERE run_id=?", runId)) as any;
            if (!row)
                throw new ContractValidationError("conflict", "work run not found");
            if (row.lease_expires_at > (await this.sql.now()))
                throw new ContractValidationError("conflict", "work run lease is still active");
            const previousGeneration = Number(row.generation);
            const reclaimed = (await this.claimWorkRun({ run_id: runId, work_item_id: row.work_item_id, engagement_id: row.engagement_id, host_id: hostId, agent_id: agentId, ttl_ms: ttlMs }));
            (await this.sealExecutionSidecars(runId, previousGeneration));
            return reclaimed;
        }));
    }
    async commitCheckpoint(runId: string, generation: number, hostId: string, checkpoint: Record<string, unknown>): Promise<Awaited<Record<string, unknown>>> {
        return (await this.transaction(async () => {
            const row = (await this.sql.get("SELECT * FROM work_runs WHERE run_id=?", runId)) as any;
            if (!row || row.owner_host !== hostId || Number(row.generation) !== generation || row.lease_expires_at <= (await this.sql.now()) || ["completed", "failed", "cancelled", "lost"].includes(String(row.status)))
                throw new ContractValidationError("stale_version", "invalid or expired work run lease");
            const checkpointId = uuidv7();
            const runBody = JSON.parse(row.body) as Record<string, unknown>;
            if (typeof runBody.attempt_ref !== "string")
                throw new ContractValidationError("stale_version", "active Attempt reference is missing");
            const activeAttempt = (await this.sql.get("SELECT * FROM attempts WHERE attempt_id=? AND run_id=? AND generation=?", runBody.attempt_ref, runId, generation)) as any;
            if (!activeAttempt || activeAttempt.owner_host !== row.owner_host || activeAttempt.owner_agent !== row.owner_agent || activeAttempt.lease_expires_at !== row.lease_expires_at || !attemptTransitions[String(activeAttempt.status)]?.includes("checkpointed"))
                throw new ContractValidationError("stale_version", "active Attempt is missing, expired, or fenced");
            const workItemRow = (await this.sql.get("SELECT engagement_id,version,body FROM records WHERE id=? AND kind='work_item'", row.work_item_id)) as {
                engagement_id?: string;
                version?: number;
                body?: string;
            } | undefined;
            if (!workItemRow || workItemRow.engagement_id !== row.engagement_id)
                throw new ContractValidationError("validation_error", "active WorkItem is unavailable");
            const workItem = JSON.parse(workItemRow.body!) as Record<string, unknown>;
            if (["completed", "failed", "cancelled", "lost", "stale", "retracted", "superseded", "archived", "expired"].includes(String(workItem.status)))
                throw new ContractValidationError("conflict", "active WorkItem is terminal or recalled");
            const engagementRow = (await this.sql.get("SELECT body FROM records WHERE id=? AND kind='engagement'", row.engagement_id)) as {
                body?: string;
            } | undefined;
            const engagement = engagementRow?.body ? JSON.parse(engagementRow.body) as Record<string, unknown> : {};
            const expectedScope = typeof workItem.scope_ref === "string" ? workItem.scope_ref : typeof engagement.scope_ref === "string" ? engagement.scope_ref : undefined;
            const currentSeq = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as any).seq);
            const required = ["work_item_ref", "work_run_ref", "attempt_ref", "generation", "target_version", "work_item_version", "scope_version", "owner", "lease_expires_at", "source_read_seq", "completed_steps", "next_steps", "observation_refs", "evidence_refs", "negative_results", "unresolved_work", "host_decision_refs", "external_action_state", "budget", "draft_refs", "handoff_refs", "action_refs", "tool_result_refs", "context_manifest"];
            if (required.some((field) => checkpoint[field] === undefined))
                throw new ContractValidationError("validation_error", "checkpoint is missing required fields; empty outcomes must be explicit");
            const containsHiddenReasoning = (value: unknown): boolean => {
                if (Array.isArray(value))
                    return value.some(containsHiddenReasoning);
                if (!value || typeof value !== "object")
                    return false;
                return Object.entries(value as Record<string, unknown>).some(([key, item]) => checkpointForbiddenFields.has(key) || containsHiddenReasoning(item));
            };
            if (containsHiddenReasoning(checkpoint))
                throw new ContractValidationError("validation_error", "checkpoint cannot contain hidden reasoning");
            const owner = checkpoint.owner as Record<string, unknown>;
            const contextManifest = checkpoint.context_manifest as Record<string, unknown>;
            if (checkpoint.work_item_ref !== row.work_item_id || checkpoint.work_run_ref !== runId || checkpoint.attempt_ref !== runBody.attempt_ref || Number(checkpoint.generation) !== generation)
                throw new ContractValidationError("conflict", "checkpoint must reference the active WorkItem, WorkRun, Attempt, and generation");
            if (Number(checkpoint.target_version) !== Number(workItem.target_version ?? workItemRow.version))
                throw new ContractValidationError("stale_version", "checkpoint target version is stale");
            if (Number(checkpoint.work_item_version) !== Number(workItemRow.version))
                throw new ContractValidationError("stale_version", "checkpoint WorkItem version is stale");
            if (expectedScope && checkpoint.scope_ref !== expectedScope)
                throw new ContractValidationError("stale_version", "checkpoint scope does not match the current WorkItem scope");
            if (!expectedScope && checkpoint.scope_ref !== undefined)
                throw new ContractValidationError("validation_error", "checkpoint declares a scope not present on the current WorkItem or Engagement");
            const currentScopeVersion = expectedScope ? Number(((await this.sql.get("SELECT version FROM records WHERE id=? AND kind='scope' AND engagement_id=?", expectedScope, row.engagement_id)) as {
                version?: number;
            } | undefined)?.version ?? -1) : 0;
            if (currentScopeVersion < 0 || Number(checkpoint.scope_version) !== currentScopeVersion)
                throw new ContractValidationError("stale_version", "checkpoint Scope version is stale");
            if (owner?.host_id !== row.owner_host || owner?.agent_id !== row.owner_agent || checkpoint.lease_expires_at !== row.lease_expires_at)
                throw new ContractValidationError("authorization_error", "checkpoint owner and lease must match the active host attestation");
            if (Number(checkpoint.source_read_seq) > currentSeq || Number(contextManifest.read_seq) !== Number(checkpoint.source_read_seq) || typeof contextManifest.context_snapshot_id !== "string" || typeof contextManifest.builder_version !== "string")
                throw new ContractValidationError("validation_error", "checkpoint requires a verifiable fixed context snapshot manifest");
            const saved: Record<string, unknown> = { ...checkpoint, checkpoint_id: checkpointId, run_id: runId, base_read_seq: row.read_seq };
            const checkpointRecord: Record<string, unknown> = {
                ...checkpoint,
                id: checkpointId,
                schema_version: SCHEMA_VERSION,
                engagement_id: row.engagement_id,
                created_at: (await this.sql.now()),
                provenance: { host_id: hostId, producer_id: String(row.owner_agent), source_kind: "host" },
                kind: "checkpoint",
            };
            validateContract("checkpoint", checkpointRecord);
            const referenceIndex = (await this.referenceIndex(checkpointRecord, row.engagement_id));
            // Use the shared cross-reference guard first, then tighten fields whose
            // generic reference contract intentionally permits more than a checkpoint.
            validateAuthorityReferences(checkpointRecord, referenceIndex, row.engagement_id);
            const exactKinds: Array<[
                string,
                string
            ]> = [
                ["work_item_ref", "work_item"],
                ["work_run_ref", "work_run"],
                ["attempt_ref", "attempt"],
                ["scope_ref", "scope"],
            ];
            for (const [field, expectedKind] of exactKinds) {
                const ref = checkpointRecord[field];
                if (ref === undefined)
                    continue;
                if (typeof ref !== "string" || referenceIndex.kind.get(ref) !== expectedKind) {
                    throw new ContractValidationError("validation_error", `checkpoint ${field} must reference a ${expectedKind}`);
                }
            }
            for (const ref of checkpointRecord.action_refs as unknown[]) {
                if (typeof ref !== "string" || referenceIndex.kind.get(ref) !== "action_intent") {
                    throw new ContractValidationError("validation_error", `checkpoint action_refs must reference action_intent records`);
                }
            }
            const currentActions = (await this.sql.all("SELECT action_id,body FROM action_intents WHERE run_id=? AND generation=?", runId, generation)) as Array<{
                action_id: string;
                body: string;
            }>;
            const actions = new Map(currentActions.map((entry) => [entry.action_id, JSON.parse(entry.body) as Record<string, unknown>]));
            for (const ref of checkpoint.action_refs as string[])
                if (!actions.has(ref))
                    throw new ContractValidationError("validation_error", `checkpoint action reference is not current: ${ref}`);
            const hostDecisionRefs = currentActions.flatMap((entry) => { const body = JSON.parse(entry.body) as Record<string, unknown>; return typeof body.host_decision_ref === "string" ? [body.host_decision_ref] : []; });
            for (const ref of checkpoint.host_decision_refs as string[])
                if (!hostDecisionRefs.includes(ref))
                    throw new ContractValidationError("validation_error", `checkpoint host decision reference cannot be verified: ${ref}`);
            const toolResultRefs = currentActions.flatMap((entry) => { const body = JSON.parse(entry.body) as Record<string, unknown>; return typeof body.result_ref === "string" ? [body.result_ref] : []; });
            for (const ref of checkpoint.tool_result_refs as string[])
                if (!toolResultRefs.includes(ref))
                    throw new ContractValidationError("validation_error", `checkpoint tool result reference cannot be verified: ${ref}`);
            (await this.sql.run("INSERT INTO checkpoints(checkpoint_id,run_id,generation,body,created_at) VALUES(?,?,?,?,?)", checkpointId, runId, generation, json(saved), (await this.sql.now())));
            const body = { ...JSON.parse(row.body), checkpoint_id: checkpointId, status: "checkpointed" };
            (await this.sql.run("UPDATE work_runs SET status='checkpointed',checkpoint_id=?,body=?,updated_at=? WHERE run_id=?", checkpointId, json(body), (await this.sql.now()), runId));
            const attempt = JSON.parse(activeAttempt.body) as Record<string, unknown>;
            attempt.status = "checkpointed";
            (await this.sql.run("UPDATE attempts SET status='checkpointed',body=?,updated_at=? WHERE attempt_id=? AND generation=?", json(attempt), (await this.sql.now()), activeAttempt.attempt_id, generation));
            const taskSessionRef = typeof runBody.task_session_ref === "string" ? runBody.task_session_ref : undefined;
            (await this.writeExecutionSidecar({ engagement_id: row.engagement_id, session_id: taskSessionRef, work_run_id: runId, attempt_id: activeAttempt.attempt_id, generation, kind: "checkpoint", reference_id: checkpointId, metadata: { checkpoint_id: checkpointId, artifact_refs: Array.isArray(checkpoint.artifact_refs) ? checkpoint.artifact_refs : [], action_refs: Array.isArray(checkpoint.action_refs) ? checkpoint.action_refs : [], source_read_seq: checkpoint.source_read_seq, status: "checkpointed" } }));
            (await this.nextEvent("work_run.checkpoint", { checkpoint_id: checkpointId, generation }, runId));
            return saved;
        }));
    }
    async reconcileAction(runId: string, generation: number, resultRef: string, status: "executed" | "failed", actionId: string, hostId: string): Promise<Awaited<Record<string, unknown>>> {
        return (await this.transaction(async () => {
            const run = (await this.sql.get("SELECT owner_host,generation,lease_expires_at,status FROM work_runs WHERE run_id=?", runId)) as {
                owner_host?: string;
                generation?: number;
                lease_expires_at?: string;
                status?: string;
            } | undefined;
            if (!run || Number(run.generation) !== generation || !run.lease_expires_at || run.lease_expires_at <= (await this.sql.now()) || ["completed", "failed", "cancelled", "lost"].includes(String(run.status)))
                throw new ContractValidationError("stale_version", "action reconciliation is fenced by an expired or stale run");
            if (run.owner_host !== hostId)
                throw new ContractValidationError("authorization_error", "action reconciliation host is not the current owner");
            const action = (await this.sql.get("SELECT body FROM action_intents WHERE action_id=? AND run_id=? AND generation=? AND status='unknown'", actionId, runId, generation)) as {
                body?: string;
            } | undefined;
            if (!action)
                throw new ContractValidationError("conflict", "no unknown action requires reconciliation");
            const body = JSON.parse(action.body!);
            return (await this.recordActionIntent({ ...body, generation, run_id: runId, action_id: actionId, status, result_ref: resultRef, host_decision_ref: body.host_decision_ref, mode: body.mode, host_id: hostId }, true));
        }));
    }
    async consumeOutbox(limit = 100): Promise<Awaited<Array<Record<string, unknown>>>> {
        return (await this.transaction(async () => {
            (await this.assertAuthorityWritable());
            const rows = (await this.sql.all("SELECT id,commit_seq,status FROM outbox WHERE status='pending' ORDER BY id LIMIT ?", limit)) as Array<{
                id: number;
                commit_seq: number;
                status: string;
            }>;
            for (const row of rows) {
                (await this.sql.run("UPDATE outbox SET status='applied' WHERE id=? AND status='pending'", row.id));
                (await this.sql.run("UPDATE operation_markers SET status=CASE WHEN status='pending' THEN 'applied' ELSE status END,updated_at=? WHERE commit_seq=?", (await this.sql.now()), row.commit_seq));
                (await this.sql.run("UPDATE operation_markers SET status='indexed',updated_at=? WHERE commit_seq=? AND status='applied'", (await this.sql.now()), row.commit_seq));
            }
            return rows.map((row) => ({ ...row, status: "applied" }));
        }));
    }
    async markOperationFailed(operationId: string, error: string, retryOwner = "operator"): Promise<Awaited<OperationMarker>> {
        if (!operationId || !error)
            throw new ContractValidationError("validation_error", "operation failure requires an operation id and error");
        return (await this.transaction(async () => {
            (await this.assertAuthorityWritable());
            const result = (await this.sql.run("UPDATE operation_markers SET status='failed',error=?,retry_owner=?,updated_at=? WHERE operation_id=?", error.slice(0, 1024), retryOwner, (await this.sql.now()), operationId));
            if (Number(result.changes) !== 1)
                throw new ContractValidationError("conflict", `operation marker not found: ${operationId}`);
            return (await this.operationMarkers()).find((marker) => marker.operation_id === operationId)!;
        }));
    }
    async replayDerived(): Promise<Awaited<{
        action: "replay";
        recovered: number;
        applied: number;
        event_id: string;
        commit_seq: number;
        doctor: DoctorReport;
    }>> {
        return (await this.transaction(async () => {
            (await this.assertAuthorityWritable());
            const drift = (await this.derivedDrift());
            if (drift.errors.length > 0)
                throw new ContractValidationError("conflict", "derived view drift requires explicit rebuild before replay", drift.errors);
            const now = (await this.sql.now());
            const failed = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM operation_markers WHERE status='failed'")) as {
                count: number;
            }).count);
            const pending = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM operation_markers WHERE status='pending'")) as {
                count: number;
            }).count);
            (await this.sql.run("UPDATE outbox SET status='applied' WHERE status='pending'"));
            (await this.sql.run("UPDATE operation_markers SET status=CASE WHEN status='failed' THEN 'recovered' WHEN status='pending' THEN 'applied' ELSE status END,error=NULL,retry_owner='operator',updated_at=? WHERE status IN ('failed','pending')", now));
            const event = (await this.nextEvent("operation.recovered", { actor_id: "operator", recovered_markers: failed, applied_markers: pending }));
            (await this.sql.run("UPDATE outbox SET status='applied' WHERE commit_seq=?", event.commit_seq));
            (await this.sql.run("UPDATE operation_markers SET status='indexed',retry_owner='operator',updated_at=? WHERE commit_seq=?", (await this.sql.now()), event.commit_seq));
            return { action: "replay", recovered: failed, applied: pending, event_id: event.event_id, commit_seq: event.commit_seq, doctor: (await this.doctor()) };
        }));
    }
    async rebuildDerived(): Promise<Awaited<{
        action: "rebuild";
        rebuilt_outbox: number;
        rebuilt_markers: number;
        event_id: string;
        commit_seq: number;
        doctor: DoctorReport;
    }>> {
        return (await this.transaction(async () => {
            (await this.assertAuthorityWritable());
            const events = (await this.sql.all("SELECT commit_seq,event_id,event_type,subject_id,payload,created_at FROM events ORDER BY commit_seq")) as Array<{
                commit_seq: number;
                event_id: string;
                event_type: string;
                subject_id: string | null;
                payload: string;
                created_at: string;
            }>;
            let rebuiltOutbox = 0;
            let rebuiltMarkers = 0;
            for (const event of events) {
                const outbox = (await this.sql.get("SELECT id FROM outbox WHERE commit_seq=?", event.commit_seq));
                if (!outbox) {
                    (await this.sql.run("INSERT INTO outbox(commit_seq,status) VALUES(?,?)", event.commit_seq, "applied"));
                    rebuiltOutbox++;
                }
                const marker = (await this.sql.get("SELECT operation_id FROM operation_markers WHERE commit_seq=?", event.commit_seq));
                if (!marker) {
                    const payload = JSON.parse(event.payload) as Record<string, unknown>;
                    const owner = event.subject_id ? (await this.sql.get("SELECT engagement_id FROM object_refs WHERE id=?", event.subject_id)) as {
                        engagement_id?: string;
                    } | undefined : undefined;
                    const engagementId = typeof payload.engagement_id === "string" ? payload.engagement_id : owner?.engagement_id;
                    (await this.sql.run("INSERT INTO operation_markers(operation_id,event_id,engagement_id,commit_seq,kind,input_hash,status,updated_at) VALUES(?,?,?,?,?,?,?,?)", `operation:${event.event_id}`, event.event_id, engagementId ?? null, event.commit_seq, event.event_type, hash(json({ event_type: event.event_type, subject_id: event.subject_id ?? undefined, payload })), "indexed", (await this.sql.now())));
                    rebuiltMarkers++;
                }
                else
                    (await this.sql.run("UPDATE operation_markers SET status=CASE WHEN status='failed' THEN 'recovered' ELSE 'indexed' END,error=NULL,retry_owner='operator',updated_at=? WHERE commit_seq=?", (await this.sql.now()), event.commit_seq));
                (await this.sql.run("UPDATE outbox SET status='applied' WHERE commit_seq=?", event.commit_seq));
            }
            const recovery = (await this.nextEvent("operation.rebuilt", { actor_id: "operator", rebuilt_outbox: rebuiltOutbox, rebuilt_markers: rebuiltMarkers }));
            (await this.sql.run("UPDATE outbox SET status='applied' WHERE commit_seq=?", recovery.commit_seq));
            (await this.sql.run("UPDATE operation_markers SET status='indexed',retry_owner='operator',updated_at=? WHERE commit_seq=?", (await this.sql.now()), recovery.commit_seq));
            return { action: "rebuild", rebuilt_outbox: rebuiltOutbox, rebuilt_markers: rebuiltMarkers, event_id: recovery.event_id, commit_seq: recovery.commit_seq, doctor: (await this.doctor()) };
        }));
    }
    async reconcileDerived(action: "preview" | "replay" | "rebuild" | "reconcile" = "preview"): Promise<Awaited<OperationRecoveryPreview | ReturnType<AuthorityStore["replayDerived"]> | ReturnType<AuthorityStore["rebuildDerived"]>>> {
        if (action === "preview")
            return (await this.previewRecovery());
        if (action === "replay")
            return (await this.replayDerived());
        if (action === "reconcile") {
            const drift = (await this.derivedDrift());
            if (drift.errors.length > 0)
                return (await this.rebuildDerived());
            return (await this.replayDerived());
        }
        return (await this.rebuildDerived());
    }
    async recordHostError(input: {
        engagement_id: string;
        host_id: string;
        work_run_id?: string;
        generation?: number;
        error_ref?: string;
        message?: string;
    }): Promise<Awaited<Record<string, unknown>>> {
        return (await this.transaction(async () => {
            if (input.message && input.message.length > 512)
                throw new ContractValidationError("validation_error", "host error message is too long");
            if (input.message && /(?:password|secret|token|bearer|credential|private key)/i.test(input.message))
                throw new ContractValidationError("validation_error", "host error message contains prohibited secret material");
            const body = { engagement_id: input.engagement_id, host_id: input.host_id, work_run_id: input.work_run_id, generation: input.generation, error_ref: input.error_ref, message: input.message, recorded_at: (await this.sql.now()) };
            let taskSessionRef: string | undefined;
            let attemptId: string | undefined;
            if (input.work_run_id) {
                const run = (await this.sql.get("SELECT engagement_id,status,owner_host,generation,lease_expires_at,body FROM work_runs WHERE run_id=?", input.work_run_id)) as {
                    engagement_id?: string;
                    status?: string;
                    owner_host?: string;
                    generation?: number;
                    lease_expires_at?: string;
                    body?: string;
                } | undefined;
                const now = await this.sql.now();
                if (!run || run.engagement_id !== input.engagement_id) throw new ContractValidationError("authorization_error", "WorkRun is not in this Engagement");
                if (run.owner_host !== input.host_id || !Number.isSafeInteger(input.generation) || Number(run.generation) !== input.generation || !run.lease_expires_at || run.lease_expires_at <= now || !["claimed", "running", "checkpointed", "blocked"].includes(String(run.status)))
                    throw new ContractValidationError("stale_version", "host error is fenced by an expired or stale WorkRun");
                let runBody: Record<string, unknown>;
                try { runBody = JSON.parse(run.body ?? "{}"); }
                catch { throw new ContractValidationError("conflict", "WorkRun state is invalid"); }
                taskSessionRef = typeof runBody.task_session_ref === "string" ? runBody.task_session_ref : undefined;
                attemptId = typeof runBody.attempt_ref === "string" ? runBody.attempt_ref : undefined;
                if (!attemptId) throw new ContractValidationError("stale_version", "host error has no active Attempt");
                const attempt = await this.sql.get<{ engagement_id: string; status: string; generation: number; owner_host: string; lease_expires_at: string; body: string }>("SELECT engagement_id,status,generation,owner_host,lease_expires_at,body FROM attempts WHERE attempt_id=? AND run_id=?", attemptId, input.work_run_id);
                if (!attempt || attempt.engagement_id !== input.engagement_id || attempt.generation !== input.generation || attempt.owner_host !== input.host_id || attempt.lease_expires_at !== run.lease_expires_at || attempt.lease_expires_at <= now || !["claimed", "running", "checkpointed", "blocked"].includes(attempt.status))
                    throw new ContractValidationError("stale_version", "host error is fenced by an expired or stale Attempt");
                try {
                    const attemptBody = JSON.parse(attempt.body) as Record<string, unknown>;
                    if (attemptBody.task_session_ref !== taskSessionRef) throw new ContractValidationError("stale_version", "host error Attempt binding is stale");
                } catch (error) {
                    if (error instanceof ContractValidationError) throw error;
                    throw new ContractValidationError("conflict", "Attempt state is invalid");
                }
            }
            (await this.writeExecutionSidecar({ engagement_id: input.engagement_id, session_id: taskSessionRef, work_run_id: input.work_run_id, attempt_id: attemptId, generation: input.generation, kind: "error", reference_id: input.error_ref ?? uuidv7(), metadata: { error_ref: input.error_ref, status: "error", artifact_refs: [] } }));
            const event = (await this.nextEvent("host.error", body, input.work_run_id));
            return { ...body, event_id: event.event_id, commit_seq: event.commit_seq };
        }));
    }
    async getWorkRun(runId: string): Promise<Awaited<Record<string, unknown> | undefined>> {
        const row = (await this.sql.get("SELECT body FROM work_runs WHERE run_id=?", runId)) as {
            body?: string;
        } | undefined;
        return row ? JSON.parse(row.body!) : undefined;
    }
    /** Active leased runs for one Engagement: the join source for work.query's run view. */
    async dataVersion(): Promise<number | string> { return this.sql.dataVersion(); }
    /**
     * 订阅主题状态：单一 maintenanceRead 快照内返回提交水位与四个布尔主题态，
     * 供宿主面订阅信号（零提交路径侵入）在检测到变化后做投递判定。
     */
    async subscriptionTopicStates(engagementId: string, l1BacklogThreshold = 1): Promise<{
        committed_seq: number;
        l1_backlog: boolean;
        impact_pending: boolean;
        lease_expiry: boolean;
        artifact_integrity: boolean;
    }> {
        return (await this.maintenanceRead(async (watermarks) => {
            const exists = async (sql: string, ...values: unknown[]): Promise<boolean> => Boolean((await this.sql.get(sql, ...values)));
            const now = new Date(await this.sql.now()).toISOString();
            const soon = new Date(new Date(await this.sql.now()).getTime() + 30_000).toISOString();
            const continuation = this.sql.jsonValue("body", "continuation");
            const integrity = this.sql.jsonValue("body", "integrity_status");
            const l1Count = Number(((await this.sql.get("SELECT COUNT(*) AS count FROM records WHERE engagement_id=? AND trust_level='L1'", engagementId)) as { count: number }).count);
            const l1_backlog = l1Count >= l1BacklogThreshold;
            const impact_pending = await exists(`SELECT 1 FROM records WHERE engagement_id=? AND kind='impact_event' AND ${continuation} IS NOT NULL LIMIT 1`, engagementId);
            const lease_expiry = await exists("SELECT 1 FROM work_runs WHERE engagement_id=? AND lease_expires_at>? AND lease_expires_at<? AND status NOT IN ('completed','failed','cancelled','lost') LIMIT 1", engagementId, now, soon);
            const artifact_integrity = await exists(`SELECT 1 FROM artifact_catalog WHERE engagement_id=? AND (${integrity}='mismatch' OR ${integrity}='missing') LIMIT 1`, engagementId);
            return { committed_seq: watermarks.committed_seq, l1_backlog, impact_pending, lease_expiry, artifact_integrity };
        }));
    }
    async activeWorkRuns(engagementId: string): Promise<Array<{ run_id: string; work_item_id: string; generation: number; status: string; owner_host?: string; owner_agent?: string; lease_expires_at?: string; heartbeat_at?: string }>> {
        return (await this.readTransaction(async () => {
            const now = new Date(await this.sql.now()).toISOString();
            const rows = (await this.sql.all("SELECT run_id,work_item_id,generation,status,owner_host,owner_agent,lease_expires_at,heartbeat_at FROM work_runs WHERE engagement_id=? AND lease_expires_at>? AND status NOT IN ('completed','failed','cancelled','lost') ORDER BY run_id", engagementId, now)) as Array<Record<string, unknown>>;
            return rows.map((row) => ({
                run_id: String(row.run_id),
                work_item_id: String(row.work_item_id),
                generation: Number(row.generation),
                status: String(row.status),
                ...(row.owner_host == null ? {} : { owner_host: String(row.owner_host) }),
                ...(row.owner_agent == null ? {} : { owner_agent: String(row.owner_agent) }),
                ...(row.lease_expires_at == null ? {} : { lease_expires_at: String(row.lease_expires_at) }),
                ...(row.heartbeat_at == null ? {} : { heartbeat_at: String(row.heartbeat_at) }),
            }));
        }));
    }
    /**
     * Keyset-paged work item query with scheduling filters. The cursor advances
     * past every scanned row (not only returned matches), so filters never skip
     * items; the active-run view joins `work_runs` in the same read snapshot.
     */
    async workItemsPage(input: {
        engagement_id: string;
        principal_id?: string;
        cursor_key_root?: string;
        cursor?: string;
        page_size?: number;
        resource_refs?: string[];
        status?: string[];
        include_active_runs?: boolean;
    }): Promise<Awaited<{
        items: Array<CanonicalRecord & { active_run?: { run_id: string; work_item_id: string; generation: number; status: string; owner_host?: string; owner_agent?: string; lease_expires_at?: string; heartbeat_at?: string } }>;
        has_more: boolean;
        next_cursor?: string;
        read_seq: number;
        scanned_rows: number;
        returned_rows: number;
    }>> {
        const limit = input.page_size ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            throw new ContractValidationError("validation_error", "page_size must be an integer between 1 and 200");
        const scanBudget = 500;
        const filterDigest = hash(JSON.stringify({ resource_refs: [...(input.resource_refs ?? [])].sort(), status: [...(input.status ?? [])].sort(), include_active_runs: Boolean(input.include_active_runs) }));
        return (await this.readTransaction(async () => {
            const current = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as { seq: number }).seq);
            const cursor = input.cursor ? decodeListCursor(input.cursor, this.listCursorKey(false, input.cursor_key_root)) : undefined;
            const readSeq = cursor ? Number(cursor.read_seq) : current;
            if (!Number.isSafeInteger(readSeq) || readSeq < 0 || readSeq > current)
                throw new InvalidCursorError("invalid work page read sequence");
            if (cursor && (cursor.list !== "work_items" || cursor.principal_id !== (input.principal_id ?? "local") || cursor.engagement_id !== input.engagement_id || cursor.page_size !== limit || cursor.filter_digest !== filterDigest))
                throw new InvalidCursorError("work page cursor binding mismatch");
            const afterId = typeof cursor?.after_id === "string" ? cursor.after_id : "";
            const rows = (await this.sql.all("SELECT id,body FROM records WHERE engagement_id=? AND kind='work_item' AND id>? ORDER BY id LIMIT ?", input.engagement_id, afterId, scanBudget + 1)) as Array<{ id: string; body: string }>;
            const more = rows.length > scanBudget;
            const scanned = rows.slice(0, scanBudget);
            const wantedRefs = input.resource_refs?.length ? new Set(input.resource_refs) : undefined;
            const wantedStatus = input.status?.length ? new Set(input.status) : undefined;
            const matches = scanned
                .map((row) => JSON.parse(row.body) as CanonicalRecord)
                .filter((record) => {
                    if (wantedStatus && !wantedStatus.has(String(record.status)))
                        return false;
                    if (wantedRefs) {
                        const refs = Array.isArray(record.resource_refs) ? record.resource_refs : [];
                        return refs.some((ref) => wantedRefs.has(ref));
                    }
                    return true;
                });
            const selected = matches.slice(0, limit);
            type ActiveRunSummary = { run_id: string; work_item_id: string; generation: number; status: string; owner_host?: string; owner_agent?: string; lease_expires_at?: string; heartbeat_at?: string };
            let items: Array<CanonicalRecord & { active_run?: ActiveRunSummary }> = selected;
            if (input.include_active_runs) {
                const now = new Date(await this.sql.now()).toISOString();
                const runRows = (await this.sql.all("SELECT run_id,work_item_id,generation,status,owner_host,owner_agent,lease_expires_at,heartbeat_at FROM work_runs WHERE engagement_id=? AND lease_expires_at>? AND status NOT IN ('completed','failed','cancelled','lost')", input.engagement_id, now)) as Array<Record<string, unknown>>;
                const byItem = new Map<string, ActiveRunSummary>(runRows.map((row) => {
                    const summary = {
                        run_id: String(row.run_id), work_item_id: String(row.work_item_id), generation: Number(row.generation), status: String(row.status),
                        ...(row.owner_host == null ? {} : { owner_host: String(row.owner_host) }),
                        ...(row.owner_agent == null ? {} : { owner_agent: String(row.owner_agent) }),
                        ...(row.lease_expires_at == null ? {} : { lease_expires_at: String(row.lease_expires_at) }),
                        ...(row.heartbeat_at == null ? {} : { heartbeat_at: String(row.heartbeat_at) }),
                    };
                    return [String(row.work_item_id), summary];
                }));
                items = selected.map((record) => ({ ...record, ...(byItem.has(String(record.id)) ? { active_run: byItem.get(String(record.id)) } : {}) }));
            }
            const lastScanned = scanned.at(-1);
            const hasMore = more || matches.length > limit;
            // 页内仍有未返回命中时锚定最后一个返回项；否则越过所有扫描行，
            // 让稀疏/空窗口推进。这样既不跳过密集命中，也不会重复扫描空窗口。
            const anchorId = matches.length > limit ? selected.at(-1)?.id : more ? lastScanned?.id : undefined;
            return {
                items,
                has_more: hasMore,
                ...(hasMore && anchorId ? { next_cursor: encodeListCursor({ v: 1, list: "work_items", principal_id: input.principal_id ?? "local", engagement_id: input.engagement_id, page_size: limit, read_seq: readSeq, filter_digest: filterDigest, after_id: anchorId }, this.listCursorKey(true, input.cursor_key_root)) } : {}),
                read_seq: readSeq,
                scanned_rows: scanned.length,
                returned_rows: selected.length,
            };
        }));
    }
    /** Keyset-paged coverage cell query with single-value dimension filters. */
    async coverageCellsPage(input: {
        engagement_id: string;
        principal_id?: string;
        cursor_key_root?: string;
        cursor?: string;
        page_size?: number;
        resource_ref?: string;
        test_category?: string;
        status?: string;
        include_candidates?: boolean;
    }): Promise<Awaited<{
        cells: Array<Record<string, unknown>>;
        has_more: boolean;
        next_cursor?: string;
        read_seq: number;
        scanned_rows: number;
        returned_rows: number;
    }>> {
        const limit = input.page_size ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
            throw new ContractValidationError("validation_error", "page_size must be an integer between 1 and 200");
        const scanBudget = 500;
        const filterDigest = hash(JSON.stringify({ resource_ref: input.resource_ref ?? null, test_category: input.test_category ?? null, status: input.status ?? null, include_candidates: Boolean(input.include_candidates) }));
        const projection = (cell: CanonicalRecord): Record<string, unknown> => ({
            id: cell.id, engagement_id: cell.engagement_id, version: cell.version, status: cell.status,
            resource_ref: cell.resource_ref, ...(cell.resource_revision_ref === undefined ? {} : { resource_revision_ref: cell.resource_revision_ref }),
            test_category: cell.test_category,
            ...(cell.identity_ref === undefined ? {} : { identity_ref: cell.identity_ref }),
            ...(cell.role === undefined ? {} : { role: cell.role }),
            ...(cell.tenant_ref === undefined ? {} : { tenant_ref: cell.tenant_ref }),
            ...(cell.operation === undefined ? {} : { operation: cell.operation }),
            ...(cell.parameter === undefined ? {} : { parameter: cell.parameter }),
            ...(cell.path === undefined ? {} : { path: cell.path }),
            ...(cell.network_condition === undefined ? {} : { network_condition: cell.network_condition }),
            ...(cell.method === undefined ? {} : { method: cell.method }),
            conditions: cell.conditions, evidence_refs: cell.evidence_refs, limitations: cell.limitations,
            ...(cell.counter_evidence_refs === undefined ? {} : { counter_evidence_refs: cell.counter_evidence_refs }),
            ...(cell.not_applicable_reason === undefined ? {} : { not_applicable_reason: cell.not_applicable_reason }),
            ...(cell.external_result_state === undefined ? {} : { external_result_state: cell.external_result_state }),
            ...(cell.tested_at === undefined ? {} : { tested_at: cell.tested_at }),
            updated_at: cell.updated_at,
        });
        return (await this.readTransaction(async () => {
            const current = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as { seq: number }).seq);
            const cursor = input.cursor ? decodeListCursor(input.cursor, this.listCursorKey(false, input.cursor_key_root)) : undefined;
            const readSeq = cursor ? Number(cursor.read_seq) : current;
            if (!Number.isSafeInteger(readSeq) || readSeq < 0 || readSeq > current)
                throw new InvalidCursorError("invalid coverage page read sequence");
            if (cursor && (cursor.list !== "coverage_cells" || cursor.principal_id !== (input.principal_id ?? "local") || cursor.engagement_id !== input.engagement_id || cursor.page_size !== limit || cursor.filter_digest !== filterDigest))
                throw new InvalidCursorError("coverage page cursor binding mismatch");
            const afterId = typeof cursor?.after_id === "string" ? cursor.after_id : "";
            const rows = (await this.sql.all(`SELECT id,body FROM records WHERE engagement_id=? AND kind='coverage' AND id>? ${input.include_candidates ? "" : "AND trust_level<>'L1'"} ORDER BY id LIMIT ?`, input.engagement_id, afterId, scanBudget + 1)) as Array<{ id: string; body: string }>;
            const more = rows.length > scanBudget;
            const scanned = rows.slice(0, scanBudget);
            const matches = scanned
                .map((row) => JSON.parse(row.body) as CanonicalRecord)
                .filter((cell) => (input.resource_ref === undefined || cell.resource_ref === input.resource_ref)
                    && (input.test_category === undefined || cell.test_category === input.test_category)
                    && (input.status === undefined || String(cell.status) === input.status))
                .map(projection);
            const selected = matches.slice(0, limit);
            const hasMore = more || matches.length > limit;
            const anchorId = matches.length > limit ? selected.at(-1)?.id : more ? scanned.at(-1)?.id : undefined;
            return {
                cells: selected,
                has_more: hasMore,
                ...(hasMore && anchorId ? { next_cursor: encodeListCursor({ v: 1, list: "coverage_cells", principal_id: input.principal_id ?? "local", engagement_id: input.engagement_id, page_size: limit, read_seq: readSeq, filter_digest: filterDigest, after_id: anchorId }, this.listCursorKey(true, input.cursor_key_root)) } : {}),
                read_seq: readSeq,
                scanned_rows: scanned.length,
                returned_rows: selected.length,
            };
        }));
    }
    async sealExecutionSidecars(runId: string, generation: number, reason = "attempt_lost"): Promise<Awaited<number>> {
        return (await this.transaction(async () => {
            const rows = (await this.sql.all("SELECT execution_id,body FROM execution_catalog WHERE work_run_id=?", runId)) as Array<{
                execution_id: string;
                body: string;
            }>;
            let changed = 0;
            for (const row of rows) {
                const body = JSON.parse(row.body) as Record<string, unknown>;
                if (Number(body.generation) !== generation || body.sealed === true)
                    continue;
                body.sealed = true;
                body.sealed_reason = reason;
                body.sealed_at = (await this.sql.now());
                (await this.sql.run("UPDATE execution_catalog SET body=? WHERE execution_id=?", json(body), row.execution_id));
                changed++;
            }
            return changed;
        }));
    }
    async validateArtifactFence(input: {
        engagement_id: string;
        session_id: string;
        work_run_id: string;
        attempt_id: string;
        generation: number;
        principal: string;
    }): Promise<Awaited<void>> {
        const row = (await this.sql.get("SELECT engagement_id,status,owner_host,generation,lease_expires_at,body FROM work_runs WHERE run_id=?", input.work_run_id)) as {
            engagement_id?: string;
            status?: string;
            owner_host?: string;
            generation?: number;
            lease_expires_at?: string;
            body?: string;
        } | undefined;
        if (!row || row.engagement_id !== input.engagement_id)
            throw new ContractValidationError("authorization_error", "WorkRun is not in this Engagement");
        let body: Record<string, unknown>;
        try {
            body = JSON.parse(row.body ?? "{}");
        }
        catch {
            throw new ContractValidationError("conflict", "WorkRun state is invalid");
        }
        if (body.task_session_ref !== input.session_id)
            throw new ContractValidationError("authorization_error", "Artifact does not match the registered WorkRun session");
        if (row.owner_host !== input.principal || Number(row.generation) !== input.generation || !row.lease_expires_at || row.lease_expires_at <= (await this.sql.now()) || !["claimed", "running", "checkpointed", "blocked"].includes(String(row.status)))
            throw new ContractValidationError("stale_version", "Artifact write is fenced by an expired or stale WorkRun");
        if (body.attempt_ref !== input.attempt_id)
            throw new ContractValidationError("stale_version", "Artifact Attempt is stale");
        const attempt = (await this.sql.get("SELECT engagement_id,status,generation,owner_host,lease_expires_at,body FROM attempts WHERE attempt_id=? AND run_id=?", input.attempt_id, input.work_run_id)) as {
            engagement_id?: string;
            status?: string;
            generation?: number;
            owner_host?: string;
            lease_expires_at?: string;
            body?: string;
        } | undefined;
        const attemptBody = attempt?.body ? JSON.parse(attempt.body) as Record<string, unknown> : {};
        if (!attempt || attempt.engagement_id !== input.engagement_id || attempt.owner_host !== input.principal || Number(attempt.generation) !== input.generation || attempt.lease_expires_at !== row.lease_expires_at || !["claimed", "running", "checkpointed", "blocked"].includes(String(attempt.status)) || attemptBody.task_session_ref !== input.session_id)
            throw new ContractValidationError("stale_version", "Artifact Attempt is missing, expired, or fenced");
    }
    async transitionWorkRun(
        runId: string,
        generation: number,
        hostId: string,
        status: "running" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled",
        options: { engagement_id?: string; idempotency_key?: string } = {},
    ): Promise<Awaited<Record<string, unknown>>> {
        return (await this.transaction(async () => {
            const operation = "work.transition";
            const principal = hostId;
            const engagementId = options.engagement_id ?? "";
            const requestHash = hash(json(stablePayload({ work_run_id: runId, generation, status })));
            if (options.idempotency_key) {
                const prior = (await this.sql.get("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?", options.idempotency_key)) as any;
                if (prior) {
                    if (prior.request_hash !== requestHash || prior.operation !== operation || prior.principal !== principal || prior.engagement_id !== engagementId)
                        throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
                    return JSON.parse(prior.result) as Record<string, unknown>;
                }
            }
            const row = (await this.sql.get("SELECT * FROM work_runs WHERE run_id=?", runId)) as any;
            if (!row || (options.engagement_id !== undefined && row.engagement_id !== options.engagement_id))
                throw new ContractValidationError("conflict", "work run not found in this engagement");
            const now = (await this.sql.now());
            if (!row || row.owner_host !== hostId || Number(row.generation) !== generation || !row.lease_expires_at || row.lease_expires_at <= now) {
                throw new ContractValidationError("stale_version", "work run transition is fenced by an expired lease, owner, or generation");
            }
            const priorStatus = String(row.status);
            if (!workTransitions[priorStatus]?.includes(status))
                throw new ContractValidationError("conflict", `illegal work run transition: ${priorStatus} -> ${status}`);
            const body = JSON.parse(row.body) as Record<string, unknown>;
            body.status = status;
            const attemptId = String(body.attempt_ref ?? "");
            const attemptRow = attemptId ? (await this.sql.get("SELECT status,body FROM attempts WHERE attempt_id=? AND run_id=? AND generation=?", attemptId, runId, generation)) as {
                status?: string;
                body?: string;
            } | undefined : undefined;
            if (!attemptRow || !attemptTransitions[String(attemptRow.status)]?.includes(status))
                throw new ContractValidationError("conflict", "active Attempt cannot make the requested transition");
            const attempt = JSON.parse(attemptRow.body!) as Record<string, unknown>;
            attempt.status = status;
            if (["completed", "failed", "cancelled"].includes(status))
                attempt.ended_at = now;
            (await this.sql.run("UPDATE attempts SET status=?,body=?,updated_at=? WHERE attempt_id=? AND run_id=? AND generation=?", status, json(attempt), now, attemptId, runId, generation));
            (await this.sql.run("UPDATE work_runs SET status=?,body=?,updated_at=? WHERE run_id=? AND generation=? AND owner_host=?", status, json(body), now, runId, generation, hostId));
            (await this.nextEvent("work_run.transition", { attempt_id: attemptId, generation, from: priorStatus, to: status, host_id: hostId, idempotency_key: options.idempotency_key }, runId));
            if (options.idempotency_key)
                (await this.sql.run("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", options.idempotency_key, operation, principal, engagementId, requestHash, json(body)));
            return body;
        }));
    }
    async recordActionIntent(input: {
        action_id?: string;
        run_id: string;
        generation: number;
        mode: "llm_recommend" | "authorized_autonomous" | "host_hitl";
        target?: string;
        method?: string;
        rationale?: string;
        uncertainty?: string;
        scope?: string;
        constraints?: string[];
        limitations?: string[];
        memory_refs?: string[];
        evidence_refs?: string[];
        host_decision_ref?: string;
        status: "recommended" | "authorized" | "denied" | "executed" | "failed" | "unknown";
        result_ref?: string;
        host_id: string;
        actor_role?: "host" | "model";
    }, reconciliation = false): Promise<Awaited<Record<string, unknown>>> {
        const actionId = input.action_id ?? uuidv7();
        return (await this.transaction(async () => {
            const run = (await this.sql.get("SELECT generation,status,owner_host,owner_agent,engagement_id,lease_expires_at FROM work_runs WHERE run_id=?", input.run_id)) as {
                generation?: number;
                status?: string;
                owner_host?: string;
                owner_agent?: string;
                engagement_id?: string;
                lease_expires_at?: string;
            } | undefined;
            if (!run || Number(run.generation) !== input.generation)
                throw new ContractValidationError("stale_version", "stale action intent generation");
            const actorMatches = run.owner_host === input.host_id || (input.status === "recommended" && input.actor_role === "model" && run.owner_agent === input.host_id);
            if (!actorMatches)
                throw new ContractValidationError("authorization_error", "action actor is not the current owner");
            if (!run.lease_expires_at || run.lease_expires_at <= (await this.sql.now()))
                throw new ContractValidationError("stale_version", "action intent lease is expired");
            if (["completed", "failed", "cancelled", "lost"].includes(String(run.status)))
                throw new ContractValidationError("conflict", "action intent is not writable for a terminal work run");
            const prior = (await this.sql.get("SELECT status,generation,run_id,body FROM action_intents WHERE action_id=?", actionId)) as {
                status?: string;
                generation?: number;
                run_id?: string;
                body?: string;
            } | undefined;
            const priorBody = prior?.body ? JSON.parse(prior.body) as Record<string, unknown> : {};
            const body = { ...priorBody, ...input, action_id: actionId, engagement_id: run.engagement_id, owner: { host_id: run.owner_host, agent_id: run.owner_agent }, recorded_at: priorBody.recorded_at ?? (await this.sql.now()) };
            if (prior) {
                if (prior.run_id !== input.run_id || Number(prior.generation) !== input.generation)
                    throw new ContractValidationError("conflict", "action intent belongs to another WorkRun or generation");
                if (prior.status === input.status) {
                    const same = ["mode", "target", "method", "host_decision_ref", "result_ref"].every((field) => (priorBody as Record<string, unknown>)[field] === (body as Record<string, unknown>)[field]);
                    if (same)
                        return priorBody;
                    throw new ContractValidationError("idempotency_conflict", "action intent retry changed its outcome payload");
                }
                if (prior.status === "unknown" && ["executed", "failed"].includes(input.status) && !reconciliation)
                    throw new ContractValidationError("conflict", "unknown action results require explicit host reconciliation");
                if (!actionTransitions[String(prior.status)]?.includes(input.status))
                    throw new ContractValidationError("conflict", `illegal action intent transition: ${prior.status} -> ${input.status}`);
            }
            else if (input.status !== "recommended") {
                throw new ContractValidationError("conflict", "action intent must start in recommended state");
            }
            if (!prior && (!input.target?.trim() || !input.method?.trim()))
                throw new ContractValidationError("validation_error", "recommended action requires target and method");
            if (["authorized", "denied"].includes(input.status) && !input.host_decision_ref)
                throw new ContractValidationError("validation_error", "host decision reference is required for host decisions");
            if (["executed", "failed"].includes(input.status) && !input.result_ref)
                throw new ContractValidationError("validation_error", "resolved action requires a host result reference");
            const attempt = (await this.sql.get("SELECT * FROM attempts WHERE run_id=? AND generation=?", input.run_id, input.generation)) as {
                attempt_id?: string;
                status?: string;
                owner_host?: string;
                owner_agent?: string;
                lease_expires_at?: string;
            } | undefined;
            if (!attempt?.attempt_id || attempt.owner_host !== run.owner_host || attempt.owner_agent !== run.owner_agent || attempt.lease_expires_at !== run.lease_expires_at || ["completed", "failed", "cancelled", "lost"].includes(String(attempt.status)))
                throw new ContractValidationError("conflict", "ActionIntent requires the active Attempt");
            const actionRecord = {
                id: actionId,
                schema_version: SCHEMA_VERSION,
                engagement_id: run.engagement_id,
                created_at: body.recorded_at,
                provenance: { host_id: input.host_id, producer_id: String(run.owner_agent), source_kind: "host" },
                kind: "action_intent",
                target: body.target,
                method: body.method,
                rationale: body.rationale,
                scope: body.scope,
                uncertainty: body.uncertainty,
                constraints: body.constraints ?? [],
                limitations: body.limitations ?? [],
                memory_refs: body.memory_refs ?? [],
                evidence_refs: body.evidence_refs ?? [],
                status: input.status,
                mode: input.mode,
                work_run_ref: input.run_id,
                attempt_ref: attempt.attempt_id,
                generation: input.generation,
                owner: { host_id: run.owner_host, agent_id: run.owner_agent },
                host_decision_ref: input.host_decision_ref,
                result_ref: input.result_ref,
                idempotency_key: actionId,
            };
            validateContract("actionIntent", actionRecord);
            validateAuthorityReferences(actionRecord, (await this.referenceIndex(actionRecord, String(run.engagement_id))), String(run.engagement_id));
            (await this.sql.run("INSERT INTO action_intents(action_id,run_id,generation,status,body,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET status=excluded.status,body=excluded.body,updated_at=excluded.updated_at", actionId, input.run_id, input.generation, input.status, json(body), (await this.sql.now())));
            (await this.sql.run("INSERT INTO object_refs(id,engagement_id,kind) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET engagement_id=excluded.engagement_id,kind=excluded.kind", actionId, String(run.engagement_id), "action_intent"));
            const runRow = (await this.sql.get("SELECT body FROM work_runs WHERE run_id=?", input.run_id)) as {
                body?: string;
            } | undefined;
            const runBody = runRow?.body ? JSON.parse(runRow.body) as Record<string, unknown> : {};
            (await this.writeExecutionSidecar({ engagement_id: String(run.engagement_id), session_id: typeof runBody.task_session_ref === "string" ? runBody.task_session_ref : undefined, work_run_id: input.run_id, attempt_id: attempt.attempt_id, generation: input.generation, kind: input.status === "recommended" || input.status === "authorized" || input.status === "denied" ? "action" : "result", reference_id: actionId, metadata: { action_id: actionId, status: input.status, mode: input.mode, host_decision_ref: input.host_decision_ref, result_ref: input.result_ref, artifact_refs: [] } }));
            (await this.nextEvent(`action_intent.${input.status}`, { mode: input.mode, status: input.status, host_id: input.host_id, agent_id: run.owner_agent, work_run_id: input.run_id, generation: input.generation, host_decision_ref: input.host_decision_ref, result_ref: input.result_ref }, actionId));
            return body;
        }));
    }
    async pendingActionIntents(runId: string): Promise<Awaited<Array<Record<string, unknown>>>> {
        return ((await this.sql.all("SELECT body FROM action_intents WHERE run_id=? AND status IN ('unknown','authorized')", runId)) as Array<{
            body: string;
        }>).map((row) => JSON.parse(row.body));
    }
    async getActionIntent(actionId: string): Promise<Awaited<Record<string, unknown> | undefined>> {
        const row = (await this.sql.get("SELECT body FROM action_intents WHERE action_id=?", actionId)) as {
            body?: string;
        } | undefined;
        return row?.body ? JSON.parse(row.body) : undefined;
    }
    async resumePacket(runId: string, hostId: string): Promise<Awaited<Record<string, unknown>>> {
        return this.readTransaction(async () => {
        const now = Date.parse(await this.sql.now());
        const row = (await this.sql.get("SELECT * FROM work_runs WHERE run_id=?", runId)) as any;
        if (!row)
            throw new ContractValidationError("conflict", "work run not found");
        if (row.owner_host !== hostId)
            throw new ContractValidationError("authorization_error", "host does not own work run");
        const run = JSON.parse(row.body) as Record<string, unknown>;
        const checkpoint = row.checkpoint_id ? JSON.parse(((await this.sql.get("SELECT body FROM checkpoints WHERE checkpoint_id=?", row.checkpoint_id)) as any).body) : null;
        const currentReadSeq = Number(((await this.sql.get("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events")) as any).seq);
        const checkpointReadSeq = checkpoint && typeof checkpoint.source_read_seq === "number" ? checkpoint.source_read_seq : undefined;
        const workItemRow = (await this.sql.get("SELECT engagement_id,version,body FROM records WHERE id=? AND kind='work_item'", row.work_item_id)) as {
            engagement_id?: string;
            version?: number;
            body?: string;
        } | undefined;
        const workItem = workItemRow?.body ? JSON.parse(workItemRow.body) as Record<string, unknown> : undefined;
        const engagementRow = (await this.sql.get("SELECT body FROM records WHERE id=? AND kind='engagement'", row.engagement_id)) as {
            body?: string;
        } | undefined;
        const engagement = engagementRow?.body ? JSON.parse(engagementRow.body) as Record<string, unknown> : undefined;
        const currentScopeRef = typeof workItem?.scope_ref === "string" ? workItem.scope_ref : typeof engagement?.scope_ref === "string" ? engagement.scope_ref : undefined;
        const scopeRow = currentScopeRef ? (await this.sql.get("SELECT engagement_id,version,body FROM records WHERE id=? AND kind='scope'", currentScopeRef)) as {
            engagement_id?: string;
            version?: number;
            body?: string;
        } | undefined : undefined;
        const pendingActions = (await this.pendingActionIntents(runId));
        const artifactRows = (await this.sql.all("SELECT body FROM artifact_catalog WHERE engagement_id=? AND session_id=? ORDER BY stored_at,content_ref", row.engagement_id, String(run.task_session_ref ?? ""))) as Array<{
            body: string;
        }>;
        const artifact_refs = artifactRows.map((item) => { const artifact = JSON.parse(item.body) as Record<string, unknown>; const { relative_dir: _dir, manifest_path: _manifest, host_ref: _hostRef, ...metadata } = artifact; return metadata; });
        const currentActions = (await this.sql.all("SELECT action_id,body FROM action_intents WHERE run_id=? AND generation=?", runId, Number(row.generation))) as Array<{
            action_id: string;
            body: string;
        }>;
        const currentActionBodies = currentActions.map((item) => JSON.parse(item.body) as Record<string, unknown>);
        const verifiedDecisions = currentActionBodies.flatMap((item) => typeof item.host_decision_ref === "string" ? [item.host_decision_ref] : []);
        const verifiedResults = currentActionBodies.flatMap((item) => typeof item.result_ref === "string" ? [item.result_ref] : []);
        const actionRefsValid = !checkpoint || ((checkpoint.action_refs as unknown[]).every((ref) => typeof ref === "string" && currentActions.some((item) => item.action_id === ref)) && (checkpoint.tool_result_refs as unknown[]).every((ref) => typeof ref === "string" && verifiedResults.includes(ref)));
        const scopeValid = currentScopeRef === (checkpoint?.scope_ref as string | undefined)
            && (!currentScopeRef || Boolean(scopeRow?.body && scopeRow.engagement_id === row.engagement_id && !this.isRecalled(JSON.parse(scopeRow.body) as CanonicalRecord, now)));
        const premiseChecks = {
            engagement: run.engagement_id === row.engagement_id,
            work_item: Boolean(workItem && workItemRow && workItemRow.engagement_id === row.engagement_id && !this.isRecalled(workItem as CanonicalRecord, now) && run.work_item_id === row.work_item_id && (!checkpoint || (checkpoint.work_item_ref === row.work_item_id && Number(checkpoint.work_item_version) === Number(workItemRow.version) && Number(checkpoint.target_version) === Number(workItem.target_version ?? workItemRow.version)))),
            scope: scopeValid && Boolean(!currentScopeRef || Number(checkpoint?.scope_version) === Number(scopeRow?.version)),
            checkpoint: Boolean(checkpoint),
            attempt: !checkpoint || (checkpoint.attempt_ref === run.attempt_ref && checkpoint.generation === row.generation),
            source_sequence: checkpointReadSeq === undefined || checkpointReadSeq <= currentReadSeq,
            lease: typeof row.lease_expires_at === "string" && Date.parse(row.lease_expires_at) > now,
            context_manifest: !checkpoint || (checkpoint.context_manifest?.read_seq === checkpointReadSeq && typeof checkpoint.context_manifest?.context_snapshot_id === "string"),
            host_authorization_refs: !checkpoint || (checkpoint.host_decision_refs as unknown[]).every((ref) => typeof ref === "string" && verifiedDecisions.includes(ref)),
            action_results: actionRefsValid && pendingActions.length === 0,
        };
        const replanRequired = Object.values(premiseChecks).some((valid) => !valid);
        return {
            run,
            checkpoint,
            pending_actions: pendingActions,
            task_session_ref: run.task_session_ref,
            artifact_refs,
            checkpoint_read_seq: checkpointReadSeq,
            current_read_seq: currentReadSeq,
            premise_checks: premiseChecks,
            blocked: replanRequired,
            replan_required: replanRequired,
            resume_advice: replanRequired ? "replan_required" : "resume_allowed",
        };
        });
    }
    async recordLateResult(input: {
        run_id: string;
        generation: number;
        result_ref: string;
        result: Record<string, unknown>;
    }): Promise<Awaited<Record<string, unknown>>> {
        const forbidden = /(?:token|secret|credential|password|cookie|authorization|bearer|body|packet|hidden_reasoning|chain_of_thought)/i;
        const result = Object.fromEntries(Object.entries(input.result ?? {}).filter(([key]) => !forbidden.test(key)).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 512) : value]));
        const late = { late_result_id: uuidv7(), run_id: input.run_id, generation: input.generation, result_ref: input.result_ref, result, status: "late_result_quarantine", recorded_at: (await this.sql.now()) };
        return (await this.transaction(async () => {
            const run = (await this.sql.get("SELECT body,engagement_id FROM work_runs WHERE run_id=?", input.run_id)) as {
                body?: string;
                engagement_id?: string;
            } | undefined;
            const runBody = run?.body ? JSON.parse(run.body) as Record<string, unknown> : {};
            (await this.writeExecutionSidecar({ engagement_id: String(run?.engagement_id ?? ""), session_id: typeof runBody.task_session_ref === "string" ? runBody.task_session_ref : undefined, work_run_id: input.run_id, attempt_id: typeof runBody.attempt_ref === "string" ? runBody.attempt_ref : undefined, generation: input.generation, kind: "result", reference_id: late.late_result_id, metadata: { status: late.status, result_ref: input.result_ref, quarantine: true, artifact_refs: [] } }));
            (await this.sql.run("INSERT INTO action_intents(action_id,run_id,generation,status,body,updated_at) VALUES(?,?,?,?,?,?)", late.late_result_id, input.run_id, input.generation, late.status, json(late), (await this.sql.now())));
            (await this.nextEvent("action_intent.late_result_quarantine", { generation: input.generation, result_ref: input.result_ref }, late.late_result_id));
            return late;
        }));
    }
    async submitReview(input: {
        id?: string;
        proposal_id: string;
        reviewer_id: string;
        reviewer_kind: "deterministic" | "model" | "reviewer";
        input_hash: string;
        verdict: "pass" | "reject" | "needs_evidence" | "defer";
        policy_digest?: string;
        rubric_hash?: string;
        evidence_snapshot_hash?: string;
        limitations?: string[];
        idempotencyKey?: string;
        principal?: string;
        reviewer_capability?: AdmissionReview["reviewer_kind"];
        reviewer_model?: string;
        prompt_digest?: string;
        ruleset_digest?: string;
    }): Promise<Awaited<{
        id: string;
        accepted: boolean;
        reason?: string;
        proposal_hash?: string;
        evidence_snapshot_hash?: string;
        review_hash?: string;
    }>> {
        return (await this.transaction(async () => {
            const proposalRow = (await this.sql.get("SELECT * FROM proposals WHERE id=?", input.proposal_id)) as any;
            if (!proposalRow)
                throw new ContractValidationError("conflict", "proposal not found");
            const proposal = this.proposalFromRow(proposalRow);
            const admissionBinding = proposal.subject_type === "finding" && proposal.status === "admitted"
                ? await this.sql.get<{ proposal_hash: string; policy_digest: string; evidence_snapshot_hash: string; canonical_id: string }>(
                    "SELECT proposal_hash,policy_digest,evidence_snapshot_hash,canonical_id FROM admission_review_packs WHERE proposal_id=? AND engagement_id=?",
                    proposal.id, proposal.engagement_id,
                )
                : undefined;
            if (proposal.subject_type === "finding" && proposal.status === "admitted" && !admissionBinding)
                throw new ContractValidationError("conflict", "finding has no admission-bound review snapshot; rerun admission");
            if (admissionBinding && (admissionBinding.proposal_hash !== proposal.content_hash || admissionBinding.canonical_id !== proposal.canonical_id))
                throw new ContractValidationError("stale_version", "admission-bound proposal input has changed");
            const expectedProposalHash = admissionBinding?.proposal_hash ?? proposal.content_hash;
            if (input.input_hash !== expectedProposalHash)
                throw new ContractValidationError("stale_version", "review input hash does not match the admitted proposal");
            if (admissionBinding && (!input.policy_digest || input.policy_digest !== admissionBinding.policy_digest))
                throw new ContractValidationError("stale_version", "review policy digest does not match the admission snapshot");
            if (admissionBinding && (!input.evidence_snapshot_hash || input.evidence_snapshot_hash !== admissionBinding.evidence_snapshot_hash))
                throw new ContractValidationError("stale_version", "review evidence snapshot does not match the admission snapshot");
            const currentEvidenceHash = await this.evidenceSnapshotHash(proposal);
            if (input.evidence_snapshot_hash && input.evidence_snapshot_hash !== currentEvidenceHash)
                throw new ContractValidationError("stale_version", "review evidence changed after its snapshot was created");
            if (admissionBinding && currentEvidenceHash !== admissionBinding.evidence_snapshot_hash)
                throw new ContractValidationError("stale_version", "admission evidence changed; regenerate admission and review pack");
            const rejectedId = input.id ?? uuidv7();
            const expectedEvidenceSnapshotHash = currentEvidenceHash;
            const evidenceSnapshotHash = input.evidence_snapshot_hash ?? expectedEvidenceSnapshotHash;
            const requestHash = hash(json(stablePayload({ proposal_id: input.proposal_id, reviewer_id: input.reviewer_id, reviewer_kind: input.reviewer_kind, input_hash: input.input_hash, verdict: input.verdict, policy_digest: input.policy_digest, rubric_hash: input.rubric_hash, evidence_snapshot_hash: evidenceSnapshotHash, limitations: input.limitations, reviewer_capability: input.reviewer_capability, reviewer_model: input.reviewer_model, prompt_digest: input.prompt_digest, ruleset_digest: input.ruleset_digest })));
            if (input.idempotencyKey) {
                const prior = (await this.sql.get("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?", input.idempotencyKey)) as any;
                if (prior) {
                    if (prior.request_hash !== requestHash || prior.operation !== "review.submit" || prior.principal !== (input.principal ?? input.reviewer_id) || prior.engagement_id !== proposal.engagement_id)
                        throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
                    return JSON.parse(prior.result);
                }
            }
            const finalize = async (result: {
                id: string;
                accepted: boolean;
                reason?: string;
                proposal_hash?: string;
                evidence_snapshot_hash?: string;
                review_hash?: string;
            }) => {
                if (input.idempotencyKey)
                    (await this.sql.run("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", input.idempotencyKey, "review.submit", input.principal ?? input.reviewer_id, proposal.engagement_id, requestHash, json(result)));
                return result;
            };
            const rejectReview = async (reason: string) => {
                const rejected = { id: rejectedId, accepted: false, reason, proposal_hash: proposal.content_hash, evidence_snapshot_hash: evidenceSnapshotHash };
                (await this.nextEvent("review.reject", { reviewer_id: input.reviewer_id, input_hash: input.input_hash, proposal_hash: proposal.content_hash, evidence_snapshot_hash: evidenceSnapshotHash, reason, policy_digest: input.policy_digest }, rejectedId));
                return finalize(rejected);
            };
            const provenance = (proposal.content.provenance ?? {}) as Record<string, unknown>;
            const author = String(provenance.producer_id ?? "");
            const worker = String(provenance.worker_id ?? provenance.author_id ?? "");
            if (input.reviewer_kind === "reviewer" && [author, worker].includes(input.reviewer_id))
                return rejectReview("reviewer is not independent from the proposal author or validating worker");
            if (input.reviewer_kind === "reviewer" && !input.policy_digest)
                return rejectReview("reviewer policy digest is required");
            const expectedEvidenceHash = expectedEvidenceSnapshotHash;
            const reviewBody = { ...input, proposal_hash: proposal.content_hash, evidence_snapshot_hash: expectedEvidenceHash, rubric_hash: input.rubric_hash ?? hash("taric:l2:minimal-rubric"), limitations: input.limitations ?? proposal.content.limitations ?? [] };
            const reviewHash = hash(json(stablePayload(reviewBody)));
            (await this.sql.run("INSERT INTO reviews(id,proposal_id,reviewer_id,reviewer_kind,input_hash,verdict,body,created_at) VALUES(?,?,?,?,?,?,?,?)", rejectedId, input.proposal_id, input.reviewer_id, input.reviewer_kind, input.input_hash, input.verdict, json({ ...reviewBody, review_hash: reviewHash }), (await this.sql.now())));
            // Register the accepted review so a later L2 promotion can anchor review_ref
            // to a real object. Without this the reference check rejects every promotion.
            (await this.sql.run("INSERT INTO object_refs(id,engagement_id,kind) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET engagement_id=excluded.engagement_id,kind=excluded.kind", rejectedId, proposal.engagement_id, "review"));
            (await this.nextEvent("review.submit", { reviewer_kind: input.reviewer_kind, reviewer_id: input.reviewer_id, input_hash: input.input_hash, proposal_hash: proposal.content_hash, evidence_snapshot_hash: evidenceSnapshotHash, review_hash: reviewHash, verdict: input.verdict, policy_digest: input.policy_digest, idempotency_key: input.idempotencyKey }, rejectedId));
            const accepted = { id: rejectedId, accepted: true, proposal_hash: proposal.content_hash, evidence_snapshot_hash: evidenceSnapshotHash, review_hash: reviewHash };
            return finalize(accepted);
        }));
    }
    /**
     * Deterministic admission evaluation for a proposal. Advisory review verdicts,
     * a caller-declared trust level and an `accept: true` payload are never inputs:
     * the non-LLM policy engine recomputes every hard gate (tasks 1.1, 1.2).
     */
    async evaluateAdmission(proposalId: string, input: {
        policyDigest?: string;
        policy?: AdmissionPolicy;
        now?: string;
        reviewRefs?: string[];
    } = {}): Promise<Awaited<AdmissionDecision & {
        proposal_id: string;
    }>> {
        return this.readTransaction(async () => {
        const proposalRow = (await this.sql.get("SELECT * FROM proposals WHERE id=?", proposalId)) as any;
        if (!proposalRow)
            throw new ContractValidationError("conflict", "proposal not found");
        const proposal = this.proposalFromRow(proposalRow);
        const policy = input.policy ?? DEFAULT_ADMISSION_POLICY;
        const digest = input.policyDigest ?? policyDigest(policy);
        const content = proposal.content as Record<string, unknown>;
        const provenance = (content.provenance ?? {}) as Record<string, unknown>;
        const evidenceRefs = [...new Set([
                ...(Array.isArray(content.evidence_refs) ? content.evidence_refs as string[] : []),
                ...(Array.isArray(content.counter_evidence_refs) ? content.counter_evidence_refs as string[] : []),
                ...(typeof content.applicable_scope_ref === "string" ? [content.applicable_scope_ref] : []),
            ])].sort();
        const evidenceRows = (await this.referenceRecords(evidenceRefs));
        const evidence: PinnedEvidence[] = evidenceRefs.map((id) => {
            const referenced = evidenceRows.get(id);
            const row = referenced?.engagement_id === proposal.engagement_id ? referenced : undefined;
            const record = row?.body ? JSON.parse(row.body) as CanonicalRecord : undefined;
            return { id, version: Number(row?.version ?? 0), observed_at: typeof record?.observed_at === "string" ? record.observed_at : typeof record?.tested_at === "string" ? record.tested_at : undefined, status: String(record?.status ?? "missing"), origin: (record?.provenance as { source_kind?: string } | undefined)?.source_kind };
        });
        const reviewRows = (await this.sql.all("SELECT id,body FROM reviews WHERE proposal_id=? ORDER BY created_at", proposalId)) as Array<{
            id: string;
            body: string;
        }>;
        const reviews: AdmissionReview[] = reviewRows.filter((row) => !input.reviewRefs || input.reviewRefs.includes(row.id)).map((row) => {
            const body = JSON.parse(row.body) as Record<string, unknown>;
            return {
                review_id: row.id,
                reviewer_id: String(body.reviewer_id ?? ""),
                reviewer_kind: (typeof body.reviewer_capability === "string" ? body.reviewer_capability : body.reviewer_kind === "reviewer" ? "model" : String(body.reviewer_kind ?? "model")) as AdmissionReview["reviewer_kind"],
                verdict: String(body.verdict ?? "defer") as AdmissionReview["verdict"],
                input_hash: String(body.input_hash ?? ""),
                evidence_snapshot_hash: String(body.evidence_snapshot_hash ?? ""),
                policy_digest: String(body.policy_digest ?? ""),
                reviewer_model: typeof body.reviewer_model === "string" ? body.reviewer_model : undefined,
                prompt_digest: typeof body.prompt_digest === "string" ? body.prompt_digest : undefined,
                ruleset_digest: typeof body.ruleset_digest === "string" ? body.ruleset_digest : undefined,
            };
        });
        const snapshot = (await this.evidenceSnapshot(proposal));
        const decision = evaluateAdmission({
            subject: {
                id: proposal.canonical_id ?? proposal.target_id ?? proposalId,
                kind: String(content.kind ?? proposal.subject_type),
                author_ids: [String(provenance.producer_id ?? "")].filter(Boolean),
                worker_ids: [String(provenance.worker_id ?? "")].filter(Boolean),
                claim_refs: Array.isArray(content.claim_refs) ? content.claim_refs as string[] : undefined,
                evidence_refs: Array.isArray(content.evidence_refs) ? content.evidence_refs as string[] : undefined,
                counter_evidence_refs: Array.isArray(content.counter_evidence_refs) ? content.counter_evidence_refs as string[] : undefined,
                applicable_scope_ref: typeof content.applicable_scope_ref === "string" ? content.applicable_scope_ref : undefined,
                allowed_targets: Array.isArray(content.allowed_targets) ? content.allowed_targets as string[] : undefined,
                excluded_targets: Array.isArray(content.excluded_targets) ? content.excluded_targets as string[] : undefined,
                target: typeof content.target === "string" ? content.target : undefined,
                reproducibility: typeof content.reproducibility === "string" ? content.reproducibility : undefined,
                limitations: Array.isArray(content.limitations) ? content.limitations as string[] : undefined,
                review_after: typeof content.review_after === "string" ? content.review_after : undefined,
                expires_at: typeof content.expires_at === "string" ? content.expires_at : undefined,
                risk_class: riskClassOf(content),
            },
            policy,
            policy_digest: digest,
            evidence,
            reviews,
            input_hash: proposal.content_hash,
            evidence_snapshot_hash: snapshot.hash,
            now: input.now ?? await this.sql.now(),
        });
        if (snapshot.errors.length) {
            // The pinned snapshot could not be computed; fail closed on every gate it feeds.
            for (const gate of decision.gates) {
                if (gate.gate === "evidence" || gate.gate === "freshness" || gate.gate === "independence") {
                    gate.passed = false;
                    gate.reasons.push(...snapshot.errors);
                }
            }
            decision.admitted = false;
            decision.promotable = false;
            decision.reasons.push(...snapshot.errors);
        }
        return { proposal_id: proposalId, ...decision };
        });
    }
    async promoteFinding(proposalId: string, input: {
        expectedBaseVersion: number;
        policyDigest: string;
        targetId?: string;
        inputHash?: string;
        evidenceSnapshotHash?: string;
        reviewRefs?: string[];
        idempotencyKey?: string;
        principal?: string;
        policy?: AdmissionPolicy;
        now?: string;
    }): Promise<Awaited<AdmissionResult>> {
        return (await this.transaction(async () => {
            const proposalRow = (await this.sql.get("SELECT * FROM proposals WHERE id=?", proposalId)) as any;
            if (!proposalRow)
                throw new ContractValidationError("conflict", "proposal not found");
            const proposal = this.proposalFromRow(proposalRow);
            const requestHash = hash(json(stablePayload({ proposal_id: proposalId, expected_version: input.expectedBaseVersion, target_id: input.targetId, input_hash: input.inputHash, evidence_snapshot_hash: input.evidenceSnapshotHash, review_refs: input.reviewRefs, policy_digest: input.policyDigest })));
            if (input.idempotencyKey) {
                const prior = (await this.sql.get("SELECT result,operation,principal,engagement_id,request_hash FROM idempotency WHERE key=?", input.idempotencyKey)) as any;
                if (prior) {
                    if (prior.request_hash !== requestHash || prior.operation !== "admission.promote_l2" || prior.principal !== (input.principal ?? "core") || prior.engagement_id !== proposal.engagement_id)
                        throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
                    return JSON.parse(prior.result) as AdmissionResult;
                }
            }
            const finalize = async (result: AdmissionResult) => {
                const normalized = JSON.parse(json(result)) as AdmissionResult;
                if (input.idempotencyKey)
                    (await this.sql.run("INSERT INTO idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES(?,?,?,?,?,?)", input.idempotencyKey, "admission.promote_l2", input.principal ?? "core", proposal.engagement_id, requestHash, json(normalized)));
                return normalized;
            };
            if (proposal.subject_type !== "finding" || proposal.content.kind !== "finding")
                throw new ContractValidationError("validation_error", "L2 promotion target must be a finding");
            if (proposal.status !== "admitted" || !proposal.canonical_id)
                throw new ContractValidationError("conflict", "finding must be admitted as L1 before L2 promotion");
            if (!input.policyDigest)
                throw new ContractValidationError("validation_error", "policy digest is required");
            if (input.targetId !== undefined && input.targetId !== proposal.canonical_id)
                throw new ContractValidationError("conflict", "promotion target is not the proposal's canonical finding");
            const current = (await this.get(proposal.canonical_id));
            if (!current || current.engagement_id !== proposal.engagement_id || current.kind !== "finding")
                throw new ContractValidationError("conflict", "canonical finding target is unavailable");
            if (current.version !== input.expectedBaseVersion || current.version !== proposal.canonical_version)
                throw new ContractValidationError("stale_version", "canonical finding version is stale");
            if (current.trust_level !== "L1")
                throw new ContractValidationError("conflict", "finding must be machine-approved before L2 promotion");
            if (input.inputHash !== undefined && input.inputHash !== proposal.content_hash)
                throw new ContractValidationError("conflict", "promotion proposal snapshot mismatch");
            const fixedEvidenceHash = (await this.evidenceSnapshotHash(proposal));
            if (input.evidenceSnapshotHash !== undefined && input.evidenceSnapshotHash !== fixedEvidenceHash)
                throw new ContractValidationError("stale_version", "promotion evidence snapshot is stale");
            if (input.reviewRefs && (input.reviewRefs.length === 0 || new Set(input.reviewRefs).size !== input.reviewRefs.length))
                throw new ContractValidationError("validation_error", "promotion requires distinct bound reviews");
            if (proposal.content.status && !["draft", "proposed"].includes(String(proposal.content.status)))
                return finalize((await this.rejectProposal(proposal, "finding has an illegal promotion state")));
            // Every hard gate is recomputed by the non-LLM policy engine. Advisory review
            // verdicts and caller-supplied trust fields never decide the outcome (tasks 1.1, 1.3).
            const decision = (await this.evaluateAdmission(proposalId, { policyDigest: input.policyDigest, policy: input.policy, now: input.now, reviewRefs: input.reviewRefs }));
            if (!decision.admitted) {
                const failed = decision.gates.filter((gate) => !gate.passed).map((gate) => gate.gate);
                const reason = `policy gate ${failed.join(",")} rejected promotion: ${decision.reasons.join("; ")}`;
                // A shortfall that only an additional independent review can repair leaves the
                // proposal pending: heterogeneous A/B review is a sequence, not one attempt.
                (await this.nextEvent("proposal.promotion_deferred", { reason, input_hash: proposal.content_hash, policy_digest: input.policyDigest, risk_class: decision.risk_class, gate_results: decision.gates }, proposalId));
                return finalize({ ok: false, reason, proposal, trust_phase: "machine_approved", policy_digest: input.policyDigest, policy_version: input.policy?.version ?? DEFAULT_ADMISSION_POLICY.version, remaining_l2_requirements: failed });
            }
            const reviewRows = (await this.sql.all("SELECT id,body FROM reviews WHERE proposal_id=? AND verdict='pass' AND input_hash=? ORDER BY created_at DESC", proposalId, proposal.content_hash)) as Array<{
                id: string;
                body: string;
            }>;
            const boundRows = reviewRows.filter((row) => !input.reviewRefs || input.reviewRefs.includes(row.id));
            if (input.reviewRefs && boundRows.length !== input.reviewRefs.length)
                throw new ContractValidationError("validation_error", "review_refs must reference passing reviews for this proposal");
            const reviewRow = boundRows.find((row) => (JSON.parse(row.body) as Record<string, unknown>).evidence_snapshot_hash === fixedEvidenceHash && (JSON.parse(row.body) as Record<string, unknown>).policy_digest === input.policyDigest);
            if (!reviewRow)
                return finalize((await this.rejectProposal(proposal, "independent review missing")));
            const review = JSON.parse(reviewRow.body!) as Record<string, unknown>;
            if (review.proposal_hash !== proposal.content_hash)
                return finalize((await this.rejectProposal(proposal, "review proposal snapshot mismatch")));
            const expectedEvidenceHash = (await this.evidenceSnapshotHash(proposal));
            if (review.evidence_snapshot_hash !== expectedEvidenceHash)
                return finalize((await this.rejectProposal(proposal, "review evidence snapshot mismatch")));
            if (review.policy_digest !== input.policyDigest)
                return finalize((await this.rejectProposal(proposal, "review policy digest mismatch")));
            const supportingReviewRefs = boundRows
                .filter((row) => (JSON.parse(row.body) as Record<string, unknown>).evidence_snapshot_hash === expectedEvidenceHash && (JSON.parse(row.body) as Record<string, unknown>).policy_digest === input.policyDigest)
                .map((row) => row.id);
            const record = (await this.commit({ ...proposal.content, id: current.id, review_ref: reviewRow.id, review_refs: supportingReviewRefs, risk_class: decision.risk_class, policy_digest: input.policyDigest, policy_version: input.policy?.version ?? DEFAULT_ADMISSION_POLICY.version, trust_phase: "independently_verified", status: "verified", provenance: { ...proposal.content.provenance, producer_id: input.principal ?? "taric-core", source_kind: "reviewer" } } as CanonicalRecord, "L2", undefined, undefined, false, input.expectedBaseVersion));
            (await this.sql.run("UPDATE proposals SET status='admitted' WHERE id=?", proposalId));
            (await this.nextEvent("proposal.promote_l2", { review_ref: reviewRow.id, review_refs: supportingReviewRefs, review_hash: review.review_hash, input_hash: proposal.content_hash, evidence_snapshot_hash: expectedEvidenceHash, policy_digest: input.policyDigest, risk_class: decision.risk_class, policy_version: input.policy?.version ?? DEFAULT_ADMISSION_POLICY.version, gate_results: decision.gates }, proposalId));
            return finalize({ ok: true, proposal: { ...proposal, status: "admitted" }, record, trust_phase: "independently_verified", policy_digest: input.policyDigest, policy_version: input.policy?.version ?? DEFAULT_ADMISSION_POLICY.version, remaining_l2_requirements: [] });
        }));
    }
    async compareAndSet(id: string, expectedVersion: number, patch: Record<string, unknown>, trustLevel?: TrustLevel): Promise<Awaited<CanonicalRecord>> {
        return (await this.transaction(async () => {
            const current = (await this.get(id));
            if (!current || current.version !== expectedVersion)
                throw new ContractValidationError("conflict", "version conflict");
            const privileged = ["version", "trust_level", "display_id", "commit_seq", "engagement_id"];
            if (privileged.some((field) => field in patch))
                throw new ContractValidationError("validation_error", "compare-and-set patch cannot set privileged fields");
            return (await this.commit({ ...current, ...patch, id, engagement_id: current.engagement_id, schema_version: SCHEMA_VERSION, display_id: current.display_id }, trustLevel ?? (current.trust_level ?? "L1"), `cas:${id}:${expectedVersion}:${hash(json(stablePayload(patch)))}`, undefined, true, expectedVersion));
        }));
    }
    async transitionRecall(subjectId: string, status: "stale" | "retracted" | "superseded" | "archived" | "expired", reason: string, options: {
        supersededBy?: string;
        reviewAfter?: string;
    } = {}): Promise<Awaited<CanonicalRecord>> {
        return (await this.transaction(async () => {
            const current = (await this.get(subjectId));
            if (!current)
                throw new ContractValidationError("conflict", `record not found: ${subjectId}`);
            if (!reason || typeof reason !== "string")
                throw new ContractValidationError("validation_error", "recall reason is required");
            if (options.supersededBy) {
                const replacement = (await this.get(options.supersededBy));
                if (!replacement || replacement.engagement_id !== current.engagement_id)
                    throw new ContractValidationError("validation_error", "superseded_by must reference a record in the same engagement");
            }
            const body: CanonicalRecord = { ...current, status, recall_excluded: true, recall_reason: reason, schema_version: SCHEMA_VERSION, display_id: current.display_id };
            if (options.supersededBy)
                body.superseded_by = options.supersededBy;
            if (options.reviewAfter)
                body.review_after = options.reviewAfter;
            const committed = (await this.commit(body, (current.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, Number(current.version)));
            (await this.nextEvent(`record.${status}`, { reason, before_hash: hash(json(current)), after_hash: hash(json(committed)), superseded_by: options.supersededBy, review_after: options.reviewAfter }, subjectId));
            return committed;
        }));
    }
    async markStale(subjectId: string, reason: string): Promise<Awaited<CanonicalRecord>> {
        return (await this.transitionRecall(subjectId, "stale", reason));
    }
    async retract(subjectId: string, reason: string): Promise<Awaited<CanonicalRecord>> { return (await this.transitionRecall(subjectId, "retracted", reason)); }
    async supersede(subjectId: string, supersededBy: string, reason: string): Promise<Awaited<CanonicalRecord>> { return (await this.transitionRecall(subjectId, "superseded", reason, { supersededBy })); }
    async archive(subjectId: string, reason: string): Promise<Awaited<CanonicalRecord>> { return (await this.transitionRecall(subjectId, "archived", reason)); }
    async expire(subjectId: string, reason = "record expired"): Promise<Awaited<CanonicalRecord>> { return (await this.transitionRecall(subjectId, "expired", reason)); }
    /**
     * Contradictory evidence is a revalidation event, never a silent overwrite.
     * The current view becomes inconclusive/stale while the previous observation
     * remains available through an as-of snapshot (task 2.3).
     */
    async contradict(subjectId: string, evidenceRefs: string[], reason = "contradictory evidence"): Promise<Awaited<CanonicalRecord>> {
        if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0)
            throw new ContractValidationError("validation_error", "contradiction requires evidence references");
        return (await this.transaction(async () => {
            const current = (await this.get(subjectId));
            if (!current)
                throw new ContractValidationError("conflict", "record not found: " + subjectId);
            const updated = (await this.commit({ ...current, status: "inconclusive", recall_excluded: true, recall_reason: reason, counter_evidence_refs: [...new Set([...(Array.isArray(current.counter_evidence_refs) ? current.counter_evidence_refs as string[] : []), ...evidenceRefs])], schema_version: SCHEMA_VERSION, display_id: current.display_id }, (current.trust_level as TrustLevel) ?? "L1", undefined, undefined, true, Number(current.version)));
            (await this.nextEvent("record.contradicted", { reason, counter_evidence_refs: evidenceRefs, before_hash: hash(json(current)), after_hash: hash(json(updated)) }, subjectId));
            const work = (await this.commit({ id: uuidv7(), engagement_id: current.engagement_id, kind: "work_item", title: "Revalidate " + String(current.display_id ?? subjectId), status: "queued", related_entity_ref: subjectId, acceptance_criteria: ["Resolve contradictory evidence", "Record updated evidence"], risk_class: String(current.risk_class ?? "medium"), provenance: { host_id: "taric-core", producer_id: "taric-core", source_kind: "host" } }, "L1"));
            (await this.nextEvent("record.revalidation_queued", { subject_ref: subjectId, work_item_id: work.id, counter_evidence_refs: evidenceRefs }, work.id));
            return updated;
        }));
    }
    /** 只读审计事件列表，供 doctor 与测试使用，不暴露数据库句柄。 */
    async events(): Promise<Awaited<AuditEvent[]>> {
        const rows = (await this.sql.all("SELECT commit_seq,event_id,event_type,subject_id,payload,prev_hash,hash,created_at FROM events ORDER BY commit_seq")) as Array<{
            commit_seq: number;
            event_id: string;
            event_type: string;
            subject_id: string | null;
            payload: string;
            prev_hash: string | null;
            hash: string;
            created_at: string;
        }>;
        return rows.map((row) => ({ commit_seq: row.commit_seq, event_id: row.event_id, event_type: row.event_type, subject_id: row.subject_id ?? undefined, payload: JSON.parse(row.payload) as Record<string, unknown>, prev_hash: row.prev_hash, hash: row.hash, created_at: row.created_at }));
    }
    async verifyAudit(): Promise<Awaited<{
        valid: boolean;
        errors: string[];
        read_seq: number;
        watermarks: {
            committed_seq: number;
            projected_seq: number;
        };
    }>> {
        return (await this.readTransaction(async () => {
            const events = (await this.sql.all("SELECT * FROM events ORDER BY commit_seq")) as any[];
            const errors: string[] = [];
            let prev: string | null = null;
            for (const [index, event] of events.entries()) {
                if (Number(event.commit_seq) !== index + 1)
                    errors.push(`event ${event.event_id}: sequence gap, expected ${index + 1}, found ${event.commit_seq}`);
                if (event.prev_hash !== prev)
                    errors.push(`event ${event.event_id}: previous hash mismatch`);
                try {
                    const expected = hash(json({ event_id: event.event_id, eventType: event.event_type, subjectId: event.subject_id ?? undefined, payload: JSON.parse(event.payload), prev_hash: event.prev_hash, created_at: event.created_at }));
                    if (event.hash !== expected)
                        errors.push(`event ${event.event_id}: hash mismatch`);
                }
                catch {
                    errors.push(`event ${event.event_id}: invalid payload JSON`);
                }
                prev = event.hash;
            }
            const sequence = Number(events.at(-1)?.commit_seq ?? 0);
            return { valid: errors.length === 0, errors, read_seq: sequence, watermarks: { committed_seq: sequence, projected_seq: (await this.projectedSequence()) } };
        }));
    }
}
