import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseReport, RELEASE_REPORT_VERSION, verifyReleaseReport } from "../dist/release-report.js";
import { QUALITY_CONFIDENCE_INTERVAL_METHOD, qualitySampleDigest } from "../dist/quality.js";

const digests = {
  commit: `sha256:${"a".repeat(64)}`,
  schema: `sha256:${"b".repeat(64)}`,
  policy: `sha256:${"c".repeat(64)}`,
  sample: `sha256:${"d".repeat(64)}`,
  fixture: `sha256:${"e".repeat(64)}`
};
const digestsFor = (samples, overrides = {}) => ({ ...digests, sample: qualitySampleDigest(samples), ...overrides });

function sample(id, overrides = {}) {
  return {
    id,
    surface: "web",
    riskClass: "high",
    evidenceLevel: "direct",
    findingTruth: true,
    retrievalTruth: true,
    findingDetected: true,
    retrievalReturned: true,
    humanFindingDetected: true,
    humanRetrievalReturned: true,
    findingConfidence: 0.9,
    ...overrides
  };
}
const provenance = (samples) => ({ kind: "human_annotated", dataset_version: "test-dataset/1", strata_version: "web-host-risk-evidence/1", sample_digest: qualitySampleDigest(samples), annotators: [{ id: "annotator-a", role: "annotator" }, { id: "adjudicator-b", role: "adjudicator" }], review_process: "independent blind labeling followed by adjudication", time_range: { from: "2026-10-01T00:00:00Z", to: "2026-10-12T00:00:00Z" }, human_baseline: { source_ref: "test:baseline/1", protocol: "blinded same-query comparison", blinded: true }, annotation_agreement: { metric: "cohen_kappa", value: 0.82, sample_count: samples.length }, confidence_interval_method: QUALITY_CONFIDENCE_INTERVAL_METHOD });
const build = (input) => buildReleaseReport({ ...input, digests: { ...input.digests, sample: qualitySampleDigest(input.samples) } });

test("release report preserves digests, configuration, stratified metrics, and deterministic ordering", () => {
  const rows = [
    sample("b", { findingTruth: false, retrievalTruth: false, findingDetected: false, retrievalReturned: false, findingConfidence: 0.1 }),
    sample("a")
  ];
  const input = {
    samples: rows,
    quality_provenance: provenance(rows),
    digests,
    config: {
      minimumSampleCount: 2,
      calibrationBinCount: 4,
      requiredGateIds: ["known-positive-recall"],
      requiredStrata: [{ surface: "web", riskClass: "high", evidenceLevel: "direct" }]
    },
    gates: [{ id: "known-positive-recall", passed: true, expectedEvidence: ["baseline"], actualEvidence: ["fixture-a"] }]
  };
  const report = build(input);
  const reordered = build({ ...input, samples: [...rows].reverse() });
  assert.equal(report.version, RELEASE_REPORT_VERSION);
  assert.deepEqual(report.digests, digestsFor(rows));
  assert.deepEqual(report.configuration, {
    minimumSampleCount: 2,
    calibrationBinCount: 4,
    requiredGateIds: ["known-positive-recall"],
    requiredStrata: [{ surface: "web", riskClass: "high", evidenceLevel: "direct" }]
  });
  assert.equal(report.sampleCount, 2);
  assert.equal(report.quality.passed, true);
  assert.equal(report.strata[0].sampleCount, 2);
  assert.equal(report.strata[0].finding.precision, 1);
  assert.ok(report.strata[0].finding.precision95CI);
  assert.ok(report.strata[0].calibration.expectedCalibrationError95CI);
  assert.deepEqual(report, reordered);
});

test("required gate failures and insufficient strata fail closed with evidence", () => {
  const report = build({
    samples: [sample("only")],
    digests,
    config: {
      minimumSampleCount: 2,
      requiredGateIds: ["coverage-visibility", "adapter-compatibility"],
      requiredStrata: [
        { surface: "web", riskClass: "high", evidenceLevel: "direct" },
        { surface: "host", riskClass: "critical", evidenceLevel: "corroborated" }
      ]
    },
    gates: [
      {
        id: "coverage-visibility",
        passed: false,
        reason: "blocked cells were omitted",
        expectedEvidence: ["blocked cell"],
        actualEvidence: ["projection output"]
      },
      { id: "advisory-only", required: false, passed: false, reason: "informational" }
    ]
  });
  assert.equal(report.passed, false);
  assert.equal(report.quality.passed, false);
  assert.equal(report.gates.length, 3);
  assert.deepEqual(report.failures[0], {
    kind: "required-gate",
    gateId: "adapter-compatibility",
    reason: "required gate adapter-compatibility has no outcome",
    expectedEvidence: ["passed=true"],
    actualEvidence: [],
    evidence: []
  });
  assert.deepEqual(report.failures[1], {
    kind: "required-gate",
    gateId: "coverage-visibility",
    reason: "blocked cells were omitted",
    expectedEvidence: ["blocked cell"],
    actualEvidence: ["projection output"],
    evidence: []
  });
  assert.equal(report.failures.filter((failure) => failure.kind === "insufficient-stratum").length, 2);
  assert.equal(report.failures.some((failure) => failure.kind === "quality-evaluation"), false);
});

test("an optional failed gate does not block a sufficiently sampled quality report", () => {
  const report = build({
    samples: [sample("a"), sample("b")],
    quality_provenance: provenance([sample("a"), sample("b")]),
    digests,
    config: { minimumSampleCount: 2, requiredGateIds: ["required-pass"] },
    gates: [
      { id: "required-pass", passed: true },
      { id: "advisory-only", required: false, passed: false, reason: "informational" }
    ]
  });
  assert.equal(report.quality.passed, true);
  assert.equal(report.passed, true);
  assert.equal(report.gates.find((gate) => gate.id === "advisory-only").passed, false);
  assert.deepEqual(report.failures, []);
});

test("quality release evidence fails closed without real annotation provenance or a pinned sample", () => {
  const samples = [sample("a"), sample("b")];
  const input = { samples, digests, config: { minimumSampleCount: 2, requiredGateIds: ["required-pass"] }, gates: [{ id: "required-pass", passed: true }] };
  const missing = build(input);
  assert.equal(missing.passed, false); assert.equal(missing.evidence_state, "pending");
  assert.ok(missing.failures.some((failure) => failure.kind === "quality-provenance"));
  const synthetic = build({ ...input, quality_provenance: { ...provenance(samples), kind: "synthetic_fixture" } });
  assert.equal(synthetic.passed, false); assert.match(synthetic.failures.at(-1).reason, /synthetic fixtures/);
  const changed = build({ ...input, samples: [sample("a", { findingTruth: false }), sample("b")], quality_provenance: provenance(samples) });
  assert.equal(changed.passed, false); assert.ok(changed.failures.some((failure) => /digest/.test(failure.reason)));
  const insufficient = build({ ...input, config: { ...input.config, minimumSampleCount: 30 }, quality_provenance: provenance(samples) });
  assert.equal(insufficient.passed, false); assert.ok(insufficient.failures.some((failure) => failure.kind === "insufficient-stratum"));
});

test("capability state consistency is a required release gate", () => {
  const samples = [sample("a"), sample("b")];
  const report = build({ samples, digests, quality_provenance: provenance(samples), config: { minimumSampleCount: 2, requiredGateIds: ["required"] }, gates: [{ id: "required", passed: true }], capabilities: [{ id: "primitive-only", state: "supported", implementation_state: "available", runtime_state: "disabled", evidence_state: "pending", evidence: ["test:primitive"], follow_up_state: "pending", detail: "partial" }] });
  assert.equal(report.passed, false); assert.equal(report.failures.filter((failure) => failure.kind === "capability-evidence").length, 2);
});

test("digests, gates, and configuration are validated", () => {
  const config = { requiredGateIds: ["required"] };
  const emptyDigests = digestsFor([]);
  assert.throws(() => buildReleaseReport({ samples: [], digests: { ...emptyDigests, policy: "policy-v1" }, config }), /policy digest.*sha256/);
  assert.throws(() => buildReleaseReport({ samples: [], digests: emptyDigests, config: { ...config, minimumSampleCount: 0 } }), /minimumSampleCount/);
  assert.throws(() => buildReleaseReport({ samples: [], digests: emptyDigests, config: { requiredGateIds: [] } }), /requiredGateIds/);
  assert.throws(() => buildReleaseReport({ samples: [], digests: emptyDigests, config, gates: [{ id: "duplicate", passed: true }, { id: "duplicate", passed: true }] }), /duplicate release gate/);
  assert.throws(() => buildReleaseReport({ samples: [], digests: emptyDigests, config, gates: [{ id: "bad", passed: false, reason: " " }] }), /reason/);
  assert.throws(() => buildReleaseReport({ samples: [null], digests: emptyDigests, config }), /quality sample id/);
});

test("quality provenance requires agreement and the evaluator confidence interval method", () => {
  const samples = [sample("a"), sample("b")];
  const input = { samples, digests: digestsFor(samples), config: { minimumSampleCount: 2, requiredGateIds: ["required"] }, gates: [{ id: "required", passed: true }] };
  const missingAgreement = buildReleaseReport({ ...input, quality_provenance: { ...provenance(samples), annotation_agreement: undefined } });
  assert.equal(missingAgreement.passed, false);
  assert.ok(missingAgreement.failures.some((failure) => failure.reason.includes("agreement")));
  const partialAgreement = build({ ...input, quality_provenance: { ...provenance(samples), annotation_agreement: { metric: "cohen_kappa", value: 0.82, sample_count: 1 } } });
  assert.equal(partialAgreement.passed, false);
  assert.ok(partialAgreement.failures.some((failure) => failure.reason.includes("every sample")));
  const wrongMethod = buildReleaseReport({ ...input, quality_provenance: { ...provenance(samples), confidence_interval_method: "wilson_only" } });
  assert.equal(wrongMethod.passed, false);
  assert.ok(wrongMethod.failures.some((failure) => failure.reason.includes("confidence interval")));
});

test("release report verification rejects stale, failed, and incomplete reports deterministically", () => {
  const samples = [sample("a"), sample("b")];
  const report = build({ samples, digests, quality_provenance: provenance(samples), config: { minimumSampleCount: 2, requiredGateIds: ["required"] }, gates: [{ id: "required", passed: true }] });
  assert.deepEqual(verifyReleaseReport(report, report.digests), { activatable: true, failures: [] });

  const stale = verifyReleaseReport({ ...report, digests: { ...report.digests, policy: `sha256:${"e".repeat(64)}` } }, report.digests);
  assert.equal(stale.activatable, false);
  assert.deepEqual(stale.failures, [{ kind: "stale-report", reason: "policy digest does not match the current release identity" }]);

  const failed = verifyReleaseReport({ ...report, passed: false, evidence_state: "failed", failures: [{ kind: "required-gate", gateId: "required" }] }, report.digests);
  assert.equal(failed.activatable, false);
  assert.deepEqual(failed.failures, [
    { kind: "failed-report", reason: "release report is not verified" },
    { kind: "failed-report", reason: "release report contains failed evidence" }
  ]);

  const incomplete = verifyReleaseReport({ ...report, quality_provenance: null }, report.digests);
  assert.equal(incomplete.activatable, false);
  assert.deepEqual(incomplete.failures, [{ kind: "invalid-report", reason: "quality evidence provenance is required" }]);

  const forgedCounts = verifyReleaseReport({ ...report, sampleCount: report.sampleCount + 1 }, report.digests);
  assert.equal(forgedCounts.activatable, false);
  assert.ok(forgedCounts.failures.some((failure) => failure.reason.includes("sample count")));

  const forgedMetric = structuredClone(report);
  forgedMetric.strata = structuredClone(report.strata);
  forgedMetric.quality.strata[0].finding.precision = 0;
  const forgedMetricResult = verifyReleaseReport(forgedMetric, report.digests);
  assert.equal(forgedMetricResult.activatable, false);
  assert.ok(forgedMetricResult.failures.some((failure) => failure.reason.includes("strata projection")));

  const malformedProvenance = verifyReleaseReport({ ...report, quality_provenance: { ...report.quality_provenance, annotators: [null] } }, report.digests);
  assert.equal(malformedProvenance.activatable, false);
  assert.ok(malformedProvenance.failures.some((failure) => failure.reason.includes("annotator provenance")));

  const partialAgreement = verifyReleaseReport({ ...report, quality_provenance: { ...report.quality_provenance, annotation_agreement: { metric: "cohen_kappa", value: 0.82, sample_count: 1 } } }, report.digests);
  assert.equal(partialAgreement.activatable, false);
  assert.ok(partialAgreement.failures.some((failure) => failure.reason.includes("cover every sample")));
});

