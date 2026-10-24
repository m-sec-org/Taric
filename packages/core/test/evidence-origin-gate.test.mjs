import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, DEFAULT_ADMISSION_POLICY, evaluateAdmission, policyDigest, uuidv7 } from "../dist/index.js";

const enabledPolicy = {
  ...DEFAULT_ADMISSION_POLICY,
  derived_subject_evidence_roles: { negative_observation: ["host", "operator"] },
};

const subject = (kind, evidence_refs) => ({
  id: uuidv7(), kind, evidence_refs, limitations: ["bounded fixture"], reproducibility: "deterministic replay",
});
const input = (evidence, policy = DEFAULT_ADMISSION_POLICY) => ({
  subject: subject("negative_observation", evidence.map((item) => item.id)),
  policy, policy_digest: policyDigest(policy),
  evidence, reviews: [],
  input_hash: `sha256:${"a".repeat(64)}`, evidence_snapshot_hash: `sha256:${"b".repeat(64)}`,
});

test("policyDigest includes the origin gate exactly when configured", () => {
  const baseline = policyDigest(DEFAULT_ADMISSION_POLICY);
  assert.equal(policyDigest({ ...DEFAULT_ADMISSION_POLICY, derived_subject_evidence_roles: undefined }), baseline);
  assert.notEqual(policyDigest(enabledPolicy), baseline);
});

test("evidence origin gate fails closed on model-origin and missing provenance, accepts host captures", () => {
  const evidenceGate = (decision) => decision.gates.find((gate) => gate.gate === "evidence");

  const modelOrigin = input([{ id: uuidv7(), version: 1, status: "active", origin: "model" }], enabledPolicy);
  const modelDecision = evaluateAdmission(modelOrigin);
  assert.equal(evidenceGate(modelDecision).passed, false);
  assert.ok(modelDecision.reasons.some((reason) => reason.startsWith("evidence_origin_untrusted")), JSON.stringify(modelDecision.reasons));

  const missingOrigin = input([{ id: uuidv7(), version: 1, status: "active" }], enabledPolicy);
  const missingDecision = evaluateAdmission(missingOrigin);
  assert.equal(evidenceGate(missingDecision).passed, false);
  assert.ok(missingDecision.reasons.some((reason) => reason.includes("no recorded provenance origin")));

  const hostOrigin = input([{ id: uuidv7(), version: 1, status: "active", origin: "host" }], enabledPolicy);
  const hostDecision = evaluateAdmission(hostOrigin);
  assert.equal(evidenceGate(hostDecision).passed, true, JSON.stringify(evidenceGate(hostDecision)));

  // 默认关闭：model 来源证据照旧通过 evidence 门（其余门照常评估）。
  const defaultDecision = evaluateAdmission(input([{ id: uuidv7(), version: 1, status: "active", origin: "model" }]));
  assert.equal(evidenceGate(defaultDecision).passed, true);

  // 未配置的 subject kind 不受影响。
  const unconfigured = { ...input([{ id: uuidv7(), version: 1, status: "active", origin: "model" }], enabledPolicy) };
  unconfigured.subject = subject("claim", [unconfigured.evidence[0].id]);
  const unconfiguredDecision = evaluateAdmission(unconfigured);
  assert.equal(evidenceGate(unconfiguredDecision).passed, true);
});

test("store admission path resolves cited provenance origins and records the enabled digest", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource_ref = uuidv7();
  try {
    (await store.commit({ id: resource_ref, engagement_id, kind: "resource", asset_type: "service", identity: "origin.internal", revision: 1 }, "L2"));
    const hostEvidence = uuidv7();
    const modelEvidence = uuidv7();
    (await store.commit({ id: hostEvidence, engagement_id, kind: "evidence", artifact_ref: { host_ref: "host-artifact:1" }, observed_at: new Date().toISOString(), limitations: [], provenance: { host_id: "host-a", producer_id: "host-a", source_kind: "host" } }, "L2"));
    (await store.commit({ id: modelEvidence, engagement_id, kind: "evidence", artifact_ref: { host_ref: "host-artifact:2" }, observed_at: new Date().toISOString(), limitations: [], provenance: { host_id: "pi", producer_id: "model-a", source_kind: "model" } }, "L2"));

    const model = createPrincipal("model", "model-a", engagement_id);
    const propose = (evidence_refs) => service.dispatch("proposal.submit", model, {
      engagement_id, subject_type: "negative_observation", expected_version: 0,
      content: {
        schema_version: "1.0.0", engagement_id, kind: "negative_observation", statement: "no auth on endpoint", method: "GET /",
        tested_resource_refs: [resource_ref], conditions: ["role=user"], evidence_refs, limitations: ["single identity"],
        bounded: true, tested_at: new Date().toISOString(),
      },
    });
    const citingHost = await propose([hostEvidence]);
    assert.equal(citingHost.ok, true, JSON.stringify(citingHost));
    const citingModel = await propose([modelEvidence]);
    assert.equal(citingModel.ok, true, JSON.stringify(citingModel));

    const evidenceGate = (decision) => decision.gates.find((gate) => gate.gate === "evidence");
    const hostDecision = await store.evaluateAdmission(citingHost.data.proposal_id, { policy: enabledPolicy });
    assert.equal(evidenceGate(hostDecision).passed, true, JSON.stringify(hostDecision.gates));
    const modelDecision = await store.evaluateAdmission(citingModel.data.proposal_id, { policy: enabledPolicy });
    assert.equal(evidenceGate(modelDecision).passed, false);
    assert.ok(modelDecision.reasons.some((reason) => reason.startsWith("evidence_origin_untrusted")));

    // 默认策略下 model 来源照旧通过（行为与基线一致）。
    const defaultDecision = await store.evaluateAdmission(citingModel.data.proposal_id);
    assert.equal(evidenceGate(defaultDecision).passed, true, JSON.stringify(defaultDecision.gates));

    // 启用策略的 digest 随 admit 事件进入审计。
    const admitted = await store.admitProposal(citingHost.data.proposal_id, policyDigest(enabledPolicy), { principal: "op-a" });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const events = await store.events();
    const admitEvent = events.find((event) => event.event_type === "proposal.admit" && event.subject_id === citingHost.data.proposal_id);
    assert.equal(admitEvent.payload.policy_digest, policyDigest(enabledPolicy));
    assert.notEqual(admitEvent.payload.policy_digest, policyDigest(DEFAULT_ADMISSION_POLICY));
  } finally { await service.close(); }
});
