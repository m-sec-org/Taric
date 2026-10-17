import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";
import { createMcpServer, modelTools } from "../../mcp/dist/server.js";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function trustedNodeClient(service, role, id, engagementId, reviewerAttestation) {
  const principal = createPrincipal(role, id, engagementId, [], reviewerAttestation);
  return {
    principal,
    call(operation, request) {
      return service.dispatch(operation, principal, request);
    },
  };
}

test("trusted Node principals complete the governed finding flow without expanding MCP tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-trusted-node-"));
  const store = new AuthorityStore(join(directory, "authority.sqlite"));
  const service = await createCoreService(store, join(directory, "content"));
  try {
    const operator = trustedNodeClient(service, "operator", "operator-node");
    const initialized = await operator.call("engagement.init", {
      name: "trusted Node governance example",
      scope: {
        allowed_targets: ["https://example.test"],
        excluded_targets: ["https://example.test/logout"],
        rules_of_engagement_ref: "roe:trusted-node-example",
      },
    });
    assert.equal(initialized.ok, true);
    const engagementId = initialized.data.id;
    const scope = (await store.list(engagementId)).find((record) => record.kind === "scope");
    assert.ok(scope);

    const host = trustedNodeClient(service, "host", "host-bridge", engagementId);
    const model = trustedNodeClient(service, "model", "model-worker", engagementId);
    const writer = trustedNodeClient(service, "writer", "writer-node", engagementId);
    const reviewerA = trustedNodeClient(service, "reviewer", "reviewer-a", engagementId, {
      capability: "model",
      model: "review-model-a",
      prompt_digest: digest("review-prompt-a"),
      ruleset_digest: digest("trusted-review-rules/1"),
    });
    const reviewerB = trustedNodeClient(service, "reviewer", "reviewer-b", engagementId, {
      capability: "model",
      model: "review-model-b",
      prompt_digest: digest("review-prompt-b"),
      ruleset_digest: digest("trusted-review-rules/1"),
    });
    const policyDigest = digest("default-admission-policy/1");

    const resourceProposal = await host.call("proposal.submit", {
      engagement_id: engagementId,
      subject_type: "resource",
      expected_version: 0,
      content: {
        schema_version: "1.0.0",
        engagement_id: engagementId,
        kind: "resource",
        asset_type: "endpoint",
        identity: { origin: "https://example.test", method: "GET", path: "/admin" },
        revision: 1,
      },
    });
    assert.equal(resourceProposal.ok, true);
    const initialResource = await operator.call("admission.evaluate", {
      engagement_id: engagementId,
      proposal_id: resourceProposal.data.id,
      expected_version: 0,
      policy_digest: policyDigest,
    });
    assert.equal(initialResource.ok, true);
    assert.equal(initialResource.data.record.trust_level, "L1");
    const resourceId = initialResource.data.record.id;

    const hostToolOutput = "HTTP/1.1 200 OK; body omitted by host policy";
    const observedAt = new Date().toISOString();
    const observation = await host.call("capture.observation", {
      engagement_id: engagementId,
      observation: {
        schema_version: "1.0.0",
        engagement_id: engagementId,
        kind: "observation",
        resource_ref: resourceId,
        observed_at: observedAt,
        statement: "The host HTTP tool received a 200 response for the in-scope request.",
        artifact_refs: [{ host_ref: "host-tool-result:request-1", content_hash: digest(hostToolOutput) }],
        limitations: ["one unauthenticated request", "response body retained by host"],
      },
    });
    assert.equal(observation.ok, true);
    const observationAdmission = await operator.call("admission.evaluate", {
      engagement_id: engagementId,
      proposal_id: observation.data.id,
      expected_version: 0,
      policy_digest: policyDigest,
    });
    assert.equal(observationAdmission.ok, true);

    const resourceRevision = await host.call("resource.revise", {
      engagement_id: engagementId,
      resource_id: resourceId,
      expected_version: initialResource.data.record.version,
      method: "GET",
      path: "/admin",
      content_hash: digest("GET https://example.test/admin"),
      source_observation_refs: [observationAdmission.data.record.id],
    });
    assert.equal(resourceRevision.ok, true);

    const evidence = await host.call("proposal.submit", {
      engagement_id: engagementId,
      subject_type: "evidence",
      expected_version: 0,
      content: {
        schema_version: "1.0.0",
        engagement_id: engagementId,
        kind: "evidence",
        resource_ref: resourceId,
        artifact_ref: { host_ref: "host-tool-result:request-1", content_hash: digest(hostToolOutput) },
        observed_at: observedAt,
        limitations: ["response body retained by host", "single request"],
      },
    });
    assert.equal(evidence.ok, true);
    assert.equal(evidence.data.content.provenance.producer_id, host.principal.id);
    const evidenceAdmission = await operator.call("admission.evaluate", {
      engagement_id: engagementId,
      proposal_id: evidence.data.id,
      expected_version: 0,
      policy_digest: policyDigest,
    });
    assert.equal(evidenceAdmission.ok, true);
    assert.equal(evidenceAdmission.data.record.trust_level, "L1");

    const claim = await model.call("proposal.submit", {
      engagement_id: engagementId,
      subject_type: "claim",
      expected_version: 0,
      content: {
        schema_version: "1.0.0",
        engagement_id: engagementId,
        kind: "claim",
        proposition: "The in-scope administration endpoint responded without authentication.",
        status: "proposed",
        evidence_refs: [evidenceAdmission.data.record.id],
        limitations: ["single request", "response body not independently inspected"],
      },
    });
    assert.equal(claim.ok, true);
    const claimAdmission = await operator.call("admission.evaluate", {
      engagement_id: engagementId,
      proposal_id: claim.data.id,
      expected_version: 0,
      policy_digest: policyDigest,
    });
    assert.equal(claimAdmission.ok, true);

    const finding = await model.call("proposal.submit", {
      engagement_id: engagementId,
      subject_type: "finding",
      expected_version: 0,
      content: {
        schema_version: "1.0.0",
        engagement_id: engagementId,
        kind: "finding",
        title: "Unauthenticated administration endpoint",
        risk_class: "high",
        claim_refs: [claimAdmission.data.record.id],
        evidence_refs: [evidenceAdmission.data.record.id],
        applicable_scope_ref: scope.id,
        status: "draft",
        limitations: ["single unauthenticated request", "response body retained by host"],
        reproducibility: "Repeat GET /admin using the same in-scope host tool configuration.",
      },
    });
    assert.equal(finding.ok, true);
    assert.equal(finding.data.status, "pending");

    const l1 = await operator.call("admission.evaluate", {
      engagement_id: engagementId,
      proposal_id: finding.data.id,
      expected_version: 0,
      policy_digest: policyDigest,
    });
    assert.equal(l1.ok, true);
    assert.equal(l1.data.trust_phase, "machine_approved");
    assert.equal(l1.data.record.trust_level, "L1");
    assert.ok(l1.data.remaining_l2_requirements.includes("independent_review"));

    const reviewInput = {
      engagement_id: engagementId,
      proposal_id: finding.data.id,
      reviewer_id: reviewerA.principal.id,
      reviewer_kind: "reviewer",
      input_hash: finding.data.content_hash,
      policy_digest: policyDigest,
      verdict: "pass",
      limitations: ["automated fixture review; no claim of human review"],
    };
    const forgedReview = await reviewerA.call("review.submit", { ...reviewInput, reviewer_capability: "human" });
    assert.equal(forgedReview.error.code, "authorization_error");
    const reviewA = await reviewerA.call("review.submit", reviewInput);
    assert.equal(reviewA.ok, true);
    const reviewB = await reviewerB.call("review.submit", { ...reviewInput, reviewer_id: reviewerB.principal.id });
    assert.equal(reviewB.ok, true);

    const promotion = {
      engagement_id: engagementId,
      proposal_id: finding.data.id,
      target_id: l1.data.record.id,
      expected_version: l1.data.record.version,
      input_hash: finding.data.content_hash,
      evidence_snapshot_hash: reviewA.data.evidence_snapshot_hash,
      policy_digest: policyDigest,
      review_refs: [reviewA.data.id, reviewB.data.id],
    };
    assert.equal((await model.call("admission.promote_l2", promotion)).error.code, "authorization_error");
    assert.equal((await writer.call("admission.promote_l2", { ...promotion, input_hash: digest("old finding input") })).error.code, "conflict");
    assert.equal((await writer.call("admission.promote_l2", { ...promotion, evidence_snapshot_hash: digest("old evidence snapshot") })).error.code, "stale_version");
    assert.equal((await store.get(l1.data.record.id)).trust_level, "L1");

    const mcp = createMcpServer(service, model.principal);
    assert.deepEqual(modelTools, ["context.query", "resource.query", "evidence.query", "proposal.submit", "checkpoint.propose", "action.recommend"]);
    assert.deepEqual(mcp.toolsList().tools.map((tool) => tool.name), [...modelTools]);
    const mcpDenied = await mcp.toolsCall({ name: "admission.promote_l2", arguments: promotion });
    assert.equal(JSON.parse(mcpDenied.content[0].text).error.code, "authorization_error");

    const promoted = await writer.call("admission.promote_l2", promotion);
    assert.equal(promoted.ok, true);
    assert.equal(promoted.data.trust_phase, "independently_verified");
    assert.equal(promoted.data.record.trust_level, "L2");
    assert.equal(promoted.data.record.status, "verified");

    const verified = await operator.call("resource.query", {
      engagement_id: engagementId,
      trust_level: "L2",
      include_candidates: true,
      kind: "finding",
    });
    assert.equal(verified.ok, true);
    assert.ok(verified.data.records.some((record) => record.id === l1.data.record.id && record.status === "verified"));
    assert.equal((await store.verifyAudit()).valid, true);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
