import { createHash } from "node:crypto";

/** Version of the deterministic, stratified quality report contract. */
export const QUALITY_EVALUATION_VERSION = "quality-evaluation/1" as const;

/** Metadata of the labeled dataset, separate from caller-scored metric fields. */
export interface QualityEvidenceProvenance {
  kind: "human_annotated" | "synthetic_fixture";
  dataset_version: string;
  strata_version: string;
  sample_digest: string;
  annotators: readonly { id: string; role: "annotator" | "adjudicator" }[];
  review_process: string;
  time_range: { from: string; to: string };
  human_baseline: { source_ref: string; protocol: string; blinded: boolean };
}

function canonicalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalEvidence(item)]));
  return value;
}

/** Digest includes gold truth, human baseline, and system results, with stable
 * key/sample ordering so a report can reconstruct the exact labeled input. */
export function qualitySampleDigest(samples: readonly QualitySample[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalEvidence([...samples].sort((a, b) => a.id.localeCompare(b.id))))).digest("hex")}`;
}

export function qualityProvenanceFailures(samples: readonly QualitySample[], provenance?: QualityEvidenceProvenance): string[] {
  if (!provenance) return ["human annotation and baseline provenance is missing"];
  const failures: string[] = [];
  if (provenance.kind !== "human_annotated") failures.push("synthetic fixtures do not establish human quality evidence");
  if (!provenance.dataset_version?.trim() || !provenance.strata_version?.trim()) failures.push("dataset and strata versions are required");
  if (provenance.sample_digest !== qualitySampleDigest(samples)) failures.push("labeled sample digest does not match the report input");
  if (!Array.isArray(provenance.annotators) || provenance.annotators.length < 2 || new Set(provenance.annotators.map((item) => item.id)).size !== provenance.annotators.length || provenance.annotators.some((item) => !item.id?.trim() || !["annotator", "adjudicator"].includes(item.role))) failures.push("independent annotator/adjudicator identities are required");
  if (!provenance.review_process?.trim()) failures.push("annotation review process is required");
  const from = Date.parse(provenance.time_range?.from); const to = Date.parse(provenance.time_range?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) failures.push("annotation time range is invalid");
  if (!provenance.human_baseline?.source_ref?.trim() || !provenance.human_baseline.protocol?.trim() || provenance.human_baseline.blinded !== true) failures.push("a blinded human baseline source and protocol are required");
  return failures;
}

export type QualitySurface = "web" | "host";

export interface QualityStratum {
  surface: QualitySurface;
  riskClass: string;
  evidenceLevel: string;
}

/** One independently labeled evaluation example. */
export interface QualitySample extends QualityStratum {
  id: string;
  /** Gold-standard existence of a finding and relevance to the retrieval query. */
  findingTruth: boolean;
  retrievalTruth: boolean;
  /** System and human judgments are scored against the same gold labels. */
  findingDetected: boolean;
  retrievalReturned: boolean;
  humanFindingDetected: boolean;
  humanRetrievalReturned: boolean;
  /** Probability assigned to findingTruth, including when no finding was emitted. */
  findingConfidence: number;
  claimMade?: boolean;
  claimSupported?: boolean;
  coverageExpected?: boolean;
  coverageRecorded?: boolean;
  guardTriggered?: boolean;
  guardShouldTrigger?: boolean;
  propagationAttempted?: boolean;
  propagationErroneous?: boolean;
  reviewerAVerdict?: boolean;
  reviewerBVerdict?: boolean;
  /** End-to-end write-to-query visibility latency, measured in milliseconds. */
  writeLatencyMs?: number;
  /** Whether this fixture exercises a crash/recovery path. */
  recoveryExpected?: boolean;
  /** Whether an expected recovery completed without authority loss. */
  recoverySucceeded?: boolean;
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
}

export interface BinaryMetrics {
  precision: number | null;
  precision95CI: ConfidenceInterval | null;
  recall: number | null;
  recall95CI: ConfidenceInterval | null;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
}

export interface RateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
  rate95CI: ConfidenceInterval | null;
}

export interface CalibrationMetric {
  /** Expected calibration error using fixed-width confidence bins. */
  expectedCalibrationError: number | null;
  expectedCalibrationError95CI: ConfidenceInterval | null;
  binCount: number;
}

export interface ReviewAgreementMetric extends RateMetric {
  cohenKappa: number | null;
}

export interface LatencyMetric {
  sampleCount: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface QualityStratumReport extends QualityStratum {
  sampleCount: number;
  minimumSampleCount: number;
  status: "insufficient" | "evaluated";
  /** No stratum below the configured sample minimum can pass its release gate. */
  passed: boolean;
  finding: BinaryMetrics;
  retrieval: BinaryMetrics;
  humanBaseline: {
    finding: BinaryMetrics;
    retrieval: BinaryMetrics;
  };
  unsupportedClaim: RateMetric;
  coverageMiss: RateMetric;
  guard: {
    falsePositive: number;
    falseNegative: number;
  };
  erroneousPropagation: RateMetric;
  writeLatency: LatencyMetric;
  recoverySuccess: RateMetric;
  calibration: CalibrationMetric;
  reviewAgreement: ReviewAgreementMetric;
}

export interface QualityEvaluationOptions {
  /** Defaults to 30, a conservative minimum for a stratum-level release claim. */
  minimumSampleCount?: number;
  /** Defaults to 10 fixed-width bins for expected calibration error. */
  calibrationBinCount?: number;
  /** Empty or absent strata are reported as insufficient when supplied here. */
  requiredStrata?: readonly QualityStratum[];
}

export interface QualityEvaluationReport {
  version: typeof QUALITY_EVALUATION_VERSION;
  minimumSampleCount: number;
  passed: boolean;
  strata: QualityStratumReport[];
}

interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

function wilsonInterval(successes: number, trials: number): ConfidenceInterval | null {
  if (trials === 0) return null;
  const z = 1.959963984540054;
  const proportion = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const center = (proportion + zSquared / (2 * trials)) / denominator;
  const halfWidth = (z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * trials)) / trials)) / denominator;
  return { lower: Math.max(0, center - halfWidth), upper: Math.min(1, center + halfWidth) };
}

function counts(samples: readonly QualitySample[], truth: (sample: QualitySample) => boolean, predicted: (sample: QualitySample) => boolean): Counts {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const sample of samples) {
    const actual = truth(sample);
    const estimate = predicted(sample);
    if (actual && estimate) tp++;
    else if (!actual && estimate) fp++;
    else if (actual && !estimate) fn++;
  }
  return { tp, fp, fn };
}

function binaryMetrics(value: Counts): BinaryMetrics {
  const precisionDenominator = value.tp + value.fp;
  const recallDenominator = value.tp + value.fn;
  return {
    precision: precisionDenominator === 0 ? null : value.tp / precisionDenominator,
    precision95CI: wilsonInterval(value.tp, precisionDenominator),
    recall: recallDenominator === 0 ? null : value.tp / recallDenominator,
    recall95CI: wilsonInterval(value.tp, recallDenominator),
    truePositive: value.tp,
    falsePositive: value.fp,
    falseNegative: value.fn
  };
}

function rateMetric(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    rate95CI: wilsonInterval(numerator, denominator)
  };
}

function latencyMetric(samples: readonly QualitySample[]): LatencyMetric {
  const values = samples.flatMap((sample) => sample.writeLatencyMs === undefined ? [] : [sample.writeLatencyMs]).sort((a, b) => a - b);
  if (values.length === 0) return { sampleCount: 0, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const percentile = (p: number): number => values[Math.ceil(p * values.length) - 1]!;
  return {
    sampleCount: values.length,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: values[values.length - 1]!
  };
}

function calibrationError(samples: readonly QualitySample[], binCount: number): number | null {
  if (samples.length === 0) return null;
  const bins = Array.from({ length: binCount }, () => ({ count: 0, confidence: 0, outcome: 0 }));
  for (const sample of samples) {
    const index = Math.min(binCount - 1, Math.floor(sample.findingConfidence * binCount));
    const bin = bins[index]!;
    bin.count++;
    bin.confidence += sample.findingConfidence;
    bin.outcome += sample.findingTruth ? 1 : 0;
  }
  return bins.reduce((error, bin) => {
    if (bin.count === 0) return error;
    return error + (bin.count / samples.length) * Math.abs(bin.confidence / bin.count - bin.outcome / bin.count);
  }, 0);
}

function hashSeed(samples: readonly QualitySample[]): number {
  let hash = 2166136261;
  for (const sample of samples) {
    const value = `${sample.id}:${sample.findingTruth ? 1 : 0}:${sample.findingConfidence};`;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0 || 1;
}

function calibrationInterval(samples: readonly QualitySample[], binCount: number): ConfidenceInterval | null {
  if (samples.length === 0) return null;
  // A fixed-seed, sample-level bootstrap makes the percentile interval reproducible.
  let seed = hashSeed(samples);
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const replicates: number[] = [];
  const resample: QualitySample[] = [];
  for (let replicate = 0; replicate < 2000; replicate++) {
    resample.length = 0;
    for (let i = 0; i < samples.length; i++) resample.push(samples[Math.floor(random() * samples.length)]!);
    const estimate = calibrationError(resample, binCount);
    if (estimate !== null) replicates.push(estimate);
  }
  replicates.sort((a, b) => a - b);
  return { lower: replicates[Math.floor(0.025 * (replicates.length - 1))]!, upper: replicates[Math.ceil(0.975 * (replicates.length - 1))]! };
}

function reviewAgreement(samples: readonly QualitySample[]): ReviewAgreementMetric {
  const paired = samples.filter((sample) => sample.reviewerAVerdict !== undefined && sample.reviewerBVerdict !== undefined);
  const agreements = paired.filter((sample) => sample.reviewerAVerdict === sample.reviewerBVerdict).length;
  const raw = rateMetric(agreements, paired.length);
  if (paired.length === 0) return { ...raw, cohenKappa: null };
  const aPositive = paired.filter((sample) => sample.reviewerAVerdict).length / paired.length;
  const bPositive = paired.filter((sample) => sample.reviewerBVerdict).length / paired.length;
  const expectedAgreement = aPositive * bPositive + (1 - aPositive) * (1 - bPositive);
  const cohenKappa = expectedAgreement === 1 ? (agreements === paired.length ? 1 : 0) : (raw.rate! - expectedAgreement) / (1 - expectedAgreement);
  return { ...raw, cohenKappa };
}

function validateSample(sample: QualitySample): void {
  if (!sample.id) throw new Error("quality sample id is required");
  if (sample.surface !== "web" && sample.surface !== "host") throw new Error(`invalid quality surface: ${String(sample.surface)}`);
  if (!sample.riskClass || !sample.evidenceLevel) throw new Error("riskClass and evidenceLevel are required");
  if (!Number.isFinite(sample.findingConfidence) || sample.findingConfidence < 0 || sample.findingConfidence > 1) throw new Error(`findingConfidence must be between 0 and 1: ${sample.id}`);
  if (sample.writeLatencyMs !== undefined && (!Number.isFinite(sample.writeLatencyMs) || sample.writeLatencyMs < 0)) throw new Error(`writeLatencyMs must be a non-negative number: ${sample.id}`);
  if ((sample.claimMade === true) !== (sample.claimSupported !== undefined)) throw new Error(`claimSupported must be provided exactly when claimMade is true: ${sample.id}`);
  if ((sample.coverageExpected === true) !== (sample.coverageRecorded !== undefined)) throw new Error(`coverageRecorded must be provided exactly when coverageExpected is true: ${sample.id}`);
  if ((sample.guardTriggered !== undefined) !== (sample.guardShouldTrigger !== undefined)) throw new Error(`guardTriggered and guardShouldTrigger must be provided together: ${sample.id}`);
  if ((sample.propagationAttempted === true) !== (sample.propagationErroneous !== undefined)) throw new Error(`propagationErroneous must be provided exactly when propagationAttempted is true: ${sample.id}`);
  if ((sample.reviewerAVerdict !== undefined) !== (sample.reviewerBVerdict !== undefined)) throw new Error(`reviewer verdicts must be provided as a pair: ${sample.id}`);
  if (sample.recoverySucceeded !== undefined && sample.recoveryExpected !== true) throw new Error(`recoverySucceeded requires recoveryExpected=true: ${sample.id}`);
}

function stratumKey(stratum: QualityStratum): string {
  return JSON.stringify([stratum.surface, stratum.riskClass, stratum.evidenceLevel]);
}

function compareStrata(a: QualityStratum, b: QualityStratum): number {
  return stratumKey(a).localeCompare(stratumKey(b));
}

function reportStratum(stratum: QualityStratum, samples: readonly QualitySample[], minimumSampleCount: number, calibrationBinCount: number): QualityStratumReport {
  const finding = counts(samples, (sample) => sample.findingTruth, (sample) => sample.findingDetected);
  const retrieval = counts(samples, (sample) => sample.retrievalTruth, (sample) => sample.retrievalReturned);
  const humanFinding = counts(samples, (sample) => sample.findingTruth, (sample) => sample.humanFindingDetected);
  const humanRetrieval = counts(samples, (sample) => sample.retrievalTruth, (sample) => sample.humanRetrievalReturned);
  const claimSamples = samples.filter((sample) => sample.claimMade === true);
  const coverageSamples = samples.filter((sample) => sample.coverageExpected === true);
  const propagationSamples = samples.filter((sample) => sample.propagationAttempted === true);
  const recoverySamples = samples.filter((sample) => sample.recoveryExpected === true);
  const guardSamples = samples.filter((sample) => sample.guardTriggered !== undefined);
  const guard = counts(guardSamples, (sample) => sample.guardShouldTrigger!, (sample) => sample.guardTriggered!);
  const calibration = {
    expectedCalibrationError: calibrationError(samples, calibrationBinCount),
    expectedCalibrationError95CI: calibrationInterval(samples, calibrationBinCount),
    binCount: calibrationBinCount
  };
  return {
    ...stratum,
    sampleCount: samples.length,
    minimumSampleCount,
    status: samples.length < minimumSampleCount ? "insufficient" : "evaluated",
    passed: samples.length >= minimumSampleCount,
    finding: binaryMetrics(finding),
    retrieval: binaryMetrics(retrieval),
    humanBaseline: { finding: binaryMetrics(humanFinding), retrieval: binaryMetrics(humanRetrieval) },
    unsupportedClaim: rateMetric(claimSamples.filter((sample) => sample.claimSupported === false).length, claimSamples.length),
    coverageMiss: rateMetric(coverageSamples.filter((sample) => sample.coverageRecorded === false).length, coverageSamples.length),
    guard: { falsePositive: guard.fp, falseNegative: guard.fn },
    erroneousPropagation: rateMetric(propagationSamples.filter((sample) => sample.propagationErroneous === true).length, propagationSamples.length),
    writeLatency: latencyMetric(samples),
    recoverySuccess: rateMetric(recoverySamples.filter((sample) => sample.recoverySucceeded === true).length, recoverySamples.length),
    calibration,
    reviewAgreement: reviewAgreement(samples)
  };
}

/**
 * Computes deterministic web/host × risk × evidence quality evidence.
 * Precision, recall, and rates use 95% Wilson score intervals; ECE uses a
 * fixed-seed sample bootstrap percentile interval. No empty metric is treated
 * as zero, and strata below the configured sample floor cannot pass.
 */
export function evaluateMemoryQuality(samples: readonly QualitySample[], options: QualityEvaluationOptions = {}): QualityEvaluationReport {
  const minimumSampleCount = options.minimumSampleCount ?? 30;
  const calibrationBinCount = options.calibrationBinCount ?? 10;
  if (!Number.isInteger(minimumSampleCount) || minimumSampleCount < 1) throw new Error("minimumSampleCount must be a positive integer");
  if (!Number.isInteger(calibrationBinCount) || calibrationBinCount < 1) throw new Error("calibrationBinCount must be a positive integer");

  const seenIds = new Set<string>();
  const grouped = new Map<string, QualitySample[]>();
  const strata = new Map<string, QualityStratum>();
  for (const sample of samples) {
    validateSample(sample);
    if (seenIds.has(sample.id)) throw new Error(`duplicate quality sample id: ${sample.id}`);
    seenIds.add(sample.id);
    const stratum = { surface: sample.surface, riskClass: sample.riskClass, evidenceLevel: sample.evidenceLevel };
    const key = stratumKey(stratum);
    const group = grouped.get(key) ?? [];
    group.push(sample);
    grouped.set(key, group);
    strata.set(key, stratum);
  }
  for (const stratum of options.requiredStrata ?? []) {
    if (!stratum.riskClass || !stratum.evidenceLevel || (stratum.surface !== "web" && stratum.surface !== "host")) throw new Error("required stratum must have a valid surface, riskClass, and evidenceLevel");
    const key = stratumKey(stratum);
    if (!strata.has(key)) strata.set(key, stratum);
  }

  const reports = [...strata.entries()]
    .sort(([, a], [, b]) => compareStrata(a, b))
    .map(([key, stratum]) => reportStratum(stratum, grouped.get(key) ?? [], minimumSampleCount, calibrationBinCount));
  return {
    version: QUALITY_EVALUATION_VERSION,
    minimumSampleCount,
    passed: reports.length > 0 && reports.every((report) => report.passed),
    strata: reports
  };
}
