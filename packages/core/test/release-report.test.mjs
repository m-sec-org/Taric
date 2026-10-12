import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseReport, RELEASE_REPORT_VERSION } from "../dist/release-report.js";

const digests = {
  commit: `sha256:${"a".repeat(64)}`,
  schema: `sha256:${"b".repeat(64)}`,
  policy: `sha256:${"c".repeat(64)}`,
  fixture: `sha256:${"d".repeat(64)}`
};

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

test("release report preserves digests, configuration, stratified metrics, and deterministic ordering", () => {
  const rows = [
    sample("b", { findingTruth: false, retrievalTruth: false, findingDetected: false, retrievalReturned: false, findingConfidence: 0.1 }),
    sample("a")
  ];
  const input = {
    samples: rows,
    digests,
    config: {
      minimumSampleCount: 2,
      calibrationBinCount: 4,
      requiredGateIds: ["known-positive-recall"],
      requiredStrata: [{ surface: "web", riskClass: "high", evidenceLevel: "direct" }]
    },
    gates: [{ id: "known-positive-recall", passed: true, expectedEvidence: ["baseline"], actualEvidence: ["fixture-a"] }]
  };
  const report = buildReleaseReport(input);
  const reordered = buildReleaseReport({ ...input, samples: [...rows].reverse() });
  assert.equal(report.version, RELEASE_REPORT_VERSION);
  assert.deepEqual(report.digests, digests);
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
  const report = buildReleaseReport({
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
  const report = buildReleaseReport({
    samples: [sample("a"), sample("b")],
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

test("digests, gates, and configuration are validated", () => {
  const config = { requiredGateIds: ["required"] };
  assert.throws(() => buildReleaseReport({ samples: [], digests: { ...digests, policy: "policy-v1" }, config }), /policy digest.*sha256/);
  assert.throws(() => buildReleaseReport({ samples: [], digests, config: { ...config, minimumSampleCount: 0 } }), /minimumSampleCount/);
  assert.throws(() => buildReleaseReport({ samples: [], digests, config: { requiredGateIds: [] } }), /requiredGateIds/);
  assert.throws(() => buildReleaseReport({ samples: [], digests, config, gates: [{ id: "duplicate", passed: true }, { id: "duplicate", passed: true }] }), /duplicate release gate/);
  assert.throws(() => buildReleaseReport({ samples: [], digests, config, gates: [{ id: "bad", passed: false, reason: " " }] }), /reason/);
  assert.throws(() => buildReleaseReport({ samples: [null], digests, config }), /quality sample id/);
});

