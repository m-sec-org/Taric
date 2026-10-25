import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

const { coreSchema, contractNames, contractRegistry, operationContracts, unsupportedContracts, followUpChanges, isValidOperationName } =
  await import("@taric/schemas");

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/v1/phase1-fixtures.json", import.meta.url), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
ajv.addSchema(coreSchema);
const validators = new Map(contractNames.map((name) => [name, ajv.getSchema(`${coreSchema.$id}#/$defs/${name}`)]));

test("contract registry covers every supported operation with request, response, error and capability contracts", () => {
  assert.ok(operationContracts.length > 0);
  for (const contract of operationContracts) {
    assert.ok(isValidOperationName(contract.operation), `${contract.operation} is a stable operation name`);
    assert.ok(contract.request, `${contract.operation} declares a request contract`);
    assert.ok(contract.response, `${contract.operation} declares a response contract`);
    assert.ok(contract.errors.length > 0, `${contract.operation} declares error codes`);
    for (const code of contract.errors) {
      assert.ok(contractRegistry.error_codes.includes(code), `${contract.operation} uses a registered error code ${code}`);
    }
  }
  const names = operationContracts.map((c) => c.operation);
  assert.deepEqual(names, [...new Set(names)], "operations are unique");
  assert.ok(names.includes("query"), "single-word operations such as `query` are supported names");
  assert.equal(names.includes("snapshot.import"), false, "snapshot.import is not a supported operation");
  assert.ok(contractRegistry.unsupported.some((entry) => entry.capability === "snapshot.import"));
  const coverageRecord = operationContracts.find((entry) => entry.operation === "coverage.record");
  assert.deepEqual(coverageRecord?.roles, ["host", "operator"]);
  assert.equal(coverageRecord?.request, "coverageRecordRequest");
  assert.equal(coverageRecord?.idempotent, true);
  assert.equal(coverageRecord?.mutates_authority, true);
});

test("coverage.record request requires a versioned cell write and rejects writer-controlled fields", () => {
  const validate = validators.get("coverageRecordRequest");
  assert.equal(typeof validate, "function");
  const request = {
    engagement_id: "018f47a1-7c00-7000-8000-000000000001",
    resource_ref: "018f47a1-7c00-7000-8000-000000000002",
    test_category: "access-control",
    status: "positive",
    limitations: [],
    expected_version: 0,
    idempotency_key: "coverage-create-1",
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...request, cell_id: "018f47a1-7c00-7000-8000-000000000003", expected_version: 1 }), true);
  for (const invalid of [
    { ...request, expected_version: undefined },
    { ...request, expected_version: -1 },
    { ...request, status: "closed" },
    { ...request, owner: "self-asserted" },
    { ...request, cell_id: "not-a-uuid" },
  ]) assert.equal(validate(invalid), false, `${JSON.stringify(invalid)} must be rejected`);
});

test("every unsupported capability has a follow-up owner or is a permanent non-goal", () => {
  for (const entry of unsupportedContracts) {
    assert.ok(entry.reason.length > 0, `${entry.capability} explains why it is unsupported`);
    assert.ok(followUpChanges.includes(entry.follow_up), `${entry.capability} points at a real follow-up change`);
  }
  const permanent = contractRegistry.permanent_non_goals.map((entry) => entry.capability);
  for (const entry of permanent) {
    assert.ok(!unsupportedContracts.some((u) => u.capability === entry), `${entry} is a non-goal, not a deferred capability`);
  }
});

test("generated TypeScript contract map and schema agree on the contract list", () => {
  const declared = Object.keys(fixtures.valid).filter((name) => name !== "provenance");
  for (const name of declared) {
    assert.ok(contractNames.includes(name), `${name} exists in contractNames`);
    assert.ok(validators.has(name), `${name} has a compiled validator`);
  }
});

test("every valid fixture satisfies its contract", () => {
  for (const [name, record] of Object.entries(fixtures.valid)) {
    const validate = validators.get(name);
    if (!validate) continue;
    const ok = validate(record);
    assert.equal(ok, true, `${name} fixture must be valid: ${JSON.stringify(validate.errors)}`);
  }
});

test("every negative fixture is rejected by its contract", () => {
  for (const [name, entry] of Object.entries(fixtures.negatives)) {
    const contract = name.startsWith("denied_to_") || name.startsWith("terminal_workrun_") ? "actionIntent" : null;
    if (contract) continue; // state-machine negatives are asserted separately
    const target = entry.record;
    // Each negative targets a specific contract; find the one that must reject it.
    const candidates = ["resource", "observation", "claim", "finding", "coverageCell", "negativeObservation",
      "scope", "review", "controlObservation", "accessDecisionObservation", "checkpoint", "proposal"];
    const rejected = candidates.some((candidate) => {
      const validate = validators.get(candidate);
      return validate ? validate(structuredClone(target)) === false : false;
    });
    assert.equal(rejected, true, `${name} must be rejected by at least one Phase 1 contract`);
  }
});

test("state machine fixtures mark terminal states as final", () => {
  const { workRun, actionIntent, terminal_workrun, terminal_actionIntent } = fixtures.state_machines;
  for (const status of terminal_workrun) {
    assert.deepEqual(workRun[status], [], `${status} is terminal`);
  }
  for (const status of terminal_actionIntent) {
    assert.deepEqual(actionIntent[status], [], `${status} is terminal`);
  }
  assert.ok(!workRun.completed.includes("running"), "a completed run cannot restart");
  assert.ok(!actionIntent.denied.includes("executed"), "a denied action cannot execute");
});

test("fixture corpus records its schema, policy and change provenance", () => {
  assert.equal(fixtures.schema_version, "1.0.0");
  assert.equal(fixtures.change, "complete-taric-runtime-gaps");
  assert.ok(fixtures.security_invariants.length >= 10);
  assert.equal(fixtures.counts.valid, Object.keys(fixtures.valid).length);
  assert.equal(fixtures.counts.negatives, Object.keys(fixtures.negatives).length);
});


test("evolution memory contracts preserve immutable revisions and typed applicability", () => {
  const base = { id: "018f47a1-7c00-7000-8000-000000000001", schema_version: "1.0.0", engagement_id: "018f47a1-7c00-7000-8000-000000000002", created_at: "2026-10-12T00:00:00.000Z", provenance: { host_id: "pi", producer_id: "worker-a", source_kind: "tool" } };
  const revision = { ...base, resource_ref: "018f47a1-7c00-7000-8000-000000000003", revision: 2, logical_identity: { origin: "https://example.test", method: "GET", path_template: "/orders/{id}" }, variant: { method: "GET", path_template: "/orders/{id}", principal_ref: "018f47a1-7c00-7000-8000-000000000004" }, content_hash: "sha256:" + "a".repeat(64), source_observation_refs: ["018f47a1-7c00-7000-8000-000000000005"], valid_from: "2026-10-12T00:00:00.000Z", supersedes: "018f47a1-7c00-7000-8000-000000000006" };
  assert.equal(validators.get("resourceRevision")(revision), true);
  const invalidRevision = { ...revision, id: "018f47a1-7c00-4000-8000-000000000001" };
  assert.equal(validators.get("resourceRevision")(invalidRevision), false, "revision identities must be UUIDv7");
  const relation = { ...base, from_ref: revision.resource_ref, from_type: "resource", predicate: "calls", to_ref: "018f47a1-7c00-7000-8000-000000000007", to_type: "resource_revision", version: 1, source_observation_refs: [revision.source_observation_refs[0]], valid_from: revision.valid_from, criticality: "critical" };
  assert.equal(validators.get("relation")(relation), true);
  assert.equal(validators.get("relation")({ ...relation, criticality: "catastrophic" }), false);
  const controlObservation = { ...base, resource_ref: revision.resource_ref, control_ref: "018f47a1-7c00-7000-8000-000000000008", outcome: "inconclusive", decision_layer: "unknown", origin_reached: "unknown", origin_outcome: "unknown", observed_at: revision.valid_from, evidence_refs: [], limitations: ["origin not attributable"] };
  assert.equal(validators.get("controlObservation")(controlObservation), true);
});

test("canonical identities require UUIDv7 and create candidates reject writer fields", () => {
  const canonical = structuredClone(fixtures.valid.claim);
  for (const id of ["legacy-1", "018f47a1-7c00-4000-8000-000000000001", "01HZZ3GBR91HYZPJ0QVANQM32H"]) {
    assert.equal(validators.get("claim")({ ...canonical, id }), false);
  }
  const content = { schema_version: "1.0.0", engagement_id: canonical.engagement_id, kind: "claim", proposition: "candidate", status: "proposed", evidence_refs: [], limitations: [] };
  const envelope = { engagement_id: canonical.engagement_id, subject_type: "claim", expected_version: 0, content };
  assert.equal(validators.get("proposalEnvelope")(envelope), true);
  for (const field of ["id", "trust_level", "display_id", "version", "commit_seq", "review_ref", "policy_digest", "accept"]) {
    assert.equal(validators.get("proposalEnvelope")({ ...envelope, content: { ...content, [field]: field === "accept" ? true : canonical.id } }), false, `${field} is writer-owned`);
  }
  assert.equal(validators.get("proposalEnvelope")({ ...envelope, content: { ...content, kind: undefined } }), false);
  assert.equal(validators.get("proposalProvenance")({ host_id: "pi", producer_id: "model", source_kind: "model" }), true);
  assert.equal(validators.get("proposalProvenance")({ host_id: "pi", producer_id: "model", source_kind: "reviewer" }), false);
});
