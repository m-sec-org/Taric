import {
  evaluateMemoryQuality,
  QUALITY_CONFIDENCE_INTERVAL_METHOD,
  QUALITY_EVALUATION_VERSION,
  qualitySampleDigest,
  qualityProvenanceFailures,
  type QualityEvidenceProvenance,
  type QualityEvaluationOptions,
  type QualityEvaluationReport,
  type QualitySample,
  type QualityStratum,
  type QualityStratumReport
} from "./quality.js";
import { TARIC_COMPATIBILITY_MANIFEST, type ManifestCapability } from "./compatibility.js";

/** Version of the deterministic release report contract. */
export const RELEASE_REPORT_VERSION = "release-report/1" as const;

/** SHA-256 digest in the canonical `sha256:<64 lowercase hex>` form. */
export type Sha256Digest = `sha256:${string}`;

export interface ReleaseReportDigests {
  commit: Sha256Digest;
  schema: Sha256Digest;
  policy: Sha256Digest;
  /** Digest of the exact ordered quality sample input. */
  sample: Sha256Digest;
  /** Digest of the implementation fixture used by the release gates. */
  fixture: Sha256Digest;
}

/** Configuration used to produce the quality evidence in a release report. */
export interface ReleaseReportConfiguration extends QualityEvaluationOptions {
  minimumSampleCount: number;
  calibrationBinCount: number;
  requiredStrata: readonly QualityStratum[];
  /** Every id listed here must have a passing gate outcome. */
  requiredGateIds: readonly string[];
}

export interface ReleaseReportConfigurationInput extends Partial<QualityEvaluationOptions> {
  /** Non-empty, versioned release gate set. Missing outcomes fail closed. */
  requiredGateIds: readonly string[];
}

/** A release gate result supplied by the caller after running that gate. */
export interface ReleaseGateInput {
  /** Stable identifier for the gate. */
  id: string;
  /** Required gates block the release when `passed` is false. Defaults to true. */
  required?: boolean;
  passed: boolean;
  /** Human-readable reason for a failed gate. */
  reason?: string;
  /** Evidence expected by the gate and observed from its run. */
  expectedEvidence?: readonly string[];
  actualEvidence?: readonly string[];
  /** Additional evidence references, such as test names or artifact paths. */
  evidence?: readonly string[];
}

export interface ReleaseGateOutcome {
  id: string;
  required: boolean;
  passed: boolean;
  reason: string | null;
  expectedEvidence: readonly string[];
  actualEvidence: readonly string[];
  evidence: readonly string[];
}

export interface RequiredGateFailure {
  kind: "required-gate";
  gateId: string;
  reason: string;
  expectedEvidence: readonly string[];
  actualEvidence: readonly string[];
  evidence: readonly string[];
}

export interface InsufficientStratumFailure {
  kind: "insufficient-stratum";
  stratum: QualityStratum;
  sampleCount: number;
  minimumSampleCount: number;
  reason: string;
}

export interface QualityEvaluationFailure {
  kind: "quality-evaluation";
  reason: string;
  sampleCount: number;
}

export interface QualityProvenanceFailure { kind: "quality-provenance"; reason: string; }
export interface CapabilityEvidenceFailure { kind: "capability-evidence"; capabilityId: string; reason: string; }

export type ReleaseFailureEvidence = RequiredGateFailure | InsufficientStratumFailure | QualityEvaluationFailure | QualityProvenanceFailure | CapabilityEvidenceFailure;

export interface ReleaseReportInput {
  samples: readonly QualitySample[];
  digests: ReleaseReportDigests;
  config: ReleaseReportConfigurationInput;
  gates?: readonly ReleaseGateInput[];
  quality_provenance?: QualityEvidenceProvenance;
  capabilities?: readonly ManifestCapability[];
}

export interface ReleaseReport {
  version: typeof RELEASE_REPORT_VERSION;
  digests: ReleaseReportDigests;
  configuration: ReleaseReportConfiguration;
  sampleCount: number;
  /** Full deterministic stratified quality result, including all 95% intervals. */
  quality: QualityEvaluationReport;
  /** Convenience projection for consumers that only need strata. */
  strata: readonly QualityStratumReport[];
  gates: readonly ReleaseGateOutcome[];
  failures: readonly ReleaseFailureEvidence[];
  passed: boolean;
  quality_provenance: QualityEvidenceProvenance | null;
  evidence_state: "verified" | "pending" | "failed";
  capabilities: readonly ManifestCapability[];
}

export interface ReleaseReportVerificationFailure {
  kind: "invalid-report" | "stale-report" | "failed-report";
  reason: string;
}

export interface ReleaseReportVerification {
  activatable: boolean;
  failures: readonly ReleaseReportVerificationFailure[];
}

const SHA256 = /^sha256:([0-9a-f]{64})$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSha256(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalReportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReportValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalReportValue(item)]));
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} is required`);
  return value.trim();
}

function digest(value: unknown, field: string): Sha256Digest {
  const candidate = requiredString(value, field);
  const match = SHA256.exec(candidate);
  if (!match) throw new TypeError(`${field} must be a sha256:<64 hex> digest`);
  return `sha256:${match[1]!.toLowerCase()}` as Sha256Digest;
}

function stringList(value: readonly string[] | undefined, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${field} must contain non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function stratumKey(stratum: QualityStratum): string {
  return JSON.stringify([stratum.surface, stratum.riskClass, stratum.evidenceLevel]);
}

function compareStrata(a: QualityStratum, b: QualityStratum): number {
  return stratumKey(a).localeCompare(stratumKey(b));
}

function normalizeConfiguration(config: ReleaseReportConfigurationInput): ReleaseReportConfiguration {
  if (!config || typeof config !== "object") throw new TypeError("release report configuration is required");
  const minimumSampleCount = config.minimumSampleCount ?? 30;
  const calibrationBinCount = config.calibrationBinCount ?? 10;
  if (!Number.isInteger(minimumSampleCount) || minimumSampleCount < 1) throw new TypeError("minimumSampleCount must be a positive integer");
  if (!Number.isInteger(calibrationBinCount) || calibrationBinCount < 1) throw new TypeError("calibrationBinCount must be a positive integer");
  const configuredStrata = config.requiredStrata ?? [];
  if (!Array.isArray(configuredStrata)) throw new TypeError("requiredStrata must be an array");
  const requiredStrata = [...configuredStrata].map((stratum) => ({ ...stratum })).sort(compareStrata);
  for (let index = 1; index < requiredStrata.length; index++) {
    if (stratumKey(requiredStrata[index - 1]!) === stratumKey(requiredStrata[index]!)) throw new TypeError("requiredStrata must not contain duplicates");
  }
  if (!Array.isArray(config.requiredGateIds) || config.requiredGateIds.length === 0) throw new TypeError("requiredGateIds must contain at least one gate id");
  const requiredGateIds = [...config.requiredGateIds].map((id) => requiredString(id, "required gate id")).sort((a, b) => a.localeCompare(b));
  for (let index = 1; index < requiredGateIds.length; index++) {
    if (requiredGateIds[index - 1] === requiredGateIds[index]) throw new TypeError(`duplicate required gate id: ${requiredGateIds[index]}`);
  }
  return { minimumSampleCount, calibrationBinCount, requiredStrata, requiredGateIds };
}

function normalizeGates(gates: readonly ReleaseGateInput[] | undefined, requiredGateIds: readonly string[]): readonly ReleaseGateOutcome[] {
  if (gates !== undefined && !Array.isArray(gates)) throw new TypeError("gates must be an array");
  const seen = new Set<string>();
  const outcomes = [...(gates ?? [])]
    .map((gate) => {
      if (!gate || typeof gate !== "object") throw new TypeError("release gate must be an object");
      const id = requiredString(gate.id, "gate id");
      if (seen.has(id)) throw new TypeError(`duplicate release gate id: ${id}`);
      seen.add(id);
      if (typeof gate.passed !== "boolean") throw new TypeError(`gate ${id} passed must be boolean`);
      if (gate.required !== undefined && typeof gate.required !== "boolean") throw new TypeError(`gate ${id} required must be boolean`);
      const reason = gate.reason === undefined ? null : requiredString(gate.reason, `gate ${id} reason`);
      return {
        id,
        required: requiredGateIds.includes(id) || (gate.required ?? true),
        passed: gate.passed,
        reason,
        expectedEvidence: stringList(gate.expectedEvidence, `gate ${id} expectedEvidence`),
        actualEvidence: stringList(gate.actualEvidence, `gate ${id} actualEvidence`),
        evidence: stringList(gate.evidence, `gate ${id} evidence`)
      };
    });
  for (const id of requiredGateIds) {
    if (outcomes.some((gate) => gate.id === id)) continue;
    outcomes.push({
      id,
      required: true,
      passed: false,
      reason: `required gate ${id} has no outcome`,
      expectedEvidence: ["passed=true"],
      actualEvidence: [],
      evidence: []
    });
  }
  return outcomes.sort((a, b) => a.id.localeCompare(b.id));
}

function gateFailures(gates: readonly ReleaseGateOutcome[]): RequiredGateFailure[] {
  return gates
    .filter((gate) => gate.required && !gate.passed)
    .map((gate) => ({
      kind: "required-gate" as const,
      gateId: gate.id,
      reason: gate.reason ?? `required gate ${gate.id} failed`,
      expectedEvidence: gate.expectedEvidence,
      actualEvidence: gate.actualEvidence,
      evidence: gate.evidence
    }));
}

function insufficientFailures(strata: readonly QualityStratumReport[]): InsufficientStratumFailure[] {
  return strata
    .filter((stratum) => stratum.status === "insufficient" || !stratum.passed)
    .map((stratum) => ({
      kind: "insufficient-stratum" as const,
      stratum: { surface: stratum.surface, riskClass: stratum.riskClass, evidenceLevel: stratum.evidenceLevel },
      sampleCount: stratum.sampleCount,
      minimumSampleCount: stratum.minimumSampleCount,
      reason: `stratum has ${stratum.sampleCount} samples; ${stratum.minimumSampleCount} required`
    }));
}

/**
 * Build a deterministic release report from explicit evidence and gate results.
 * The function only validates and computes values; it never reads the shell,
 * filesystem, environment, clock, or git state.
 */
export function buildReleaseReport(input: ReleaseReportInput): ReleaseReport {
  if (!input || typeof input !== "object") throw new TypeError("release report input is required");
  const digests: ReleaseReportDigests = {
    commit: digest(input.digests?.commit, "commit digest"),
    schema: digest(input.digests?.schema, "schema digest"),
    policy: digest(input.digests?.policy, "policy digest"),
    sample: digest(input.digests?.sample, "sample digest"),
    fixture: digest(input.digests?.fixture, "fixture digest")
  };
  if (!Array.isArray(input.samples)) throw new TypeError("samples must be an array");
  const samples = [...input.samples];
  for (const sample of samples) {
    if (!sample || typeof sample.id !== "string" || sample.id.length === 0) throw new TypeError("quality sample id is required");
  }
  samples.sort((a, b) => a.id.localeCompare(b.id));
  const computedSampleDigest = qualitySampleDigest(samples);
  if (digests.sample !== computedSampleDigest) throw new TypeError("sample digest does not match the report input");
  const configuration = normalizeConfiguration(input.config);
  const quality = evaluateMemoryQuality(samples, configuration);
  const gates = normalizeGates(input.gates, configuration.requiredGateIds);
  const failures: ReleaseFailureEvidence[] = [
    ...gateFailures(gates),
    ...insufficientFailures(quality.strata),
    ...qualityProvenanceFailures(samples, input.quality_provenance).map((reason) => ({ kind: "quality-provenance" as const, reason })),
  ];
  const capabilities = input.capabilities ?? TARIC_COMPATIBILITY_MANIFEST.capabilities;
  for (const capability of capabilities) {
    if (capability.state === "supported" && (capability.implementation_state !== "available" || capability.evidence_state !== "verified" || capability.evidence.length === 0)) failures.push({ kind: "capability-evidence", capabilityId: capability.id, reason: "supported capability lacks available implementation or verified evidence" });
    if (capability.follow_up_state === "pending" && (!capability.follow_up || !capability.follow_up_detail)) failures.push({ kind: "capability-evidence", capabilityId: capability.id, reason: "pending capability lacks explicit remaining-work ownership" });
  }
  if (!quality.passed && quality.strata.length === 0) {
    failures.push({ kind: "quality-evaluation", reason: "quality evaluation has no strata", sampleCount: samples.length });
  }
  return {
    version: RELEASE_REPORT_VERSION,
    digests,
    configuration,
    sampleCount: samples.length,
    quality,
    strata: quality.strata,
    gates,
    failures,
    passed: quality.passed && failures.length === 0,
    quality_provenance: input.quality_provenance ?? null,
    evidence_state: failures.length === 0 ? "verified" : input.quality_provenance ? "failed" : "pending",
    capabilities,
  };
}

/** Alias kept alongside the verb-style builder for callers that construct reports. */
export const createReleaseReport = buildReleaseReport;

/**
 * Verify a persisted report against the release identity that is about to be
 * activated. This intentionally accepts unknown data so malformed artifacts
 * fail closed with a stable reason instead of throwing during startup.
 */
export function verifyReleaseReport(report: unknown, expectedDigests: ReleaseReportDigests): ReleaseReportVerification {
  const failures: ReleaseReportVerificationFailure[] = [];
  if (!report || typeof report !== "object") {
    return { activatable: false, failures: [{ kind: "invalid-report", reason: "release report must be an object" }] };
  }
  const candidate = report as Record<string, unknown>;
  if (candidate.version !== RELEASE_REPORT_VERSION) failures.push({ kind: "stale-report", reason: `release report version must be ${RELEASE_REPORT_VERSION}` });

  const expected: Partial<ReleaseReportDigests> = expectedDigests && typeof expectedDigests === "object" ? expectedDigests : {};
  const reportDigests = candidate.digests;
  if (!reportDigests || typeof reportDigests !== "object") {
    failures.push({ kind: "invalid-report", reason: "release report digests are required" });
  } else {
    for (const field of ["commit", "schema", "policy", "sample", "fixture"] as const) {
      let expectedDigest: Sha256Digest;
      try { expectedDigest = digest(expected[field], `${field} digest`); }
      catch { failures.push({ kind: "invalid-report", reason: `expected ${field} digest is invalid` }); continue; }
      let actualDigest: Sha256Digest;
      try { actualDigest = digest((reportDigests as Record<string, unknown>)[field], `report ${field} digest`); }
      catch { failures.push({ kind: "invalid-report", reason: `release report ${field} digest is invalid` }); continue; }
      if (actualDigest !== expectedDigest) failures.push({ kind: "stale-report", reason: `${field} digest does not match the current release identity` });
    }
  }

  const quality = candidate.quality;
  if (!quality || typeof quality !== "object" || (quality as Record<string, unknown>).version !== QUALITY_EVALUATION_VERSION) {
    failures.push({ kind: "invalid-report", reason: `quality report version must be ${QUALITY_EVALUATION_VERSION}` });
  } else {
    const qualityValue = quality as Record<string, unknown>;
    const configuration = candidate.configuration;
    if (!configuration || typeof configuration !== "object") {
      failures.push({ kind: "invalid-report", reason: "release report configuration is required" });
    } else {
      const config = configuration as Record<string, unknown>;
      if (!Number.isInteger(config.minimumSampleCount) || Number(config.minimumSampleCount) < 1 || qualityValue.minimumSampleCount !== config.minimumSampleCount) failures.push({ kind: "invalid-report", reason: "quality minimum sample count does not match configuration" });
      if (!Number.isInteger(config.calibrationBinCount) || Number(config.calibrationBinCount) < 1) failures.push({ kind: "invalid-report", reason: "release report calibration bin count is invalid" });
      if (!Array.isArray(config.requiredGateIds) || config.requiredGateIds.length === 0 || config.requiredGateIds.some((id) => !isNonEmptyString(id))) failures.push({ kind: "invalid-report", reason: "release report required gate ids are invalid" });
      if (!Array.isArray(config.requiredStrata) || config.requiredStrata.some((stratum) => !stratum || typeof stratum !== "object" || !["web", "host"].includes(String((stratum as Record<string, unknown>).surface)) || !isNonEmptyString((stratum as Record<string, unknown>).riskClass) || !isNonEmptyString((stratum as Record<string, unknown>).evidenceLevel))) failures.push({ kind: "invalid-report", reason: "release report required strata are invalid" });
    }
    const strata = qualityValue.strata;
    if (!Array.isArray(strata) || strata.length === 0) {
      failures.push({ kind: "invalid-report", reason: "quality report strata are required" });
    } else {
      const validStrata = strata.every((stratum) => {
        if (!stratum || typeof stratum !== "object") return false;
        const value = stratum as Record<string, unknown>;
        return (value.surface === "web" || value.surface === "host") && isNonEmptyString(value.riskClass) && isNonEmptyString(value.evidenceLevel) && Number.isInteger(value.sampleCount) && Number(value.sampleCount) >= 0 && Number.isInteger(value.minimumSampleCount) && Number(value.minimumSampleCount) >= 1 && (value.status === "evaluated" || value.status === "insufficient") && typeof value.passed === "boolean" && value.status === (Number(value.sampleCount) < Number(value.minimumSampleCount) ? "insufficient" : "evaluated") && value.passed === (value.status === "evaluated");
      });
      if (!validStrata) failures.push({ kind: "invalid-report", reason: "quality report strata contain invalid status or counts" });
      const stratumKeys = strata.filter((stratum) => stratum && typeof stratum === "object").map((stratum) => JSON.stringify([(stratum as Record<string, unknown>).surface, (stratum as Record<string, unknown>).riskClass, (stratum as Record<string, unknown>).evidenceLevel]));
      if (new Set(stratumKeys).size !== stratumKeys.length) failures.push({ kind: "invalid-report", reason: "quality report strata contain duplicates" });
      if (configuration && typeof configuration === "object" && Array.isArray((configuration as Record<string, unknown>).requiredStrata)) {
        const available = new Set(stratumKeys);
        for (const required of (configuration as Record<string, unknown>).requiredStrata as unknown[]) {
          if (!required || typeof required !== "object" || !available.has(JSON.stringify([(required as Record<string, unknown>).surface, (required as Record<string, unknown>).riskClass, (required as Record<string, unknown>).evidenceLevel]))) failures.push({ kind: "invalid-report", reason: "required quality stratum is missing from evaluation" });
        }
      }
      const stratumCount = strata.reduce((sum, stratum) => sum + (stratum && typeof stratum === "object" && Number.isInteger((stratum as Record<string, unknown>).sampleCount) ? Number((stratum as Record<string, unknown>).sampleCount) : 0), 0);
      if (!Number.isInteger(candidate.sampleCount) || Number(candidate.sampleCount) < 0 || stratumCount !== Number(candidate.sampleCount)) failures.push({ kind: "invalid-report", reason: "release report sample count does not match strata" });
      if (qualityValue.passed !== strata.every((stratum) => Boolean(stratum && typeof stratum === "object" && (stratum as Record<string, unknown>).passed === true))) failures.push({ kind: "failed-report", reason: "quality evaluation pass state does not match strata" });
      const projected = candidate.strata;
      if (!Array.isArray(projected) || JSON.stringify(canonicalReportValue(projected)) !== JSON.stringify(canonicalReportValue(strata))) failures.push({ kind: "invalid-report", reason: "release report strata projection does not match quality evaluation" });
    }
  }
  const provenance = candidate.quality_provenance;
  if (!provenance || typeof provenance !== "object") {
    failures.push({ kind: "invalid-report", reason: "quality evidence provenance is required" });
  } else {
    const value = provenance as Record<string, unknown>;
    if (value.kind !== "human_annotated" || !isNonEmptyString(value.dataset_version) || !isNonEmptyString(value.strata_version) || !isSha256(value.sample_digest)) failures.push({ kind: "invalid-report", reason: "quality evidence dataset provenance is incomplete" });
    if (isSha256(value.sample_digest) && reportDigests && typeof reportDigests === "object" && (reportDigests as Record<string, unknown>).sample !== value.sample_digest) failures.push({ kind: "stale-report", reason: "sample digest does not match quality provenance" });
    const annotators = value.annotators;
    if (!Array.isArray(annotators) || annotators.length < 2 || annotators.some((item) => !item || typeof item !== "object" || !isNonEmptyString((item as Record<string, unknown>).id) || !["annotator", "adjudicator"].includes(String((item as Record<string, unknown>).role))) || new Set(annotators.filter((item) => item && typeof item === "object").map((item) => String((item as Record<string, unknown>).id))).size !== annotators.length) failures.push({ kind: "invalid-report", reason: "quality evidence annotator provenance is incomplete" });
    if (!isNonEmptyString(value.review_process)) failures.push({ kind: "invalid-report", reason: "quality evidence review process is incomplete" });
    const timeRange = value.time_range;
    const from = timeRange && typeof timeRange === "object" && typeof (timeRange as Record<string, unknown>).from === "string" ? Date.parse((timeRange as Record<string, unknown>).from as string) : Number.NaN;
    const to = timeRange && typeof timeRange === "object" && typeof (timeRange as Record<string, unknown>).to === "string" ? Date.parse((timeRange as Record<string, unknown>).to as string) : Number.NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) failures.push({ kind: "invalid-report", reason: "quality evidence annotation time range is invalid" });
    const baseline = value.human_baseline;
    if (!baseline || typeof baseline !== "object" || !isNonEmptyString((baseline as Record<string, unknown>).source_ref) || !isNonEmptyString((baseline as Record<string, unknown>).protocol) || (baseline as Record<string, unknown>).blinded !== true) failures.push({ kind: "invalid-report", reason: "quality evidence human baseline provenance is incomplete" });
    const agreement = value.annotation_agreement;
    if (!agreement || typeof agreement !== "object" || (agreement as Record<string, unknown>).metric !== "cohen_kappa" || !isFiniteNumber((agreement as Record<string, unknown>).value) || Number((agreement as Record<string, unknown>).value) < -1 || Number((agreement as Record<string, unknown>).value) > 1 || !Number.isInteger((agreement as Record<string, unknown>).sample_count) || Number((agreement as Record<string, unknown>).sample_count) !== candidate.sampleCount) failures.push({ kind: "invalid-report", reason: "annotation agreement provenance must cover every sample" });
    if (value.confidence_interval_method !== QUALITY_CONFIDENCE_INTERVAL_METHOD) failures.push({ kind: "invalid-report", reason: "confidence interval method provenance is incomplete" });
  }

  if (candidate.passed !== true || candidate.evidence_state !== "verified") failures.push({ kind: "failed-report", reason: "release report is not verified" });
  if (!Array.isArray(candidate.failures) || candidate.failures.length > 0) failures.push({ kind: "failed-report", reason: "release report contains failed evidence" });
  const gates = candidate.gates;
  const configuration = candidate.configuration;
  if (!Array.isArray(gates) || gates.some((gate) => !gate || typeof gate !== "object" || !isNonEmptyString((gate as Record<string, unknown>).id) || typeof (gate as Record<string, unknown>).required !== "boolean" || typeof (gate as Record<string, unknown>).passed !== "boolean") || new Set(gates.filter((gate) => gate && typeof gate === "object").map((gate) => String((gate as Record<string, unknown>).id))).size !== gates.length) {
    failures.push({ kind: "invalid-report", reason: "release report gate outcomes are invalid" });
  } else if (configuration && typeof configuration === "object" && Array.isArray((configuration as Record<string, unknown>).requiredGateIds)) {
    const gateById = new Map(gates.map((gate) => [String((gate as Record<string, unknown>).id), gate as Record<string, unknown>]));
    for (const id of (configuration as Record<string, unknown>).requiredGateIds as unknown[]) {
      const gate = gateById.get(String(id));
      if (!gate || gate.required !== true || gate.passed !== true) failures.push({ kind: "failed-report", reason: `required gate ${String(id)} is not passing` });
    }
  }
  if (!quality || typeof quality !== "object" || (quality as Record<string, unknown>).passed !== true) failures.push({ kind: "failed-report", reason: "quality evaluation did not pass" });
  return { activatable: failures.length === 0, failures };
}

