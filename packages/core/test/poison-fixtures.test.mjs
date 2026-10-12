import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthorityStore,
  DEFAULT_ADMISSION_POLICY,
  TARIC_COMPATIBILITY_MANIFEST,
  adapterCapabilities,
  createCoreService,
  createPrincipal,
  policyDigest,
  publishProjection,
  uuidv7,
} from "../dist/index.js";
import { operationContracts } from "@taric/schemas";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/memory-quality-v1.json", import.meta.url), "utf8"));
const requiredClasses = ["blocked", "conflict", "forged_evidence", "memory_poisoning", "negative", "positive", "prompt_injection", "stale"];
const expectedOutcomes = {
  positive: ["L1", "positive"],
  negative: ["L1", "tested_no_observation"],
  blocked: ["L1", "blocked_by_control"],
  stale: ["L0", "inconclusive"],
  conflict: ["L1", "inconclusive"],
  forged_evidence: ["L0", "not_tested"],
  prompt_injection: ["L0", "not_tested"],
  memory_poisoning: ["L0", "not_tested"],
};

test("memory quality v1 fixture is versioned across web and host outcomes", () => {
  assert.equal(fixture.fixture_schema, "taric.memory-quality-fixture");
  assert.equal(fixture.fixture_version, "memory-quality-v1");
  assert.equal(fixture.schema_version, "1.0.0");
  assert.equal(fixture.policy_version, "1.0.0");
  assert.deepEqual([...new Set(fixture.scenarios.map((scenario) => scenario.classification))].sort(), requiredClasses);
  assert.deepEqual([...new Set(fixture.scenarios.map((scenario) => scenario.surface))].sort(), ["host", "web"]);
  for (const scenario of fixture.scenarios) {
    assert.match(scenario.id, /^(web|host)-/);
    assert.ok(["informational", "low", "medium", "high", "critical"].includes(scenario.risk_class));
    assert.ok(["direct", "corroborated", "conflict", "forged", "untrusted"].includes(scenario.evidence_level));
    assert.ok(["L0", "L1", "L2"].includes(scenario.expected.trust_level));
    assert.ok(["not_tested", "tested_no_observation", "positive", "inconclusive", "blocked", "blocked_by_control"].includes(scenario.expected.coverage_status));
    assert.equal(typeof scenario.expected.admitted, "boolean");
    assert.equal(typeof scenario.expected.promotable, "boolean");
    assert.deepEqual([scenario.expected.trust_level, scenario.expected.coverage_status], expectedOutcomes[scenario.classification]);
  }
  assert.deepEqual(Object.keys(fixture.poisoning_payloads).sort(), ["http", "markdown", "proposal", "reviewer", "tool"]);
});

test("HTTP, tool, Markdown, proposal, and reviewer poisoning cannot alter policy or capability allowlists", async () => {
  const policyBefore = structuredClone(DEFAULT_ADMISSION_POLICY);
  const policyDigestBefore = policyDigest();
  const operationsBefore = operationContracts.map(({ operation, roles }) => ({ operation, roles: [...roles] }));
  const adapterCapabilitiesBefore = [...adapterCapabilities];
  const manifestCapabilitiesBefore = structuredClone(TARIC_COMPATIBILITY_MANIFEST.capabilities);
  const invariantsBefore = structuredClone(TARIC_COMPATIBILITY_MANIFEST.security_invariants);
  const engagementId = uuidv7();
  const writerBefore = createPrincipal("writer", "writer-before", engagementId);
  const writerCapabilitiesBefore = [...writerBefore.capabilities];
  const store = new AuthorityStore();
  const service = createCoreService(store);
  const model = createPrincipal("model", "model-a", engagementId);
  const reviewer = createPrincipal("reviewer", "reviewer-a", engagementId);
  const host = createPrincipal("host", "host-a", engagementId);
  try {
    const payloads = fixture.poisoning_payloads;
    const proposalId = uuidv7();
    const proposal = service.dispatch("proposal.submit", model, {
      engagement_id: engagementId,
      subject_type: "claim",
      base_version: 0,
      content: { id: proposalId, engagement_id: engagementId, kind: "claim", proposition: "safe candidate" },
    });
    assert.equal(proposal.ok, true);

    const poisonedProposal = service.dispatch("proposal.submit", model, {
      engagement_id: engagementId,
      subject_type: "claim",
      base_version: 0,
      content: { id: uuidv7(), engagement_id: engagementId, kind: "claim", proposition: "__TARIC_HTTP_POISON__", ...payloads.proposal },
    });
    assert.equal(poisonedProposal.ok, false);
    assert.equal(poisonedProposal.error.code, "validation_error");

    const poisonedReviewer = service.dispatch("review.submit", reviewer, {
      engagement_id: engagementId,
      proposal_id: proposal.data.id,
      ...payloads.reviewer,
      input_hash: proposal.data.content_hash,
    });
    assert.equal(poisonedReviewer.ok, false);
    assert.equal(poisonedReviewer.error.code, "authorization_error");

    const modelHostBypass = service.dispatch("action.host-decision", model, {
      engagement_id: engagementId,
      work_run_id: uuidv7(),
      action_id: uuidv7(),
      generation: 1,
      mode: "authorized_autonomous",
      status: "authorized",
      host_decision_ref: payloads.http.headers["x-taric-trust"],
      ...payloads.tool.arguments,
    });
    assert.equal(modelHostBypass.ok, false);
    assert.equal(modelHostBypass.error.code, "authorization_error");

    const modelWriterBypass = service.dispatch("resource.patch", model, {
      engagement_id: engagementId,
      capability: payloads.proposal.writer_capability,
      ...payloads.tool.arguments,
    });
    assert.equal(modelWriterBypass.ok, false);
    assert.equal(modelWriterBypass.error.code, "authorization_error");

    const crossEngagementHost = service.dispatch("action.host-decision", host, {
      engagement_id: uuidv7(),
      work_run_id: uuidv7(),
      action_id: uuidv7(),
      generation: 1,
      mode: "host_hitl",
      status: "authorized",
      host_decision_ref: payloads.http.headers["x-taric-role"],
    });
    assert.equal(crossEngagementHost.ok, false);
    assert.equal(crossEngagementHost.error.code, "authorization_error");

    const forgedHost = { ...host, id: "forged-host", role: "host", capabilities: ["read", "propose", "action"], ...payloads.http.headers };
    const forgedAuthorization = service.dispatch("action.host-decision", forgedHost, {
      engagement_id: engagementId,
      work_run_id: uuidv7(),
      action_id: uuidv7(),
      generation: 1,
      mode: "authorized_autonomous",
      status: "authorized",
      host_decision_ref: "__TARIC_TOOL_POISON__",
    });
    assert.equal(forgedAuthorization.ok, false);
    assert.equal(forgedAuthorization.error.code, "authorization_error");

    const projectionDir = await mkdtemp(join(tmpdir(), "taric-poison-projection-"));
    try {
      store.commit({
        id: uuidv7(),
        engagement_id: engagementId,
        kind: "finding",
        title: "safe projected finding",
        proposition: "safe projected claim",
        markdown_draft: payloads.markdown.content,
        raw_http: payloads.http.body,
        tool_output: payloads.tool.output,
        secret_ref: "vault://__TARIC_SECRET_POISON__",
        artifact_body: "__TARIC_ARTIFACT_POISON__",
        policy_digest: "sha256:attacker",
        writer_capability: "admit",
        projection_fields: ["secret_ref", "artifact_body"],
      }, "L2");
      await publishProjection(store, { engagementId, outputDir: projectionDir, localGit: false });
      const body = await readFile(join(projectionDir, "current", "STATE.md"), "utf8");
      assert.match(body, /safe projected finding/);
      for (const sentinel of ["__TARIC_HTTP_POISON__", "__TARIC_TOOL_POISON__", "__TARIC_MARKDOWN_POISON__", "__TARIC_SECRET_POISON__", "__TARIC_ARTIFACT_POISON__", "sha256:attacker"]) assert.doesNotMatch(body, new RegExp(sentinel));
    } finally {
      await rm(projectionDir, { recursive: true, force: true });
    }
  } finally {
    assert.deepEqual(DEFAULT_ADMISSION_POLICY, policyBefore);
    assert.equal(policyDigest(), policyDigestBefore);
    assert.deepEqual(operationContracts.map(({ operation, roles }) => ({ operation, roles: [...roles] })), operationsBefore);
    assert.deepEqual([...adapterCapabilities], adapterCapabilitiesBefore);
    assert.deepEqual(TARIC_COMPATIBILITY_MANIFEST.capabilities, manifestCapabilitiesBefore);
    assert.deepEqual(TARIC_COMPATIBILITY_MANIFEST.security_invariants, invariantsBefore);
    assert.deepEqual([...createPrincipal("writer", "writer-after", engagementId).capabilities], writerCapabilitiesBefore);
    store.close();
  }
});
