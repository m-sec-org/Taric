import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

function candidate(engagement_id, resource_refs, title = "verify approved resource") {
  return {
    schema_version: "1.0.0",
    engagement_id,
    kind: "work_item",
    title,
    status: "queued",
    acceptance_criteria: ["Record the result with its source and limitations."],
    resource_refs,
  };
}

test("host-neutral WorkItem bootstrap admits canonical Resource revisions before query and claim", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const other_engagement_id = uuidv7();
  const host = createPrincipal("host", "host-bridge", engagement_id);
  const operator = createPrincipal("operator", "local-operator");
  const resource_id = uuidv7();
  const revision_id = uuidv7();
  const foreign_resource_id = uuidv7();
  const foreign_revision_id = uuidv7();
  const stable_proposal_id = uuidv7();

  // External host IDs stay in the host's mapping. Core receives only Taric's canonical IDs.
  await store.commit({ id: resource_id, engagement_id, kind: "resource", asset_type: "endpoint", identity: { origin: "https://scope.invalid", path: "/health" }, revision: 1 }, "L2");
  await store.commit({ id: revision_id, engagement_id, kind: "resource_revision", resource_ref: resource_id, revision: 1, content_hash: `sha256:${"1".repeat(64)}`, source_observation_refs: [] }, "L2");
  await store.commit({ id: foreign_resource_id, engagement_id: other_engagement_id, kind: "resource", asset_type: "endpoint", identity: { origin: "https://foreign.invalid" }, revision: 1 }, "L2");
  await store.commit({ id: foreign_revision_id, engagement_id: other_engagement_id, kind: "resource_revision", resource_ref: foreign_resource_id, revision: 1, content_hash: `sha256:${"2".repeat(64)}`, source_observation_refs: [] }, "L2");

  const submit = (content, idempotency_key, proposal_id = uuidv7()) => service.dispatch("proposal.submit", host, {
    engagement_id,
    subject_type: "work_item",
    proposal_id,
    expected_version: 0,
    idempotency_key,
    content,
  });

  try {
    const content = candidate(engagement_id, [resource_id, revision_id]);
    const first = await submit(content, "host-bootstrap:request-1", stable_proposal_id);
    assert.equal(first.ok, true, JSON.stringify(first));
    const replay = await submit(content, "host-bootstrap:request-1", stable_proposal_id);
    assert.deepEqual(replay, first, "an exact proposal retry returns the original pending proposal");
    const changedRetry = await submit(candidate(engagement_id, [resource_id, revision_id], "changed payload"), "host-bootstrap:request-1", stable_proposal_id);
    assert.equal(changedRetry.ok, false);
    assert.equal(changedRetry.error.code, "idempotency_conflict");

    const pendingClaim = await service.dispatch("work.claim", host, {
      engagement_id,
      work_item_id: first.data.id,
      host_id: "forged-host",
      agent_id: "worker-1",
    });
    assert.equal(pendingClaim.ok, false, "a pending proposal is not an admitted canonical WorkItem");
    assert.equal(pendingClaim.error.code, "validation_error");

    const missingRef = await submit(candidate(engagement_id, [uuidv7()]), "host-bootstrap:missing");
    assert.equal(missingRef.ok, false);
    assert.equal(missingRef.error.code, "validation_error");
    const crossEngagementRef = await submit(candidate(engagement_id, [foreign_resource_id]), "host-bootstrap:foreign-resource");
    assert.equal(crossEngagementRef.ok, false);
    assert.equal(crossEngagementRef.error.code, "validation_error");
    const foreignRevision = await submit(candidate(engagement_id, [resource_id, foreign_revision_id]), "host-bootstrap:foreign-revision");
    assert.equal(foreignRevision.ok, false);
    assert.equal(foreignRevision.error.code, "validation_error");

    const admitted = await service.dispatch("admission.evaluate", operator, {
      engagement_id,
      proposal_id: first.data.id,
      expected_version: 0,
      policy_digest: `sha256:${"3".repeat(64)}`,
      idempotency_key: "host-bootstrap:admit-1",
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const canonical = admitted.data.record;
    assert.equal(canonical.kind, "work_item");
    assert.equal(canonical.engagement_id, engagement_id);
    assert.deepEqual(canonical.resource_refs, [resource_id, revision_id]);

    const listed = await service.dispatch("work.query", host, {
      engagement_id,
      resource_refs: [resource_id],
      include_active_runs: true,
    });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.data.items.map((item) => item.id), [canonical.id]);
    assert.equal(listed.data.items[0].active_run, undefined);

    const claimed = await service.dispatch("work.claim", host, {
      engagement_id,
      work_item_id: canonical.id,
      host_id: "forged-host",
      agent_id: "worker-1",
    });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    assert.equal(claimed.data.owner.host_id, host.id, "Core binds run ownership to the host principal");
    const withRun = await service.dispatch("work.query", host, { engagement_id, resource_refs: [resource_id], include_active_runs: true });
    assert.equal(withRun.data.items[0].active_run.run_id, claimed.data.run_id);
    assert.equal(withRun.data.items[0].active_run.generation, claimed.data.generation);
  } finally {
    await service.close();
  }
});

test("one WorkItem can have at most one active claim owner", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const work_item_id = uuidv7();
  await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "single owner", status: "queued", acceptance_criteria: ["result"] }, "L2");
  const hostA = createPrincipal("host", "host-a", engagement_id);
  const hostB = createPrincipal("host", "host-b", engagement_id);
  try {
    const [a, b] = await Promise.all([
      service.dispatch("work.claim", hostA, { engagement_id, work_item_id, agent_id: "agent-a" }),
      service.dispatch("work.claim", hostB, { engagement_id, work_item_id, agent_id: "agent-b" }),
    ]);
    assert.equal([a, b].filter((result) => result.ok).length, 1, JSON.stringify([a, b]));
    assert.equal([a, b].filter((result) => !result.ok).length, 1, JSON.stringify([a, b]));
    const winner = a.ok ? a : b;
    const winnerPrincipal = a.ok ? hostA : hostB;
    assert.equal(winner.data.owner.host_id, winnerPrincipal.id);
    const page = await service.dispatch("work.query", winnerPrincipal, { engagement_id, include_active_runs: true });
    assert.equal(page.data.items.filter((item) => item.active_run?.run_id === winner.data.run_id).length, 1);
    assert.equal((await store.activeWorkRuns(engagement_id)).filter((run) => run.work_item_id === work_item_id).length, 1);
  } finally {
    await service.close();
  }
});
