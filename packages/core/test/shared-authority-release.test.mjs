import test from "node:test";
import assert from "node:assert/strict";
import { buildSharedAuthorityReleaseEvidence } from "../dist/shared-authority-release.js";

const required_gate_ids = ["storage-conformance", "lease-fencing", "reader-pin", "failure-recovery", "backup-restore"];
const validBackup = {
  verified: true,
  schema_version: "taric-schema/1",
  source_sequence: 72,
  recovered_sequence: 72,
  backup_timestamp: "2026-10-12T00:00:00.000Z",
  integrity: `sha256:${"a".repeat(64)}`,
  engagement_id: "engagement-1",
  provenance_verified: true,
  revisions_verified: true,
  unresolved_errors: [],
};
const gates = required_gate_ids.map((id) => ({ id, passed: true, evidence: [`test:${id}`] }));

test("single-host evidence explicitly reports Phase 5 disabled", () => {
  const report = buildSharedAuthorityReleaseEvidence({ schema_version: "taric-schema/1", policy_digest: `sha256:${"b".repeat(64)}` });
  assert.equal(report.status, "disabled");
  assert.equal(report.enabled, false);
  assert.equal(report.profile, "single_host_sqlite");
  assert.equal(report.schema_version, "taric-schema/1");
  assert.match(report.schema_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(report.policy_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.backup, null);
  assert.equal(report.recovered_sequence, null);
  assert.deepEqual(report.failures, []);
});

test("multi-host release fails closed when conformance or recovery evidence is missing", () => {
  const report = buildSharedAuthorityReleaseEvidence({
    profile: "multi_host_authority",
    backend: "postgresql",
    host_count: 2,
    authority_service: { configured: true, available: true, shared: true, count: 1 },
    required_gate_ids,
    gates,
    conformance: { passed: true, suite_version: "storage-conformance/1", evidence: ["ci:run-42"] },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.enabled, false);
  assert.equal(report.recovered_sequence, null);
  assert.ok(report.failures.some((failure) => /backup\/restore metadata/.test(failure)));
});

test("multi-host release is enabled only with passing gates and complete verified recovery metadata", () => {
  const report = buildSharedAuthorityReleaseEvidence({
    profile: "multi_host_authority",
    backend: "postgresql",
    host_count: 2,
    authority_service: { configured: true, available: true, shared: true, count: 1 },
    schema_version: "taric-schema/1",
    schema_digest: `sha256:${"c".repeat(64)}`,
    policy_digest: `sha256:${"d".repeat(64)}`,
    required_gate_ids,
    gates,
    backup: validBackup,
    conformance: { passed: true, suite_version: "storage-conformance/1", evidence: ["ci:run-42"] },
  });
  assert.equal(report.status, "enabled");
  assert.equal(report.enabled, true);
  assert.equal(report.schema_version, "taric-schema/1");
  assert.equal(report.schema_digest, `sha256:${"c".repeat(64)}`);
  assert.equal(report.recovered_sequence, 72);
  assert.equal(report.backup.engagement_id, "engagement-1");
  assert.deepEqual(report.failures, []);
});

test("missing required gates and unresolved restore errors block enablement", () => {
  const report = buildSharedAuthorityReleaseEvidence({
    profile: "multi_host_authority",
    backend: "postgresql",
    authority_service: { configured: true, available: true, shared: true, count: 1 },
    gates: [{ id: "storage-conformance", passed: false, reason: "PostgreSQL CAS diverged" }],
    backup: { ...validBackup, unresolved_errors: ["record reference missing"] },
    conformance: { passed: false },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.enabled, false);
  assert.ok(report.failures.some((failure) => /PostgreSQL CAS diverged/.test(failure)));
  assert.ok(report.failures.some((failure) => /required gate lease-fencing has no outcome/.test(failure)));
  assert.ok(report.failures.some((failure) => /conformance did not pass/.test(failure)));
  assert.ok(report.failures.some((failure) => /backup\/restore metadata/.test(failure)));
});

