import { createHash } from "node:crypto";
import type { CanonicalRecord } from "./store.js";

/**
 * Non-LLM admission policy (design §2, §5, §10).
 *
 * Auditor output is advisory only. Every hard gate below is recomputed from the
 * subject, its pinned evidence snapshot and the bound review records, so a model
 * verdict, an `accept: true` payload or a caller-declared trust level cannot move
 * the result.
 */

export const ADMISSION_POLICY_VERSION = "1.0.0" as const;

export type RiskClass = "informational" | "low" | "medium" | "high" | "critical";
export type HardGateName = "schema" | "scope" | "evidence" | "freshness" | "independence";
export type ReviewerCapability = "deterministic" | "model" | "human";
export type ReviewVerdict = "pass" | "reject" | "needs_evidence" | "defer";

export const RISK_CLASSES: readonly RiskClass[] = ["informational", "low", "medium", "high", "critical"];
export const HARD_GATES: readonly HardGateName[] = ["schema", "scope", "evidence", "freshness", "independence"];

export interface RiskProfile {
  risk_class: RiskClass;
  /** Independent `pass` reviews required before L2 promotion. */
  min_independent_reviews: number;
  /** When set, reviewers must differ in model, prompt, ruleset or be human. */
  strong_independence: boolean;
  /** Maximum accepted age of supporting evidence, in days. `null` disables the check. */
  max_evidence_age_days: number | null;
}

export interface AdmissionPolicy {
  policy_id: string;
  version: string;
  risk_profiles: Readonly<Record<RiskClass, RiskProfile>>;
  hard_gates: readonly HardGateName[];
  /** 归纳类 subject 的证据来源角色白名单（键为 subject kind）；缺省不启用，行为与 digest 均不变。 */
  derived_subject_evidence_roles?: Partial<Record<string, ReadonlyArray<"host" | "operator">>>;
}

/** Review record bound to a proposal. Only `pass` records feed the independence gate. */
export interface AdmissionReview {
  review_id: string;
  reviewer_id: string;
  reviewer_kind: ReviewerCapability;
  verdict: ReviewVerdict;
  input_hash: string;
  evidence_snapshot_hash: string;
  policy_digest: string;
  reviewer_model?: string;
  prompt_digest?: string;
  ruleset_digest?: string;
}

/** Evidence pinned by id and version at review time. */
export interface PinnedEvidence {
  id: string;
  version: number;
  observed_at?: string;
  status?: string;
  /** 被引记录的 provenance.source_kind；缺失在启用来源门时按不可信处理。 */
  origin?: string;
}

export interface AdmissionSubject {
  id: string;
  kind: string;
  author_ids?: string[];
  worker_ids?: string[];
  claim_refs?: string[];
  evidence_refs?: string[];
  counter_evidence_refs?: string[];
  applicable_scope_ref?: string;
  allowed_targets?: string[];
  excluded_targets?: string[];
  target?: string;
  reproducibility?: string;
  limitations?: string[];
  review_after?: string;
  expires_at?: string;
  risk_class?: RiskClass;
}

export interface AdmissionInput {
  subject: AdmissionSubject;
  policy: AdmissionPolicy;
  policy_digest: string;
  evidence: readonly PinnedEvidence[];
  reviews: readonly AdmissionReview[];
  input_hash: string;
  evidence_snapshot_hash: string;
  now?: string;
}

export interface GateResult { gate: HardGateName; passed: boolean; reasons: string[] }

export interface AdmissionDecision {
  /** L2 policy hard gates passed; L1 structural admission is separate. */
  admitted: boolean;
  /** L2 promotion: every hard gate including independence is satisfied. */
  promotable: boolean;
  risk_class: RiskClass;
  policy_digest: string;
  gates: GateResult[];
  reasons: string[];
}

const DAY_MS = 86_400_000;
const NON_CURRENT_EVIDENCE = new Set(["stale", "retracted", "superseded", "archived", "expired", "contradicted"]);

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  policy_id: "taric-admission",
  version: ADMISSION_POLICY_VERSION,
  hard_gates: HARD_GATES,
  risk_profiles: {
    informational: { risk_class: "informational", min_independent_reviews: 1, strong_independence: false, max_evidence_age_days: null },
    low: { risk_class: "low", min_independent_reviews: 1, strong_independence: false, max_evidence_age_days: 180 },
    medium: { risk_class: "medium", min_independent_reviews: 1, strong_independence: false, max_evidence_age_days: 90 },
    high: { risk_class: "high", min_independent_reviews: 2, strong_independence: true, max_evidence_age_days: 30 },
    critical: { risk_class: "critical", min_independent_reviews: 2, strong_independence: true, max_evidence_age_days: 14 },
  },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Content digest of a policy. Rules upgrades are versioned by this digest. */
export function policyDigest(policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY): string {
  // 新字段仅在显式配置时纳入 canonical 集：缺省时 digest 与历史基线逐字节一致。
  return `sha256:${createHash("sha256").update(canonical({
    policy_id: policy.policy_id,
    version: policy.version,
    hard_gates: [...policy.hard_gates],
    risk_profiles: policy.risk_profiles,
    ...(policy.derived_subject_evidence_roles ? { derived_subject_evidence_roles: policy.derived_subject_evidence_roles } : {}),
  })).digest("hex")}`;
}

export function riskProfile(policy: AdmissionPolicy, risk: RiskClass | undefined): RiskProfile {
  return policy.risk_profiles[risk ?? "medium"] ?? policy.risk_profiles.medium;
}

export function riskClassOf(record: Record<string, unknown>): RiskClass {
  const declared = String(record.risk_class ?? "medium");
  return (RISK_CLASSES as readonly string[]).includes(declared) ? declared as RiskClass : "medium";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Deterministic hard gates. Advisory verdicts never reach this function as authority. */
export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  const { subject, policy } = input;
  const profile = riskProfile(policy, subject.risk_class);
  const now = Date.parse(input.now ?? new Date().toISOString());
  const reasons: string[] = [];
  const gates: GateResult[] = [];
  const gate = (name: HardGateName, gateReasons: string[]): void => {
    gates.push({ gate: name, passed: gateReasons.length === 0, reasons: gateReasons });
    reasons.push(...gateReasons);
  };

  // schema: the subject must carry the fields a reviewer is able to check at all.
  const schema: string[] = [];
  if (!subject.id || !subject.kind) schema.push("subject identity and kind are required");
  if (stringList(subject.evidence_refs).length === 0) schema.push("subject requires at least one evidence reference");
  if (stringList(subject.limitations).length === 0) schema.push("subject requires explicit limitations");
  if (typeof subject.reproducibility !== "string" || !subject.reproducibility.trim()) schema.push("subject requires a reproducibility method");
  if (subject.kind === "finding" && typeof subject.applicable_scope_ref !== "string") schema.push("finding requires an applicable scope");
  if (subject.kind === "finding" && stringList(subject.claim_refs).length === 0) schema.push("finding requires at least one claim reference");
  gate("schema", schema);

  // scope: targets must stay inside the declared scope and never hit an exclusion.
  const scope: string[] = [];
  const excluded = stringList(subject.excluded_targets);
  if (excluded.length && subject.target && excluded.includes(subject.target)) scope.push(`target is excluded from scope: ${subject.target}`);
  const allowed = stringList(subject.allowed_targets);
  if (subject.target && allowed.length && !allowed.includes(subject.target)) scope.push(`target is outside the allowed scope: ${subject.target}`);
  gate("scope", scope);

  // evidence: referenced evidence must exist in the pinned snapshot and still be current.
  const evidence: string[] = [];
  const pinned = new Map(input.evidence.map((item) => [item.id, item]));
  // 可选来源门：归纳类 subject 的证据必须来自允许的来源角色（fail closed）。
  const allowedOrigins = policy.derived_subject_evidence_roles?.[subject.kind];
  for (const ref of stringList(subject.evidence_refs)) {
    const item = pinned.get(ref);
    if (!item) { evidence.push(`evidence is not part of the pinned snapshot: ${ref}`); continue; }
    const status = String(item.status ?? "active");
    if (NON_CURRENT_EVIDENCE.has(status)) evidence.push(`evidence is ${status} and cannot support a current claim: ${ref}`);
    if (allowedOrigins) {
      const origin = item.origin;
      // host/operator 提交的捕获记录均记 source_kind "host"；白名单含 "operator" 即接受 host 捕获。
      const trusted = origin !== undefined && (allowedOrigins.includes(origin as "host") || (origin === "host" && allowedOrigins.includes("operator")));
      if (!trusted) evidence.push(`evidence_origin_untrusted: ${ref} has ${origin ?? "no recorded"} provenance origin`);
    }
  }
  for (const ref of stringList(subject.counter_evidence_refs)) {
    if (!pinned.has(ref)) evidence.push(`counter evidence is not part of the pinned snapshot: ${ref}`);
  }
  if (stringList(subject.counter_evidence_refs).length > 0) evidence.push("counter evidence is attached; the claim cannot be promoted until it is resolved");
  gate("evidence", evidence);

  // freshness: evidence must be recent enough for the risk profile, and the subject not elapsed.
  const freshness: string[] = [];
  if (profile.max_evidence_age_days !== null) {
    for (const ref of stringList(subject.evidence_refs)) {
      const observed = pinned.get(ref)?.observed_at;
      if (!observed) { freshness.push(`evidence has no observation time: ${ref}`); continue; }
      const age = (now - Date.parse(observed)) / DAY_MS;
      if (!Number.isFinite(age) || age < 0) freshness.push(`evidence observation time is invalid: ${ref}`);
      else if (age > profile.max_evidence_age_days) freshness.push(`evidence is ${age.toFixed(1)} days old and exceeds the ${profile.max_evidence_age_days} day limit for ${profile.risk_class}: ${ref}`);
    }
  }
  for (const [field, value] of [["review_after", subject.review_after], ["expires_at", subject.expires_at]] as const) {
    if (typeof value === "string" && Date.parse(value) <= now) freshness.push(`${field} has elapsed and the subject must be revalidated`);
  }
  gate("freshness", freshness);

  // independence: bound, non-self, sufficiently diverse review records.
  gate("independence", independenceReasons(input, profile));

  const passed = gates.every((item) => item.passed);
  return { admitted: passed, promotable: passed, risk_class: profile.risk_class, policy_digest: input.policy_digest, gates, reasons };
}

/** Reasons why the bound review set does not satisfy the profile independence bar. */
export function independenceReasons(input: AdmissionInput, profile: RiskProfile = riskProfile(input.policy, input.subject.risk_class)): string[] {
  const reasons: string[] = [];
  const forbidden = new Set([...(input.subject.author_ids ?? []), ...(input.subject.worker_ids ?? [])].filter(Boolean));
  const reviews = input.reviews.filter((review) => review.verdict === "pass");
  for (const review of reviews) {
    if (review.input_hash !== input.input_hash) reasons.push(`review ${review.review_id} is not bound to the current input hash`);
    else if (review.evidence_snapshot_hash !== input.evidence_snapshot_hash) reasons.push(`review ${review.review_id} is not bound to the current evidence snapshot`);
    else if (review.policy_digest !== input.policy_digest) reasons.push(`review ${review.review_id} was decided under a different policy digest`);
  }
  const bound = reviews.filter((review) => review.input_hash === input.input_hash && review.evidence_snapshot_hash === input.evidence_snapshot_hash && review.policy_digest === input.policy_digest);
  const independent = bound.filter((review) => !forbidden.has(review.reviewer_id));
  for (const review of bound) {
    if (forbidden.has(review.reviewer_id)) reasons.push(`reviewer ${review.reviewer_id} authored or executed the subject and cannot review it`);
  }
  const distinctReviewers = new Set(independent.map((review) => review.reviewer_id));
  if (distinctReviewers.size < profile.min_independent_reviews) {
    reasons.push(`risk class ${profile.risk_class} requires ${profile.min_independent_reviews} independent review(s), found ${distinctReviewers.size}`);
  }
  if (profile.strong_independence && independent.length > 0) {
    // Same model and same prompt across reviewers is a correlated signal, not strong independence.
    const humans = independent.filter((review) => review.reviewer_kind === "human");
    const signatures = new Set(independent.filter((review) => review.reviewer_kind !== "human").map((review) => `${review.reviewer_model ?? ""}|${review.prompt_digest ?? ""}|${review.ruleset_digest ?? ""}`));
    if (humans.length === 0 && signatures.size < Math.min(2, profile.min_independent_reviews)) {
      reasons.push(signatures.size <= 1
        ? `risk class ${profile.risk_class} requires heterogeneous review; identical model and prompt across reviewers is not strong independence`
        : `risk class ${profile.risk_class} requires heterogeneous reviewers; found ${signatures.size} distinct model/prompt signature(s)`);
    }
  }
  return reasons;
}

/** True when the reviewer set alone satisfies the profile, ignoring every other gate. */
export function satisfiesStrongIndependence(reviews: readonly AdmissionReview[], profile: RiskProfile): boolean {
  const independent = reviews.filter((review) => review.verdict === "pass");
  // A human reviewer is the strongest independence available and satisfies the
  // heterogeneous bar on its own; the review-count bar does not apply to it.
  if (profile.strong_independence && independent.some((review) => review.reviewer_kind === "human")) return true;
  if (new Set(independent.map((review) => review.reviewer_id)).size < profile.min_independent_reviews) return false;
  if (!profile.strong_independence) return true;
  const signatures = new Set(independent.map((review) => `${review.reviewer_model ?? ""}|${review.prompt_digest ?? ""}|${review.ruleset_digest ?? ""}`));
  return signatures.size >= Math.min(2, profile.min_independent_reviews);
}

/** Trust transitions are explicit: L0 proposal -> L1 candidate -> L2 verified finding. */
export const TRUST_TRANSITIONS: Readonly<Record<"L0" | "L1" | "L2", readonly ("L0" | "L1" | "L2")[]>> = Object.freeze({
  L0: ["L1"],
  L1: ["L2"],
  L2: [],
});

export function canTransitionTrust(from: "L0" | "L1" | "L2", to: "L0" | "L1" | "L2"): boolean {
  return TRUST_TRANSITIONS[from].includes(to);
}

export function isCanonicalSubject(record: CanonicalRecord): boolean {
  return typeof record.id === "string" && typeof record.kind === "string";
}
