import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { coreSchema: contractSchema, contractNames } = await import("@taric/schemas");
const { schemaValidator } = await import("../dist/validation.js");
schemaValidator.addSchema(contractSchema);


const base = () => ({
  id: randomUUID(), schema_version: "1.0.0", engagement_id: randomUUID(),
  created_at: "2026-10-09T00:00:00.000Z",
  provenance: { host_id: "test-host", producer_id: "test-agent", source_kind: "worker" },
});
const fixtures = {
  scope: () => ({ ...base(), allowed_targets: ["https://example.test"], excluded_targets: [], rules_of_engagement_ref: "roe-1" }),
  engagement: () => ({ ...base(), name: "test", scope_ref: randomUUID(), status: "active" }),
  resource: () => ({ ...base(), kind: "endpoint", identity: { origin: "https://example.test", method: "GET", path: "/" }, revision: 1 }),
  observation: () => ({ ...base(), resource_ref: randomUUID(), observed_at: "2026-10-09T00:00:00.000Z", statement: "Observed response", artifact_refs: [{ host_ref: "host-artifact:1" }] }),
  relation: () => ({ ...base(), from_ref: randomUUID(), predicate: "calls", to_ref: randomUUID(), version: 1 }),
  claim: () => ({ ...base(), proposition: "Resource has property", status: "proposed", evidence_refs: [], limitations: [] }),
  workItem: () => ({ ...base(), title: "Review endpoint", status: "queued", acceptance_criteria: ["reviewed"] }),
  evidence: () => ({ ...base(), artifact_ref: { host_ref: "host-artifact:1" }, observed_at: "2026-10-09T00:00:00.000Z", limitations: [] }),
  finding: () => ({ ...base(), title: "Finding", claim_refs: [randomUUID()], evidence_refs: [randomUUID()], review_ref: randomUUID(), status: "verified" }),
  coverageCell: () => ({ ...base(), resource_ref: randomUUID(), test_category: "access-control", status: "blocked_by_control", limitations: [] }),
  proposal: () => ({ ...base(), subject_type: "observation", content_hash: `sha256:${"a".repeat(64)}`, status: "pending", base_version: 0 }),
  review: () => ({ ...base(), proposal_ref: randomUUID(), reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: `sha256:${"a".repeat(64)}`, verdict: "pass" }),
};

const validators = new Map(contractNames.map((name) => [name, schemaValidator.compile({ $ref: `${contractSchema.$id}#/$defs/${name}` })]));
const compileSchema = (name) => validators.get(name);

for (const name of contractNames) {
  test(`${name} accepts valid fixture and rejects invalid fixture`, () => {
    const validate = compileSchema(name);
    assert.equal(validate(fixtures[name]()), true, JSON.stringify(validate.errors));
    const invalid = fixtures[name]();
    delete invalid.engagement_id;
    assert.equal(validate(invalid), false);
  });
}

test("reference schemas reject malformed UUID identifiers", () => {
  const validate = compileSchema("relation");
  const invalid = fixtures.relation();
  invalid.to_ref = "not-a-uuid";
  assert.equal(validate(invalid), false);
});
