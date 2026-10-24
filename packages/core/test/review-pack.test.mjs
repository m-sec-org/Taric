import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, policyDigest, uuidv7 } from "../dist/index.js";

test("admission-bound review pack is complete above 1,000 references and ignores live replacements", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  try {
    const operator = createPrincipal("operator", "review-pack-operator");
    const initialized = await service.dispatch("engagement.init", operator, { name: "review-pack", scope: { allowed_targets: ["https://review.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:review-pack" } });
    assert.equal(initialized.ok, true, JSON.stringify(initialized));
    const engagement_id = initialized.data.id;
    const scope = (await store.list(engagement_id)).find((record) => record.kind === "scope");
    const claim = await store.createRecord({ schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "large fixture", status: "proposed", evidence_refs: [], limitations: ["fixture"] }, "L1");
    const evidenceIds = Array.from({ length: 1000 }, () => uuidv7());
    const observed_at = new Date().toISOString();
    await store.transaction(async () => {
      for (let index = 0; index < evidenceIds.length; index += 1) {
        const id = evidenceIds[index];
        await store.commit({ schema_version: "1.0.0", id, engagement_id, kind: "evidence", artifact_ref: { host_ref: `host:review:${index}` }, observed_at, limitations: ["large fixture"], provenance: { host_id: "host-fixture", producer_id: "seed", source_kind: "host" } }, "L1", undefined, { operation: "review-pack-fixture", principal: "review-pack-test", engagement_id });
      }
    });
    const model = createPrincipal("model", "finding-author", engagement_id);
    const proposalResult = await service.dispatch("proposal.submit", model, {
      engagement_id,
      subject_type: "finding",
      expected_version: 0,
      content: { schema_version: "1.0.0", engagement_id, kind: "finding", title: "large review fixture", claim_refs: [claim.id], evidence_refs: evidenceIds, applicable_scope_ref: scope.id, status: "draft", limitations: ["large fixture"], reproducibility: "repeat large fixture", provenance: { host_id: "host-fixture", producer_id: model.id, source_kind: "worker" } },
    });
    assert.equal(proposalResult.ok, true, JSON.stringify(proposalResult.error));
    const policy_digest = policyDigest();
    const admission = await service.dispatch("admission.evaluate", operator, { engagement_id, proposal_id: proposalResult.data.id, expected_version: 0, policy_digest });
    assert.equal(admission.ok, true, JSON.stringify(admission.error));

    const hostPack = await service.dispatch("review.pack", operator, { engagement_id, proposal_id: proposalResult.data.id });
    const libraryPack = await store.reviewPack(engagement_id, proposalResult.data.id);
    assert.equal(hostPack.ok, true);
    assert.deepEqual(hostPack.data, libraryPack);
    assert.equal(libraryPack.evidence.length, 1002, "all 1,000 evidence refs plus claim and scope are included");
    assert.deepEqual(libraryPack.evidence.map((entry) => entry.id), [...libraryPack.evidence.map((entry) => entry.id)].sort());
    assert.match(libraryPack.evidence_snapshot_hash, /^sha256:[a-f0-9]{64}$/);
    const repeated = await store.reviewPack(engagement_id, proposalResult.data.id);
    assert.deepEqual(repeated, libraryPack, "repeated generation is byte-for-byte stable");

    const reviewer = createPrincipal("reviewer", "independent-reviewer", engagement_id, [], { capability: "human" });
    const validBindings = { engagement_id, proposal_id: proposalResult.data.id, reviewer_id: reviewer.id, reviewer_kind: "reviewer", input_hash: libraryPack.proposal_hash, evidence_snapshot_hash: libraryPack.evidence_snapshot_hash, policy_digest: libraryPack.policy_digest, verdict: "pass" };
    const beforeEvents = await store.events();
    const beforeReviews = Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count);
    for (const patch of [
      { input_hash: `sha256:${"1".repeat(64)}` },
      { evidence_snapshot_hash: `sha256:${"2".repeat(64)}` },
      { policy_digest: `sha256:${"3".repeat(64)}` },
    ]) {
      const result = await service.dispatch("review.submit", reviewer, { ...validBindings, ...patch });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "stale_version");
    }
    assert.deepEqual(await store.events(), beforeEvents);
    assert.equal(Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count), beforeReviews);

    const accepted = await service.dispatch("review.submit", reviewer, validBindings);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    assert.equal(accepted.data.accepted, true);
    const afterAcceptedEvents = await store.events();
    const afterAcceptedReviews = Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count);
    assert.equal(afterAcceptedReviews, beforeReviews + 1);

    const firstId = evidenceIds[0];
    await store.compareAndSet(firstId, 1, { limitations: ["live replacement"] }, "L1");
    const afterReplacement = await store.reviewPack(engagement_id, proposalResult.data.id);
    assert.deepEqual(afterReplacement, libraryPack, "pack generation does not read a live replacement record");
    const beforeStaleSubmitEvents = await store.events();
    const staleEvidenceReview = await service.dispatch("review.submit", reviewer, validBindings);
    assert.equal(staleEvidenceReview.ok, false);
    assert.equal(staleEvidenceReview.error.code, "stale_version");
    assert.deepEqual(await store.events(), beforeStaleSubmitEvents);
    assert.equal(Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count), afterAcceptedReviews);
    assert.ok(afterAcceptedEvents.length < beforeStaleSubmitEvents.length, "evidence replacement is the only intervening mutation");
  } finally {
    await service.close();
  }
});
