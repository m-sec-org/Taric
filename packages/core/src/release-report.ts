import {
  evaluateMemoryQuality,
  type QualityEvaluationOptions,
  type QualityEvaluationReport,
  type QualitySample,
  type QualityStratum,
  type QualityStratumReport
} from "./quality.js";

/** Version of the deterministic release report contract. */
export const RELEASE_REPORT_VERSION = "release-report/1" as const;

/** SHA-256 digest in the canonical `sha256:<64 lowercase hex>` form. */
export type Sha256Digest = `sha256:${string}`;

export interface ReleaseReportDigests {
  commit: Sha256Digest;
  schema: Sha256Digest;
  policy: Sha256Digest;
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

export type ReleaseFailureEvidence = RequiredGateFailure | InsufficientStratumFailure | QualityEvaluationFailure;

export interface ReleaseReportInput {
  samples: readonly QualitySample[];
  digests: ReleaseReportDigests;
  config: ReleaseReportConfigurationInput;
  gates?: readonly ReleaseGateInput[];
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
}

const SHA256 = /^sha256:([0-9a-f]{64})$/i;

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
    fixture: digest(input.digests?.fixture, "fixture digest")
  };
  if (!Array.isArray(input.samples)) throw new TypeError("samples must be an array");
  const samples = [...input.samples];
  for (const sample of samples) {
    if (!sample || typeof sample.id !== "string" || sample.id.length === 0) throw new TypeError("quality sample id is required");
  }
  samples.sort((a, b) => a.id.localeCompare(b.id));
  const configuration = normalizeConfiguration(input.config);
  const quality = evaluateMemoryQuality(samples, configuration);
  const gates = normalizeGates(input.gates, configuration.requiredGateIds);
  const failures: ReleaseFailureEvidence[] = [
    ...gateFailures(gates),
    ...insufficientFailures(quality.strata)
  ];
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
    passed: quality.passed && failures.length === 0
  };
}

/** Alias kept alongside the verb-style builder for callers that construct reports. */
export const createReleaseReport = buildReleaseReport;

