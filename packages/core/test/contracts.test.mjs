import test from "node:test";
import assert from "node:assert/strict";
import { uuidv7 as randomUUID } from "../dist/index.js";

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
  relation: () => ({ ...base(), from_ref: randomUUID(), from_type: "resource", predicate: "calls", to_ref: randomUUID(), to_type: "resource", version: 1, source_observation_refs: [randomUUID()], valid_from: "2026-10-09T00:00:00.000Z", criticality: "medium" }),
  claim: () => ({ ...base(), proposition: "Resource has property", status: "proposed", evidence_refs: [], limitations: [] }),
  workItem: () => ({ ...base(), title: "Review endpoint", status: "queued", acceptance_criteria: ["reviewed"] }),
  evidence: () => ({ ...base(), artifact_ref: { host_ref: "host-artifact:1" }, observed_at: "2026-10-09T00:00:00.000Z", limitations: [] }),
  finding: () => ({ ...base(), title: "Finding", claim_refs: [randomUUID()], evidence_refs: [randomUUID()], review_ref: randomUUID(), policy_digest: `sha256:${"a".repeat(64)}`, status: "verified" }),
  coverageCell: () => ({ ...base(), resource_ref: randomUUID(), test_category: "access-control", status: "blocked_by_control", limitations: [] }),
  negativeObservation: () => ({ ...base(), statement: "bounded negative observation", method: "GET /", baseline_ref: randomUUID(), tested_resource_refs: [randomUUID()], conditions: ["role=user"], evidence_refs: [], limitations: ["single identity"], bounded: true, tested_at: "2026-10-09T00:00:00.000Z" }),
  proposal: () => ({ ...base(), subject_type: "observation", content_hash: `sha256:${"a".repeat(64)}`, status: "pending", expected_version: 0 }),
  proposalCandidate: () => ({ schema_version: "1.0.0", engagement_id: randomUUID(), kind: "claim", proposition: "candidate", status: "proposed", evidence_refs: [], limitations: [] }),
  proposalEnvelope: () => ({ engagement_id: randomUUID(), subject_type: "claim", expected_version: 0, content: fixtures.proposalCandidate() }),
  proposalProvenance: () => ({ host_id: "pi", producer_id: "model", source_kind: "model" }),
  promotionL2: () => ({ engagement_id: randomUUID(), proposal_id: randomUUID(), target_id: randomUUID(), expected_version: 1, input_hash: `sha256:${"a".repeat(64)}`, evidence_snapshot_hash: `sha256:${"b".repeat(64)}`, policy_digest: `sha256:${"c".repeat(64)}`, review_refs: [randomUUID()] }),
  review: () => ({ ...base(), proposal_ref: randomUUID(), reviewer_id: "reviewer-b", reviewer_kind: "reviewer", input_hash: `sha256:${"a".repeat(64)}`, verdict: "pass" }),
  protectiveControl: () => ({ ...base(), name: "WAF", layer: "edge", resource_ref: randomUUID(), control_kind: "waf" }),
  controlObservation: () => ({ ...base(), control_ref: randomUUID(), outcome: "inconclusive", observed_at: "2026-10-09T00:00:00.000Z", evidence_refs: [], limitations: [] }),
  accessDecisionObservation: () => ({ ...base(), resource_ref: randomUUID(), identity_ref: randomUUID(), operation: "GET /", decision: "deny", observed_at: "2026-10-09T00:00:00.000Z", conditions: [], evidence_refs: [] }),
  attempt: () => ({ ...base(), work_item_ref: randomUUID(), status: "running", generation: 1 }),
  workRun: () => ({ ...base(), work_item_ref: randomUUID(), status: "running", generation: 1 }),
  checkpoint: () => ({ ...base(), work_item_ref: randomUUID(), work_run_ref: randomUUID(), attempt_ref: randomUUID(), generation: 1, target_version: 1, work_item_version: 1, scope_version: 0, owner: { host_id: "pi", agent_id: "worker" }, lease_expires_at: "2026-10-09T00:02:00.000Z", source_read_seq: 1, completed_steps: [], next_steps: [], observation_refs: [], evidence_refs: [], negative_results: [], unresolved_work: [], host_decision_refs: [], external_action_state: "none", budget: {}, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [], context_manifest: { context_snapshot_id: randomUUID(), read_seq: 1, builder_version: "context/1.0" } }),
  actionIntent: () => ({ ...base(), target: "host-ref", method: "inspect", status: "recommended", mode: "llm_recommend" }),
  artifactSessionBinding: () => ({ engagement_id: randomUUID(), session_id: "session-1", root: "/tmp/session-1" }),
  artifactStoreBegin: () => ({ engagement_id: randomUUID(), session_id: "session-1", payload_kind: "binary", media_type: "application/octet-stream" }),
  artifactStoreAppend: () => ({ engagement_id: randomUUID(), session_id: "session-1", upload_id: "upload-1", ordinal: 0, chunk_hash: `sha256:${"a".repeat(64)}`, data: "YQ==", encoding: "base64" }),
  artifactStoreCommit: () => ({ engagement_id: randomUUID(), session_id: "session-1", upload_id: "upload-1", total_bytes: 1, content_hash: `sha256:${"a".repeat(64)}` }),
  artifactContentRead: () => ({ engagement_id: randomUUID(), session_id: "session-1", content_ref: "artifact-1@v1", offset: 0, length: 1 }),
  artifactContentList: () => ({ engagement_id: randomUUID(), session_id: "session-1", page_size: 10 }),
  artifactSessionOutput: () => ({ engagement_id: randomUUID(), session_id: "session-1", page_size: 10, include_content: false }),
  auditEvent: () => ({ event_id: randomUUID(), commit_seq: 1, event_type: "record.commit", created_at: "2026-10-09T00:00:00.000Z", hash: `sha256:${"a".repeat(64)}` }),
  apiSuccess: () => ({ ok: true, data: {} }),
  apiError: () => ({ ok: false, error: { code: "validation_error", message: "invalid" } }),
  resourceRevision: () => ({ ...base(), id: "01933f30-7b00-7abc-8def-0123456789ab", resource_ref: randomUUID(), revision: 1, logical_identity: { host: "example.test" }, variant: { method: "GET", path_template: "/" }, content_hash: `sha256:${"a".repeat(64)}`, source_observation_refs: [randomUUID()], valid_from: "2026-10-09T00:00:00.000Z" }),
  testHypothesis: () => ({ ...base(), title: "Test hypothesis", proposition: "Response differs by role", status: "proposed", version: 1, source_observation_refs: [randomUUID()], limitations: ["one principal"], valid_from: "2026-10-09T00:00:00.000Z", criticality: "medium" }),
  attackPath: () => ({ ...base(), title: "Attack path", status: "proposed", version: 1, steps: [{ subject_type: "resource_revision", subject_ref: randomUUID() }], source_observation_refs: [randomUUID()], valid_from: "2026-10-09T00:00:00.000Z", criticality: "high" }),
  patchSet: () => ({ ...base(), base_generation: 1, read_set: [{ entity_ref: randomUUID(), version: 1 }], write_set: [{ entity_ref: randomUUID(), base_version: 1 }], operations: ["replace_property"], source_refs: [randomUUID()], content_hash: `sha256:${"b".repeat(64)}`, merge_status: "merged" }),
  conflict: () => ({ ...base(), subject_ref: randomUUID(), field_path: "status", base_version: 1, current_version: 2, candidates: [{ value: "open", source_refs: [randomUUID()] }, { value: "closed", source_refs: [randomUUID()] }], source_refs: [randomUUID(), randomUUID()], diff: { status: "closed" }, merge_status: "open" }),
  impactEvent: () => ({ ...base(), source_ref: randomUUID(), changed_dependency_ref: randomUUID(), affected_refs: [randomUUID()], criticality: "high", disposition: "requires_revalidation", reason_code: "resource_changed" }),
  protectiveControlRevision: () => ({ ...base(), control_ref: randomUUID(), revision: 1, layer: "edge", protected_resource_revision_refs: [randomUUID()], identity_conditions: ["anonymous"], network_conditions: ["https"], valid_from: "2026-10-09T00:00:00.000Z", source_observation_refs: [randomUUID()] }),
  controlApplicabilityEvent: () => ({ ...base(), subject_refs: [randomUUID()], changed_dependency_ref: randomUUID(), affected_current_view_refs: [randomUUID()], disposition: "requires_revalidation", reason_code: "control_changed", committed_at: "2026-10-09T00:00:00.000Z" }),
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
    else if (name === "proposalProvenance") delete invalid.source_kind;
    assert.equal(validate(invalid), false);
    const extra = fixtures[name]();
    extra.unexpected = true;
    if (!["recordBase", "scope", "engagement", "resource", "observation", "relation", "claim", "workItem", "evidence", "finding", "coverageCell", "proposal", "review", "proposalCandidate"].includes(name)) assert.equal(validate(extra), false);
  });
}

test("reference schemas reject malformed UUID identifiers", () => {
  const validate = compileSchema("relation");
  const invalid = fixtures.relation();
  invalid.to_ref = "not-a-uuid";
  assert.equal(validate(invalid), false);
});

test("Artifact references require either an external locator or an opaque content reference", () => {
  const validate = schemaValidator.compile({ $ref: `${contractSchema.$id}#/$defs/artifactReference` });
  const local = { content_ref: `${randomUUID()}@v1`, artifact_id: randomUUID(), version: 1, storage_mode: "taric_stored", content_status: "available", payload_kind: "binary", media_type: "application/octet-stream", byte_length: 1, chunk_count: 1, content_hash: `sha256:${"a".repeat(64)}` };
  assert.equal(validate(local), true, JSON.stringify(validate.errors));
  const external = { host_ref: "opaque-host-ref", storage_mode: "external", content_status: "external" };
  assert.equal(validate(external), true, JSON.stringify(validate.errors));
  assert.equal(validate({ media_type: "application/octet-stream" }), false);
  assert.equal(validate({ ...local, arbitrary_path: "/tmp/payload" }), false);
});
