import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import { coreSchema, contractNames, SCHEMA_VERSION, type ContractName } from "@taric/schemas";

/** Shared JSON Schema validator used at Taric API boundaries. */
export const schemaValidator = new Ajv2020({ allErrors: true, strict: true });
schemaValidator.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
schemaValidator.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);

export function compileSchema<T>(schema: AnySchema): ValidateFunction<T> {
  return schemaValidator.compile<T>(schema);
}

export type ValidationCode = "validation_error" | "authorization_error" | "stale_version" | "unsupported_schema_version" | "conflict" | "idempotency_conflict" | "unsupported_capability" | "unavailable_host";

/**
 * Bounded diagnostics are deliberately a small public contract.  In
 * particular, they never contain Ajv's `data` field or arbitrary exception
 * objects.  Keep these limits low enough that an error can safely cross a
 * line-delimited transport without becoming a second payload channel.
 */
export const DIAGNOSTIC_LIMITS = Object.freeze({
  violations: 16,
  text: 256,
  params: 8,
  missing: 32,
});
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
export type DiagnosticDetails = ContractDiagnosticDetails | CompatibilityDiagnosticDetails;

function boundedText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : fallback;
  // Ajv messages are normally safe, but custom validators can echo data.  A
  // credential-shaped fragment is never useful as a public diagnostic.
  const redacted = text.replace(/((?:token|password|secret|credential|authorization|connection[_-]?string)\s*[=:]\s*)([^\s,;]+)/gi, "$1<redacted>");
  return redacted.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, DIAGNOSTIC_LIMITS.text) || fallback;
}

function safePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, DIAGNOSTIC_LIMITS.text);
  // Field names are useful, but credentials must not be reflected in a
  // remote error even when a schema uses a credential-shaped property name.
  return path.split("/").map((segment) => /(?:token|password|secret|credential|authorization|private[_-]?key)/i.test(segment) ? "<redacted>" : segment).join("/");
}

function safeParams(value: unknown): Readonly<Record<string, DiagnosticParameter>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, DiagnosticParameter> = {};
  const allowed = new Set(["missingProperty", "additionalProperty", "type", "format", "comparison", "limit", "exclusive", "pattern", "propertyName", "expected"]);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(output).length >= DIAGNOSTIC_LIMITS.params || !allowed.has(key)) continue;
    if (typeof item === "string") {
      if (/(?:token|password|secret|credential|authorization|private[_-]?key)/i.test(item)) output[key] = "<redacted>";
      else output[key] = item.slice(0, DIAGNOSTIC_LIMITS.text);
    } else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
    else if (typeof item === "boolean") output[key] = item;
  }
  return Object.keys(output).length ? Object.freeze(output) : undefined;
}

/** Normalize Ajv output without exposing submitted data or implementation fields. */
export function normalizeContractValidationDetails(contractName: string, errors: unknown): ContractDiagnosticDetails | undefined {
  if (!Array.isArray(errors)) return undefined;
  const violations: DiagnosticViolation[] = [];
  for (const error of errors.slice(0, DIAGNOSTIC_LIMITS.violations)) {
    if (!error || typeof error !== "object") continue;
    const item = error as Record<string, unknown>;
    const keyword = typeof item.keyword === "string" ? item.keyword.slice(0, DIAGNOSTIC_LIMITS.text) : "validation";
    const params = safeParams(item.params);
    violations.push({
      instance_path: safePath(item.instancePath ?? item.dataPath),
      keyword,
      ...(params ? { params } : {}),
      message: boundedText(item.message, `${keyword} constraint failed`),
    });
  }
  if (!violations.length) return undefined;
  return Object.freeze({ kind: "contract", contract_name: boundedText(contractName, "unknown"), violations: Object.freeze(violations) });
}

/** Compatibility details are also bounded so drivers can safely pass them to transports. */
export function compatibilityDiagnosticDetails(input: {
  backend: CompatibilityDiagnosticDetails["backend"];
  expected: Record<string, unknown>;
  observed?: Record<string, unknown>;
  failed_marker?: string;
  missing?: readonly string[];
}): CompatibilityDiagnosticDetails {
  const normalizeMap = (value: Record<string, unknown> | undefined): Readonly<Record<string, string>> | undefined => {
    if (!value) return undefined;
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.keys(result).length >= DIAGNOSTIC_LIMITS.params || typeof item === "object" || typeof item === "function") continue;
      const text = String(item);
      result[key.slice(0, DIAGNOSTIC_LIMITS.text)] = /(?:token|password|secret|credential|authorization|connection[_-]?string)/i.test(key) || /(?:token|password|secret|credential|authorization|postgres(?:ql)?:\/\/|:\/\/)/i.test(text)
        ? "<redacted>"
        : text.slice(0, DIAGNOSTIC_LIMITS.text);
    }
    return Object.freeze(result);
  };
  const missing = input.missing?.filter((item): item is string => typeof item === "string").slice(0, DIAGNOSTIC_LIMITS.missing).map((item) => /(?:token|password|secret|credential|authorization|private[_-]?key)/i.test(item) ? "<redacted>" : item.slice(0, DIAGNOSTIC_LIMITS.text));
  return Object.freeze({
    kind: "compatibility",
    backend: input.backend,
    expected: normalizeMap(input.expected) ?? Object.freeze({}),
    ...(normalizeMap(input.observed) ? { observed: normalizeMap(input.observed) } : {}),
    ...(input.failed_marker ? { failed_marker: boundedText(input.failed_marker, "compatibility") } : {}),
    ...(missing?.length ? { missing: Object.freeze(missing) } : {}),
  });
}

/** Keep only diagnostics created by the normalizers above at a service boundary. */
export function normalizeDiagnosticDetails(details: unknown, contractName?: string): DiagnosticDetails | undefined {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const value = details as Record<string, unknown>;
    if (value.kind === "contract" && typeof value.contract_name === "string" && Array.isArray(value.violations)) {
      const violations = value.violations.map((item) => {
        if (!item || typeof item !== "object") return item;
        const violation = item as Record<string, unknown>;
        return { instancePath: violation.instance_path, keyword: violation.keyword, params: violation.params, message: violation.message };
      });
      return normalizeContractValidationDetails(value.contract_name, violations);
    }
    if (value.kind === "compatibility" && (value.backend === "sqlite" || value.backend === "postgresql" || value.backend === "unknown") && value.expected && typeof value.expected === "object") {
      return compatibilityDiagnosticDetails({
        backend: value.backend,
        expected: value.expected as Record<string, unknown>,
        observed: value.observed && typeof value.observed === "object" ? value.observed as Record<string, unknown> : undefined,
        failed_marker: typeof value.failed_marker === "string" ? value.failed_marker : undefined,
        missing: Array.isArray(value.missing) ? value.missing.filter((item): item is string => typeof item === "string") : undefined,
      });
    }
  }
  return contractName ? normalizeContractValidationDetails(contractName, details) : undefined;
}

/** Public alias used by adapters that do not need to know the validator library. */
export const normalizeValidationErrors = normalizeContractValidationDetails;

export class ContractValidationError extends Error {
  readonly code: ValidationCode;
  readonly details: unknown;
  constructor(code: ValidationCode, message: string, details?: unknown) {
    super(message);
    this.name = "ContractValidationError";
    this.code = code;
    this.details = details;
  }
}

const validators = new Map<ContractName, ValidateFunction>();
const contractSchemaValidator = new Ajv2020({ allErrors: true, strict: true });
contractSchemaValidator.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
contractSchemaValidator.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
contractSchemaValidator.addSchema(coreSchema);
for (const name of contractNames) {
  const validator = contractSchemaValidator.getSchema(`${coreSchema.$id}#/$defs/${name}`);
  if (validator) validators.set(name, validator);
}

export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const proposalSubjectContracts: Readonly<Record<string, ContractName>> = Object.freeze({
  scope: "scope", resource: "resource", resource_revision: "resourceRevision", observation: "observation", relation: "relation", claim: "claim", test_hypothesis: "testHypothesis", attack_path: "attackPath", work_item: "workItem", evidence: "evidence", finding: "finding", coverage: "coverageCell", coverage_cell: "coverageCell", negative_observation: "negativeObservation", protective_control: "protectiveControl", protective_control_revision: "protectiveControlRevision", control_observation: "controlObservation", access_decision_observation: "accessDecisionObservation", checkpoint: "checkpoint", action_intent: "actionIntent", action_recommendation: "actionIntent",
});
const candidateValidator = contractSchemaValidator.getSchema(`${coreSchema.$id}#/$defs/proposalCandidate`)!;
const envelopeValidator = contractSchemaValidator.getSchema(`${coreSchema.$id}#/$defs/proposalEnvelope`)!;

/** Validate untrusted proposal data without manufacturing a canonical identity. */
export function validateProposalEnvelope(value: unknown): void {
  const envelope = value as Record<string, unknown> | undefined;
  const content = envelope?.content as Record<string, unknown> | undefined;
  if (content?.schema_version !== SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "proposal schema version is not supported", {
    kind: "contract", contract_name: "proposalEnvelope",
    violations: Object.freeze([{ instance_path: "/content/schema_version", keyword: "const", params: Object.freeze({ expected: SCHEMA_VERSION }), message: "schema version is not supported" }]),
  } satisfies ContractDiagnosticDetails);
  if (!envelopeValidator(value)) throw new ContractValidationError("validation_error", "invalid proposal envelope", normalizeContractValidationDetails("proposalEnvelope", envelopeValidator.errors));
  if (envelope!.target_id !== undefined && envelope!.subject_ref !== undefined && envelope!.target_id !== envelope!.subject_ref) throw new ContractValidationError("validation_error", "proposal target_id and subject_ref must agree");
  const target = envelope!.target_id ?? envelope!.subject_ref;
  if ((Number(envelope!.expected_version) > 0) !== (target !== undefined)) throw new ContractValidationError("validation_error", "updates require an explicit target and positive expected_version; creates require expected_version zero");
  if (content!.engagement_id !== envelope!.engagement_id) throw new ContractValidationError("validation_error", "proposal content must belong to the proposal engagement");
  validateProposalCandidate(String(envelope!.subject_type), content!);
}

/** Reuse the canonical domain schema for candidate shape, with writer metadata
 * substituted only in this temporary validation object. Evidence and review
 * availability are deliberately left to the separate L2 hard gates. */
export function validateProposalCandidate(subjectType: string, content: Record<string, unknown>): void {
  if (!candidateValidator(content)) throw new ContractValidationError("validation_error", "proposal contains privileged fields or an invalid candidate shape", normalizeContractValidationDetails("proposalCandidate", candidateValidator.errors));
  const expectedKind = subjectType === "action_recommendation" ? "action_intent" : subjectType;
  if (content.kind !== expectedKind) throw new ContractValidationError("validation_error", "proposal subject_type must match explicit candidate kind");
  const contract = proposalSubjectContracts[subjectType];
  if (!contract) throw new ContractValidationError("validation_error", "unsupported proposal subject type");
  if (content.kind === "finding" && content.status !== "draft") throw new ContractValidationError("validation_error", "finding candidates must remain draft until L2 promotion");
  if (content.status === "verified" || content.status === "supported") throw new ContractValidationError("validation_error", "proposal cannot assert a verified status");
  const canonical = {
    created_at: new Date().toISOString(),
    ...content,
    id: "00000000-0000-7000-8000-000000000000",
    provenance: { ...(content.provenance as Record<string, unknown> ?? { host_id: "taric-core", producer_id: "taric-core" }), source_kind: "host" },
  };
  validateContract(contract, canonical);
}

/**
 * 参考类型 -> 必须指向的记录 kind。用于阻止跨种类引用（例如把 WorkItem 当 Evidence 用）。
 * 未列出的字段不做种类推断，保持 Phase 1 的最小契约。
 */
export const referenceKinds: Readonly<Record<string, readonly string[]>> = Object.freeze({
  scope_ref: ["scope", "engagement"],
  applicable_scope_ref: ["scope"],
  resource_ref: ["resource", "endpoint", "service", "note"],
  resource_revision_ref: ["resource_revision"],
  resource_revision_refs: ["resource_revision"],
  supersedes: ["resource_revision", "protective_control_revision"],
  current_revision_ref: ["protective_control_revision"],
  control_revision_ref: ["protective_control_revision"],
  control_revision_refs: ["protective_control_revision"],
  protected_resource_revision_refs: ["resource_revision"],
  authentication_session_revision_ref: ["resource_revision", "note"],
  principal_ref: ["resource", "note", "endpoint", "service"],
  tenant_ref: ["resource", "note", "endpoint", "service"],
  identity_ref: ["resource", "note", "endpoint", "service"],
  tested_resource_refs: ["resource", "endpoint", "service", "note"],
  resource_refs: ["resource", "resource_revision", "service", "endpoint"],
  baseline_ref: ["resource", "observation", "claim", "endpoint", "service", "note"],
  from_ref: ["resource", "resource_revision", "relation", "claim", "test_hypothesis", "attack_path", "work_item", "evidence", "observation", "finding", "coverage", "protective_control", "protective_control_revision", "control_observation", "access_decision_observation", "service", "endpoint"],
  to_ref: ["resource", "resource_revision", "relation", "claim", "test_hypothesis", "attack_path", "work_item", "evidence", "observation", "finding", "coverage", "protective_control", "protective_control_revision", "control_observation", "access_decision_observation", "service", "endpoint"],
  claim_refs: ["claim"],
  coverage_refs: ["coverage"],
  observation_refs: ["observation"],
  source_observation_refs: ["observation"],
  source_refs: ["observation", "evidence", "patch_set", "claim", "resource_revision", "relation", "resource", "test_hypothesis", "attack_path", "work_item", "finding", "coverage", "protective_control", "protective_control_revision", "control_observation", "access_decision_observation", "checkpoint", "action_intent"],
  evidence_refs: ["evidence", "observation", "coverage", "note"],
  counter_evidence_refs: ["evidence", "observation"],
  work_item_ref: ["work_item"],
  depends_on: ["work_item", "resource_revision", "relation", "claim", "test_hypothesis", "attack_path", "finding", "coverage", "protective_control_revision"],
  attempt_ref: ["attempt", "work_run"],
  work_run_ref: ["work_run"],
  control_ref: ["protective_control", "control_observation", "note"],
  subject_ref: ["resource", "resource_revision", "relation", "claim", "test_hypothesis", "attack_path", "work_item", "finding", "coverage", "protective_control", "protective_control_revision", "control_observation", "access_decision_observation"],
  changed_dependency_ref: ["resource", "resource_revision", "relation", "claim", "test_hypothesis", "attack_path", "protective_control", "protective_control_revision", "access_decision_observation"],
  affected_refs: ["resource_revision", "relation", "claim", "test_hypothesis", "work_item", "coverage", "checkpoint", "finding", "attack_path", "action_intent"],
  affected_current_view_refs: ["claim", "test_hypothesis", "work_item", "coverage", "checkpoint", "finding", "attack_path", "action_intent"],
  subject_refs: ["observation", "checkpoint", "control_observation", "access_decision_observation", "claim", "test_hypothesis", "work_item", "coverage", "finding", "attack_path", "action_intent", "resource", "resource_revision", "protective_control", "protective_control_revision"],
  patch_ref: ["patch_set"],
  resolution_ref: ["conflict", "review", "claim", "relation"],
  entity_ref: ["resource", "resource_revision", "relation", "claim", "test_hypothesis", "attack_path", "work_item", "evidence", "observation", "finding", "coverage", "protective_control", "protective_control_revision"],
  source_ref: ["resource", "resource_revision", "relation", "claim", "test_hypothesis", "attack_path", "observation", "patch_set", "protective_control_revision"],
  read_set: [],
  write_set: [],
  steps: [],
  candidates: [],
  control_observation_ref: ["control_observation"],
  review_ref: ["review", "review_record"],
  draft_refs: [],
  handoff_refs: [],
  action_refs: ["action_intent"],
  memory_refs: [],
});

/** 引用字段名 -> 该字段的合法状态取值集合，用于阻止引用已撤回/归档的历史对象。 */
const referenceMustBeCurrent = true;
const nonCurrentRecallStatuses = new Set(["stale", "retracted", "superseded", "archived", "expired"]);

export interface AuthorityReferenceIndex {
  /** id -> 该 id 的归属 Engagement。 */
  engagement: ReadonlyMap<string, string>;
  /** id -> 该 id 的记录 kind。 */
  kind: ReadonlyMap<string, string>;
  /** id -> 该 id 当前的 recall 状态（可选；缺失视为 active）。 */
  status?: ReadonlyMap<string, string>;
}

function referenceFields(record: Record<string, unknown>): Array<[string, string]> {
  const refs: Array<[string, string]> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [field, nested] of Object.entries(value)) {
      if (field in referenceKinds) {
        if (typeof nested === "string") refs.push([field, nested]);
        else if (Array.isArray(nested)) for (const item of nested) if (typeof item === "string") refs.push([field, item]);
      }
      if (nested && typeof nested === "object") visit(nested);
    }
  };
  visit(record);
  return refs;
}

/** Return the distinct authority ids referenced by a candidate. Store callers use
 * this to build a bounded index for one proposal instead of scanning all rows. */
export function authorityReferenceIds(record: Record<string, unknown>): string[] {
  return [...new Set(referenceFields(record).map(([, ref]) => ref))];
}

/**
 * 跨引用校验：归属、种类和 recall 状态。Core store 在同一事务里用真实索引调用它，
 * 所以缺失引用、跨 Engagement 引用和指向已撤回对象的引用都会 fail closed。
 */
export function validateAuthorityReferences(record: Record<string, unknown>, index: AuthorityReferenceIndex, engagementId: string): void {
  for (const [field, ref] of referenceFields(record)) {
    const owner = index.engagement.get(ref);
    if (!owner) throw new ContractValidationError("validation_error", `invalid or cross-engagement reference: ${ref}`);
    if (owner !== engagementId) throw new ContractValidationError("validation_error", `invalid or cross-engagement reference: ${ref}`);
    const expected = referenceKinds[field];
    const actual = index.kind.get(ref);
    if (expected && actual && !expected.includes(actual)) {
      throw new ContractValidationError("validation_error", `reference kind mismatch for ${field}: ${ref} is ${actual}, expected ${expected.join("|")}`);
    }
    if (referenceMustBeCurrent && index.status) {
      const status = index.status.get(ref);
      if (status && nonCurrentRecallStatuses.has(status)) {
        throw new ContractValidationError("validation_error", `reference ${field}: ${ref} is ${status} and cannot anchor current state`);
      }
    }
  }
  if (record.kind === "relation") {
    for (const endpoint of ["from", "to"] as const) {
      const ref = record[`${endpoint}_ref`];
      const declaredKind = record[`${endpoint}_type`];
      if (typeof ref !== "string" || typeof declaredKind !== "string") continue;
      const actualKind = index.kind.get(ref);
      if (actualKind && actualKind !== declaredKind) {
        throw new ContractValidationError("validation_error", `relation ${endpoint} type does not match its referenced record`);
      }
    }
  }
}

/** 校验 Phase 1 合同，并执行跨字段安全约束。 */
export function validateContract(name: ContractName, value: unknown): asserts value {
  if (!value || typeof value !== "object") throw new ContractValidationError("validation_error", `${name} must be an object`, {
    kind: "contract", contract_name: name, violations: Object.freeze([{ instance_path: "", keyword: "type", params: Object.freeze({ type: "object" }), message: `${name} must be an object` }]),
  } satisfies ContractDiagnosticDetails);
  const candidate = value as Record<string, unknown>;
  const versioned = !["proposalEnvelope", "proposalProvenance", "promotionL2", "apiSuccess", "apiError", "auditEvent"].includes(name) && !name.startsWith("artifact");
  if (versioned && candidate.schema_version !== SCHEMA_VERSION) {
    throw new ContractValidationError("unsupported_schema_version", `unsupported schema version for ${name}`, {
      kind: "contract", contract_name: name,
      violations: Object.freeze([{
        instance_path: "/schema_version", keyword: "const",
        params: Object.freeze({ expected: SCHEMA_VERSION }),
        message: "schema version is not supported",
      }]),
    } satisfies ContractDiagnosticDetails);
  }
  const validate = validators.get(name);
  if (validate && !validate(value)) throw new ContractValidationError("validation_error", `invalid ${name} contract`, normalizeContractValidationDetails(name, validate.errors));
  if (name === "proposalEnvelope") { validateProposalEnvelope(value); return; }
  if (name === "proposalCandidate" || name === "proposalProvenance" || name === "promotionL2" || name === "apiSuccess" || name === "apiError" || name === "auditEvent" || name.startsWith("artifact")) return;
  validateCanonicalRecord(candidate);
}

/**
 * 跨字段安全护栏：对每一条进入权威的记录执行，不依赖调用方是否声明 schema_version。
 * 这些规则覆盖归属、时间范围、信任迁移、证据限制与 control/origin 语义。
 */
export function validateCanonicalRecord(candidate: Record<string, unknown>, trustLevel?: string): void {
  if (!UUID_V7_PATTERN.test(String(candidate.id ?? "")) || !UUID_V7_PATTERN.test(String(candidate.engagement_id ?? ""))) {
    throw new ContractValidationError("validation_error", "canonical identity and engagement_id must be UUIDv7");
  }
  if (candidate.engagement_id === undefined || typeof candidate.engagement_id !== "string" || candidate.engagement_id.length === 0) {
    throw new ContractValidationError("validation_error", "engagement ownership is required");
  }
  if ("valid_from" in candidate && "valid_until" in candidate && Date.parse(String(candidate.valid_from)) > Date.parse(String(candidate.valid_until))) {
    throw new ContractValidationError("validation_error", "valid_from must not be after valid_until");
  }
  for (const field of ["valid_from", "valid_until", "committed_at", "created_at", "updated_at", "observed_at", "tested_at", "expires_at", "lease_expires_at", "heartbeat_at", "started_at", "ended_at", "recorded_at"]) {
    if (candidate[field] !== undefined && (typeof candidate[field] !== "string" || Number.isNaN(Date.parse(candidate[field] as string)))) {
      throw new ContractValidationError("validation_error", `${field} must be an ISO timestamp`);
    }
  }
  if (candidate.created_at !== undefined && typeof candidate.created_at !== "string") {
    throw new ContractValidationError("validation_error", "created_at must be a timestamp string");
  }
  const provenance = candidate.provenance as Record<string, unknown> | undefined;
  if (provenance !== undefined) {
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) throw new ContractValidationError("validation_error", "provenance must be an object");
    if (typeof provenance.host_id !== "string" || typeof provenance.producer_id !== "string" || typeof provenance.source_kind !== "string") {
      throw new ContractValidationError("validation_error", "provenance requires host_id, producer_id and source_kind");
    }
    if (["L1", "L2"].includes(trustLevel ?? "") && provenance.source_kind === "worker") {
      throw new ContractValidationError("validation_error", "worker provenance cannot assert machine-approved or verified trust");
    }
  }
  if (candidate.trust_level === "L2" && provenance?.source_kind === "worker") {
    throw new ContractValidationError("validation_error", "worker input cannot self-assert L2 trust");
  }
  // 证据限制：声称有证据却没有 evidence 引用属于不可验证的断言。
  for (const field of ["evidence_refs", "observation_refs"] as const) {
    const refs = candidate[field];
    if (refs !== undefined && (!Array.isArray(refs) || refs.some((item) => typeof item !== "string"))) {
      throw new ContractValidationError("validation_error", `${field} must be an array of identifiers`);
    }
  }
  if (candidate.evidence_claimed === true && !(candidate.evidence_refs as unknown[] | undefined)?.length) {
    throw new ContractValidationError("validation_error", "evidence_claimed requires evidence references");
  }
  const status = String(candidate.status ?? "");
  if (["retracted", "superseded", "archived", "stale", "expired"].includes(status) && candidate.recall_excluded !== true) {
    throw new ContractValidationError("validation_error", `status ${status} must be excluded from current recall`);
  }
  if (candidate.decision_layer === "unknown" && candidate.origin_outcome && candidate.origin_outcome !== "unknown") {
    throw new ContractValidationError("validation_error", "unknown decision layer cannot carry a resolved origin outcome");
  }
  if (candidate.origin_reached === false && candidate.origin_outcome && !["unknown", "not_reached"].includes(String(candidate.origin_outcome))) {
    throw new ContractValidationError("validation_error", "unreached origin cannot carry a resolved reached outcome");
  }
  validateTrustTransition(candidate, trustLevel);
  validateScopeBounds(candidate);
  validateEvidenceLimitations(candidate);
  validateDecisionSemantics(candidate);
  // Checkpoint completeness is enforced by the host-only commit path, where
  // the active Attempt/lease is available. Generic record commits may retain
  // a lightweight checkpoint summary for context projections.
  if (candidate.kind !== "checkpoint" || candidate.attempt_ref !== undefined || candidate.source_read_seq !== undefined) validateStateSemantics(candidate);
}

function validateStateSemantics(candidate: Record<string, unknown>): void {
  const workStatuses = ["queued", "claimed", "running", "in_progress", "checkpointed", "blocked", "completed", "failed", "cancelled", "lost"];
  const attemptStatuses = ["claimed", "running", "checkpointed", "blocked", "completed", "failed", "cancelled", "lost"];
  const actionStatuses = ["recommended", "authorized", "denied", "executed", "failed", "unknown", "late_result_quarantine"];
  if (candidate.kind === "work_run" && (!workStatuses.includes(String(candidate.status)) || !Number.isInteger(candidate.generation) || Number(candidate.generation) < 1)) {
    throw new ContractValidationError("validation_error", "work run has an invalid status or generation");
  }
  if (candidate.kind === "attempt" && (!attemptStatuses.includes(String(candidate.status)) || !Number.isInteger(candidate.generation) || Number(candidate.generation) < 1)) {
    throw new ContractValidationError("validation_error", "attempt has an invalid status or generation");
  }
  if (candidate.kind === "action_intent" && !actionStatuses.includes(String(candidate.status))) {
    throw new ContractValidationError("validation_error", "action intent has an invalid status");
  }
  if (candidate.kind === "checkpoint") {
    if (!Number.isInteger(candidate.source_read_seq) || Number(candidate.source_read_seq) < 0) throw new ContractValidationError("validation_error", "checkpoint source_read_seq is required");
    for (const field of ["completed_steps", "next_steps", "observation_refs", "evidence_refs", "negative_results", "unresolved_work", "host_decision_refs"]) {
      if (!Array.isArray(candidate[field]) || (candidate[field] as unknown[]).some((item) => typeof item !== "string")) throw new ContractValidationError("validation_error", `checkpoint ${field} must be a string array`);
    }
    if (typeof candidate.external_action_state !== "string") throw new ContractValidationError("validation_error", "checkpoint external_action_state is required");
    if ("hidden_reasoning" in candidate || "chain_of_thought" in candidate || "private_reasoning" in candidate) throw new ContractValidationError("validation_error", "checkpoint cannot contain hidden reasoning");
  }
  if (candidate.kind === "action_intent" && ["authorized", "executed", "failed", "unknown"].includes(String(candidate.status)) && !candidate.mode) {
    throw new ContractValidationError("validation_error", "action mode is required for host action outcomes");
  }
}

/**
 * 信任迁移（tasks 2.2）。信任只能由 Core 的确定性流程提升：proposal -> L1 需要
 * admission/policy 证据，L1 -> L2 需要独立 review 引用。worker/model 来源永远不能
 * 自行断言 L1/L2。
 */
function validateTrustTransition(candidate: Record<string, unknown>, trustLevel?: string): void {
  const declared = typeof candidate.trust_level === "string" ? candidate.trust_level : undefined;
  if (trustLevel && declared && trustLevel !== declared) {
    throw new ContractValidationError("validation_error", "trust level does not match the writer-assigned trust level");
  }
  const effective = trustLevel ?? declared;
  if (!effective) return;
  const provenance = candidate.provenance as Record<string, unknown> | undefined;
  // L1/L2 是 writer 的结论，worker 或 model 来源只能产生 L0 proposal。
  if (["L1", "L2"].includes(effective) && provenance?.source_kind === "worker") {
    throw new ContractValidationError("validation_error", "worker provenance cannot assert machine-approved or verified trust");
  }
  // 已验证状态的记录必须能追溯到独立复核与 policy。L1 候选线索本身不要求复核，
  // 真正的 L2 晋级硬门在 promoteFinding/admission 路径上执行。
  if (["verified", "supported"].includes(String(candidate.status ?? "")) && effective === "L2") {
    if (!candidate.review_ref) {
      throw new ContractValidationError("validation_error", "L2 verified records require a bound independent review reference");
    }
    if (candidate.policy_digest === undefined) {
      throw new ContractValidationError("validation_error", "L2 verified records require the policy digest that admitted them");
    }
  }
}

/** Scope 边界（tasks 2.2）：目标必须落在 allowed_targets 内，且不得命中 excluded_targets。 */
function validateScopeBounds(candidate: Record<string, unknown>): void {
  const allowed = candidate.allowed_targets;
  const excluded = candidate.excluded_targets;
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some((item) => typeof item !== "string"))) {
    throw new ContractValidationError("validation_error", "allowed_targets must be an array of strings");
  }
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.some((item) => typeof item !== "string"))) {
    throw new ContractValidationError("validation_error", "excluded_targets must be an array of strings");
  }
  if (Array.isArray(allowed) && Array.isArray(excluded)) {
    for (const target of allowed) {
      if (excluded.includes(target)) {
        throw new ContractValidationError("validation_error", `scope target is both allowed and excluded: ${target}`);
      }
    }
  }
}

/**
 * 证据限制（tasks 2.2）。声称 verified/positive 的结论必须同时携带 evidence 与
 * limitations；否则它无法被复核，属于不可验证断言。
 */
function validateEvidenceLimitations(candidate: Record<string, unknown>): void {
  const evidence = candidate.evidence_refs;
  if (evidence !== undefined && (!Array.isArray(evidence) || evidence.some((item) => typeof item !== "string"))) {
    throw new ContractValidationError("validation_error", "evidence_refs must be an array of identifiers");
  }
  const limitations = candidate.limitations;
  if (limitations !== undefined && (!Array.isArray(limitations) || limitations.some((item) => typeof item !== "string"))) {
    throw new ContractValidationError("validation_error", "limitations must be an array of strings");
  }
  const status = String(candidate.status ?? "");
  if (["verified", "supported"].includes(status)) {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new ContractValidationError("validation_error", `${status} claims require evidence references`);
    }
    if (!Array.isArray(limitations) || limitations.length === 0) {
      throw new ContractValidationError("validation_error", `${status} claims require explicit limitations`);
    }
  }
  // Finding 进入 verified 必须绑定 review 与 policy，这两条与 L2 迁移规则一致。
  if (candidate.kind === "finding" && status === "verified" && (!candidate.review_ref || candidate.policy_digest === undefined)) {
    throw new ContractValidationError("validation_error", "verified findings require a review reference and policy digest");
  }
}

/**
 * decision_layer / origin_reached / origin_outcome 三元组必须自洽（tasks 2.2）。
 * unknown 层不能声称具体控制，edge 未达源站必须是 not_reached，指纹归因只能是 suspected。
 */
function validateDecisionSemantics(candidate: Record<string, unknown>): void {
  const layer = candidate.decision_layer;
  const outcome = candidate.origin_outcome;
  const reached = candidate.origin_reached;
  if (layer !== undefined && !["edge", "network", "origin", "unknown"].includes(String(layer))) {
    throw new ContractValidationError("validation_error", "unknown decision layer value");
  }
  if (outcome !== undefined && !["reached", "not_reached", "unknown"].includes(String(outcome))) {
    throw new ContractValidationError("validation_error", "unknown origin outcome value");
  }
  if (layer === "unknown" && (candidate.control_ref || candidate.control_revision_ref || (Array.isArray(candidate.control_revision_refs) && candidate.control_revision_refs.length > 0))) {
    throw new ContractValidationError("validation_error", "unknown decision layer cannot name a specific control");
  }
  if ((layer === "edge" || layer === "network") && reached === false && outcome !== undefined && outcome !== "not_reached") {
    throw new ContractValidationError("validation_error", "edge or network block before origin must use origin_outcome=not_reached");
  }
  if (candidate.fingerprint && candidate.outcome !== undefined && candidate.outcome !== "suspected") {
    throw new ContractValidationError("validation_error", "fingerprint attribution is only ever suspected");
  }
  // blocked_by_control 绝不能声称已到达源站。
  if (candidate.status === "blocked_by_control" && reached === true) {
    throw new ContractValidationError("validation_error", "blocked_by_control cannot claim origin_reached=true");
  }
  if (reached === true && (!Array.isArray(candidate.evidence_refs) || candidate.evidence_refs.length === 0)) {
    throw new ContractValidationError("validation_error", "origin_reached=true requires evidence references");
  }
}

export function validationErrors(name: ContractName, value: unknown): unknown[] {
  const validate = validators.get(name);
  if (!validate || validate(value)) return [];
  return validate.errors ?? [];
}
