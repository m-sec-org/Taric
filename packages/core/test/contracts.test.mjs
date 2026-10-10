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
  resource: () => ({ ...base(), kind: "resource", asset_type: "endpoint", identity: { origin: "https://example.test", method: "GET", path: "/" }, revision: 1 }),
  observation: () => ({ ...base(), resource_ref: randomUUID(), observed_at: "2026-10-09T00:00:00.000Z", statement: "Observed response", artifact_refs: [{ host_ref: "host-artifact:1" }] }),
  relation: () => ({ ...base(), from_ref: randomUUID(), predicate: "calls", to_ref: randomUUID(), version: 1 }),
  claim: () => ({ ...base(), proposition: "Resource has property", status: "proposed", evidence_refs: [], limitations: [] }),
  workItem: () => ({ ...base(), title: "Review endpoint", status: "queued", acceptance_criteria: ["reviewed"] }),
  evidence: () => ({ ...base(), artifact_ref: { host_ref: "host-artifact:1" }, observed_at: "2026-10-09T00:00:00.000Z", limitations: [] }),
  finding: () => ({ ...base(), title: "Finding", claim_refs: [randomUUID()], evidence_refs: [randomUUID()], review_ref: randomUUID(), status: "verified" }),
  coverageCell: () => ({ ...base(), resource_ref: randomUUID(), test_category: "access-control", status: "blocked_by_control", limitations: [] }),
  negativeObservation: () => ({ ...base(), statement: "bounded negative observation", method: "GET /", baseline_ref: randomUUID(), tested_resource_refs: [randomUUID()], conditions: ["role=user"], evidence_refs: [], limitations: ["single identity"], bounded: true, tested_at: "2026-10-09T00:00:00.000Z" }),
  proposal: () => ({ ...base(), subject_type: "observation", content_hash: `sha256:${"a".repeat(64)}`, status: "pending", base_version: 0 }),
  review: () => ({ ...base(), proposal_ref: randomUUID(), reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: `sha256:${"a".repeat(64)}`, verdict: "pass" }),
  protectiveControl: () => ({ ...base(), name: "WAF", layer: "edge", resource_ref: randomUUID(), control_kind: "waf" }),
  controlObservation: () => ({ ...base(), control_ref: randomUUID(), outcome: "blocked", observed_at: "2026-10-09T00:00:00.000Z", evidence_refs: [], limitations: [] }),
  accessDecisionObservation: () => ({ ...base(), resource_ref: randomUUID(), identity_ref: randomUUID(), operation: "GET /", decision: "deny", observed_at: "2026-10-09T00:00:00.000Z", conditions: [], evidence_refs: [] }),
  attempt: () => ({ ...base(), work_item_ref: randomUUID(), status: "running", generation: 1 }),
  workRun: () => ({ ...base(), work_item_ref: randomUUID(), status: "running", generation: 1 }),
  checkpoint: () => ({ ...base(), work_item_ref: randomUUID(), attempt_ref: randomUUID(), generation: 1, source_read_seq: 1, completed_steps: [], next_steps: [], observation_refs: [], evidence_refs: [], negative_results: [], unresolved_work: [], host_decision_refs: [], external_action_state: "none" }),
  actionIntent: () => ({ ...base(), target: "host-ref", method: "inspect", status: "recommended", mode: "llm_recommend" }),
  auditEvent: () => ({ event_id: randomUUID(), commit_seq: 1, event_type: "record.commit", created_at: "2026-10-09T00:00:00.000Z", hash: `sha256:${"a".repeat(64)}` }),
  apiSuccess: () => ({ ok: true, data: {} }),
  apiError: () => ({ ok: false, error: { code: "validation_error", message: "invalid" } }),
};

const validators = new Map(contractNames.map((name) => [name, schemaValidator.compile({ $ref: `${contractSchema.$id}#/$defs/${name}` })]));
const compileSchema = (name) => validators.get(name);

for (const name of contractNames) {
  test(`${name} accepts valid fixture and rejects invalid fixture`, () => {
    const validate = compileSchema(name);
    assert.equal(validate(fixtures[name]()), true, JSON.stringify(validate.errors));
    const invalid = fixtures[name]();
    if ("engagement_id" in invalid) delete invalid.engagement_id;
    else if (name === "apiSuccess") delete invalid.data;
    else if (name === "apiError") delete invalid.error;
    else if (name === "auditEvent") delete invalid.event_type;
    assert.equal(validate(invalid), false);
    const extra = fixtures[name]();
    extra.unexpected = true;
    if (name !== "recordBase" && name !== "scope" && name !== "engagement" && name !== "resource" && name !== "observation" && name !== "relation" && name !== "claim" && name !== "workItem" && name !== "evidence" && name !== "finding" && name !== "coverageCell" && name !== "proposal" && name !== "review") assert.equal(validate(extra), false);
  });
}

test("reference schemas reject malformed UUID identifiers", () => {
  const validate = compileSchema("relation");
  const invalid = fixtures.relation();
  invalid.to_ref = "not-a-uuid";
  assert.equal(validate(invalid), false);
});
