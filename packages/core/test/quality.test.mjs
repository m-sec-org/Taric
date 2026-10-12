import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMemoryQuality, QUALITY_EVALUATION_VERSION } from "../dist/quality.js";

function sample(id, overrides = {}) {
  return {
    id,
    surface: "web",
    riskClass: "high",
    evidenceLevel: "direct",
    findingTruth: false,
    retrievalTruth: false,
    findingDetected: false,
    retrievalReturned: false,
    humanFindingDetected: false,
    humanRetrievalReturned: false,
    findingConfidence: 0.1,
    ...overrides
  };
}

test("quality report computes stratified finding, retrieval, baseline, and quality rates", () => {
  const samples = [
    sample("a", { findingTruth: true, retrievalTruth: true, findingDetected: true, retrievalReturned: true, humanFindingDetected: true, humanRetrievalReturned: true, findingConfidence: 0.9, claimMade: true, claimSupported: true, coverageExpected: true, coverageRecorded: true, guardTriggered: true, guardShouldTrigger: true, propagationAttempted: true, propagationErroneous: false, reviewerAVerdict: true, reviewerBVerdict: true, writeLatencyMs: 50, recoveryExpected: true, recoverySucceeded: true }),
    sample("b", { findingTruth: true, retrievalTruth: true, findingDetected: false, retrievalReturned: false, humanFindingDetected: true, humanRetrievalReturned: true, findingConfidence: 0.4, coverageExpected: true, coverageRecorded: false, guardTriggered: false, guardShouldTrigger: true, reviewerAVerdict: false, reviewerBVerdict: false, writeLatencyMs: 200, recoveryExpected: true, recoverySucceeded: false }),
    sample("c", { findingDetected: true, retrievalReturned: true, humanFindingDetected: false, humanRetrievalReturned: false, findingConfidence: 0.8, claimMade: true, claimSupported: false, coverageExpected: true, coverageRecorded: true, guardTriggered: true, guardShouldTrigger: false, propagationAttempted: true, propagationErroneous: true, reviewerAVerdict: true, reviewerBVerdict: false, writeLatencyMs: 100 }),
    sample("d", { findingConfidence: 0.2, reviewerAVerdict: false, reviewerBVerdict: false })
  ];

  const report = evaluateMemoryQuality(samples, { minimumSampleCount: 4, calibrationBinCount: 5 });
  assert.equal(report.version, QUALITY_EVALUATION_VERSION);
  assert.equal(report.passed, true);
  assert.equal(report.strata.length, 1);
  const [stratum] = report.strata;
  assert.equal(stratum.sampleCount, 4);
  assert.equal(stratum.status, "evaluated");
  assert.deepEqual(
    { tp: stratum.finding.truePositive, fp: stratum.finding.falsePositive, fn: stratum.finding.falseNegative },
    { tp: 1, fp: 1, fn: 1 }
  );
  assert.equal(stratum.finding.precision, 0.5);
  assert.equal(stratum.finding.recall, 0.5);
  assert.equal(stratum.finding.precision95CI.lower < 0.5, true);
  assert.equal(stratum.finding.precision95CI.upper > 0.5, true);
  assert.equal(stratum.retrieval.precision, 0.5);
  assert.equal(stratum.retrieval.recall, 0.5);
  assert.equal(stratum.humanBaseline.finding.precision, 1);
  assert.equal(stratum.humanBaseline.finding.recall, 1);
  assert.deepEqual(stratum.guard, { falsePositive: 1, falseNegative: 1 });
  assert.equal(stratum.unsupportedClaim.numerator, 1);
  assert.equal(stratum.unsupportedClaim.denominator, 2);
  assert.equal(stratum.unsupportedClaim.rate, 0.5);
  assert.equal(stratum.coverageMiss.numerator, 1);
  assert.equal(stratum.coverageMiss.denominator, 3);
  assert.equal(stratum.erroneousPropagation.numerator, 1);
  assert.equal(stratum.erroneousPropagation.denominator, 2);
  assert.equal(stratum.reviewAgreement.numerator, 3);
  assert.equal(stratum.reviewAgreement.denominator, 4);
  assert.equal(stratum.reviewAgreement.rate, 0.75);
  assert.ok(Number.isFinite(stratum.reviewAgreement.cohenKappa));
  assert.deepEqual(stratum.writeLatency, { sampleCount: 3, meanMs: (50 + 200 + 100) / 3, p50Ms: 100, p95Ms: 200, maxMs: 200 });
  assert.equal(stratum.recoverySuccess.rate, 0.5);
  assert.deepEqual(stratum.recoverySuccess.rate95CI, { lower: 0.09453120573423074, upper: 0.9054687942657693 });
  assert.ok(Number.isFinite(stratum.calibration.expectedCalibrationError));
  assert.ok(stratum.calibration.expectedCalibrationError95CI.lower <= stratum.calibration.expectedCalibrationError);
  assert.ok(stratum.calibration.expectedCalibrationError95CI.upper >= stratum.calibration.expectedCalibrationError);
});

test("quality report keeps web/host, risk, and evidence strata separate and fails insufficient strata", () => {
  const report = evaluateMemoryQuality([
    sample("web-1"),
    sample("host-1", { surface: "host" })
  ], {
    minimumSampleCount: 2,
    requiredStrata: [
      { surface: "web", riskClass: "high", evidenceLevel: "direct" },
      { surface: "host", riskClass: "critical", evidenceLevel: "corroborated" }
    ]
  });

  assert.equal(report.passed, false);
  assert.equal(report.strata.length, 3);
  assert.ok(report.strata.every((stratum) => stratum.status === "insufficient" && !stratum.passed));
  assert.deepEqual(report.strata.map((stratum) => stratum.sampleCount).sort(), [0, 1, 1]);
  const empty = report.strata.find((stratum) => stratum.sampleCount === 0);
  assert.equal(empty.finding.precision, null);
  assert.equal(empty.finding.precision95CI, null);
  assert.equal(empty.unsupportedClaim.rate, null);
  assert.equal(empty.coverageMiss.rate, null);
  assert.equal(empty.calibration.expectedCalibrationError, null);
  assert.equal(empty.reviewAgreement.rate, null);
});

test("quality evaluation is deterministic and rejects malformed samples", () => {
  const rows = Array.from({ length: 12 }, (_, index) => sample(`row-${index}`, {
    findingTruth: index % 3 === 0,
    findingDetected: index % 4 === 0,
    findingConfidence: index / 12
  }));
  assert.deepEqual(evaluateMemoryQuality(rows, { minimumSampleCount: 10 }), evaluateMemoryQuality(rows, { minimumSampleCount: 10 }));
  assert.throws(() => evaluateMemoryQuality([sample("bad", { findingConfidence: 1.1 })]), /findingConfidence/);
  assert.throws(() => evaluateMemoryQuality([sample("bad-latency", { writeLatencyMs: -1 })]), /writeLatencyMs/);
  assert.throws(() => evaluateMemoryQuality([sample("bad-recovery", { recoverySucceeded: true })]), /recoveryExpected/);
  assert.throws(() => evaluateMemoryQuality([sample("dup"), sample("dup")]), /duplicate quality sample id/);
  assert.throws(() => evaluateMemoryQuality([sample("claim", { claimMade: true })]), /claimSupported/);
});
