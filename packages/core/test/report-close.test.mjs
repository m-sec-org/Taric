import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, ContractValidationError, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const contentDigest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function commitArtifact(service, host, engagement_id, root, session_id, body) {
  const bytes = Buffer.from(body);
  const content_hash = contentDigest(bytes);
  const bound = await service.dispatch("artifact.session.bind", host, { engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const begun = await service.dispatch("artifact.store.begin", host, { engagement_id, session_id, payload_kind: "text", media_type: "text/plain", expected_bytes: bytes.length, expected_hash: content_hash });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const appended = await service.dispatch("artifact.store.append", host, { engagement_id, session_id, upload_id: begun.data.upload_id, ordinal: 0, data: bytes.toString("base64"), encoding: "base64", chunk_hash: content_hash });
  assert.equal(appended.ok, true, JSON.stringify(appended));
  const committed = await service.dispatch("artifact.store.commit", host, { engagement_id, session_id, upload_id: begun.data.upload_id, total_bytes: bytes.length, chunk_count: 1, content_hash });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  return committed.data;
}

async function approvedScope(store, engagement, service, operator) {
  const scope = await store.get(engagement.scope_ref);
  const now = Date.now();
  const policy = {
    allowed_targets: ["example.test"], excluded_targets: [], protocols: ["https"], ports: [{ from: 443, to: 443 }], methods: ["GET"],
    dns: { require_pinned_addresses: true, reject_private_addresses: true, max_addresses: 8 },
    redirects: { max_hops: 1, same_scope_only: true },
    valid_from: new Date(now - 60_000).toISOString(), valid_until: new Date(now + 3_600_000).toISOString(),
  };
  const artifact_id = uuidv7();
  const content_ref = `${artifact_id}@v1`;
  await store.saveArtifactCatalogRow({
    content_ref, engagement_id: engagement.id, session_id: "roe", artifact_id, version: 1, payload_kind: "text", media_type: "text/plain",
    storage_mode: "taric_stored", byte_length: 6, chunk_count: 1, content_hash: digest("a"), content_status: "available", integrity_status: "verified",
    stored_at: new Date().toISOString(), relative_dir: "", manifest_path: "",
  }, [{ ordinal: 0, offset: 0, bytes: 6, hash: digest("a"), path: "roe/chunk" }]);
  const request = {
    engagement_id: engagement.id, scope_id: scope.id, expected_version: scope.version, policy,
    roe_artifact_ref: content_ref, roe_artifact_version: 1, idempotency_key: `approve-scope-for-close:${engagement.id}`,
  };
  if (!service) return store.reviseScope({ ...request, principal: "operator" });
  const response = await service.dispatch("scope.revise", operator, request);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

test("ReportSnapshot is committed only by its operation and becomes stale after any later authority write", async () => {
  const store = new AuthorityStore();
  try {
    const engagement = await store.initializeEngagement({
      name: "report close",
      scope: { allowed_targets: ["example.test"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" },
    });
    const scope = await store.get(engagement.scope_ref);
    const report = {
      id: uuidv7(), schema_version: "1.0.0", engagement_id: engagement.id,
      created_at: new Date().toISOString(), provenance: { host_id: "operator", producer_id: "operator", source_kind: "host" },
      kind: "report_snapshot", manifest_ref: uuidv7(), manifest_digest: digest("a"), scope_revision_ref: uuidv7(), policy_digest: digest("b"),
      resource_revision_refs: [], coverage_read_seq: 0, coverage_snapshot_digest: digest("c"), coverage_gate_digest: digest("d"),
      coverage_can_close: true, coverage_complete_domain: true, coverage_gap_kinds: [], evidence_read_seq: 0, evidence_refs: [],
      evidence_snapshot_hash: digest("e"), report_artifact_session_id: "report", report_artifact_ref: "report@v1", report_artifact_id: uuidv7(),
      report_artifact_version: 1, report_artifact_digest: digest("f"), authority_read_seq: 0, snapshot_digest: digest("1"), committed_at: new Date().toISOString(),
    };
    await assert.rejects(
      store.commit(report, "L2", undefined, undefined, false, 0),
      (error) => error instanceof ContractValidationError && error.code === "conflict",
    );

    const readSeq = (await store.events()).at(-1).commit_seq;
    report.coverage_read_seq = readSeq;
    report.evidence_read_seq = readSeq;
    report.authority_read_seq = readSeq;
    const snapshot = await store.commit(report, "L2", undefined, undefined, true, 0, undefined, true);
    await store.commit({ id: uuidv7(), engagement_id: engagement.id, kind: "observation", statement: "late governance fact" }, "L2");
    const currentSeq = (await store.events()).at(-1).commit_seq;
    await assert.rejects(
      store.closeEngagement({ engagement_id: engagement.id, expected_engagement_version: engagement.version, expected_authority_seq: currentSeq, report_snapshot_ref: snapshot.id, reason: "attempt stale close", idempotency_key: "stale-close-1" }),
      (error) => error.code === "stale_version" && /ReportSnapshot is stale/.test(error.message),
    );
    assert.equal((await store.get(engagement.id)).status, "active");
    assert.equal((await store.get(scope.id)).kind, "scope");
  } finally {
    await store.close();
  }
});

test("close and reopen persist canonical decisions and fence ordinary writes while closed", async () => {
  const store = new AuthorityStore();
  try {
    const engagement = await store.initializeEngagement({
      name: "close lifecycle",
      scope: { allowed_targets: ["example.test"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" },
    });
    const approved = await approvedScope(store, engagement);
    const workItem = await store.commit({ id: uuidv7(), engagement_id: engagement.id, kind: "work_item", title: "post-close claim fence", status: "queued", acceptance_criteria: ["result"] }, "L2");
    const readSeq = (await store.events()).at(-1).commit_seq;
    const snapshot = await store.commit({
      id: uuidv7(), schema_version: "1.0.0", engagement_id: engagement.id,
      created_at: new Date().toISOString(), provenance: { host_id: "operator", producer_id: "operator", source_kind: "host" },
      kind: "report_snapshot", manifest_ref: uuidv7(), manifest_digest: digest("b"), scope_revision_ref: approved.revision.id, policy_digest: approved.revision.policy_digest,
      resource_revision_refs: [], coverage_read_seq: readSeq, coverage_snapshot_digest: digest("c"), coverage_gate_digest: digest("d"),
      coverage_can_close: true, coverage_complete_domain: true, coverage_gap_kinds: [], evidence_read_seq: readSeq, evidence_refs: [],
      evidence_snapshot_hash: digest("e"), report_artifact_session_id: "report", report_artifact_ref: "report@v1", report_artifact_id: uuidv7(),
      report_artifact_version: 1, report_artifact_digest: digest("f"), authority_read_seq: readSeq, snapshot_digest: digest("1"), committed_at: new Date().toISOString(),
    }, "L2", undefined, undefined, true, 0, undefined, true);
    const closed = await store.closeEngagement({
      engagement_id: engagement.id, expected_engagement_version: engagement.version,
      expected_authority_seq: snapshot.commit_seq, report_snapshot_ref: snapshot.id, reason: "complete", idempotency_key: "close-lifecycle-1", principal: "operator",
    });
    assert.equal(closed.decision, "closed");
    assert.equal(closed.engagement.status, "completed");
    assert.equal((await store.get(closed.id)).kind, "close_decision");
    await assert.rejects(store.commit({ id: uuidv7(), engagement_id: engagement.id, kind: "observation", statement: "closed write" }, "L2"), /completed Engagements are read-only/);
    await assert.rejects(store.claimWorkRun({ work_item_id: workItem.id, engagement_id: engagement.id, host_id: "host", agent_id: "worker" }), /closed Engagements cannot claim WorkRuns/);

    const currentSeq = (await store.events()).at(-1).commit_seq;
    const reopened = await store.reopenEngagement({
      engagement_id: engagement.id, expected_engagement_version: closed.engagement.version, expected_authority_seq: currentSeq,
      close_decision_ref: closed.id, reason: "additional verification", idempotency_key: "reopen-lifecycle-1", principal: "operator",
    });
    assert.equal(reopened.decision, "reopened");
    assert.equal(reopened.supersedes, closed.id);
    assert.equal(reopened.engagement.status, "active");
  } finally {
    await store.close();
  }
});

test("public report snapshot commit validates complete bindings and close replays its committed decision", async () => {
  const store = new AuthorityStore();
  const root = mkdtempSync(join(tmpdir(), "taric-report-close-"));
  const service = await createCoreService(store, join(root, "content"));
  try {
    const engagement = await store.initializeEngagement({
      name: "public report close",
      scope: { allowed_targets: ["example.test"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" },
    });
    const operator = createPrincipal("operator", "report-operator", engagement.id);
    const host = createPrincipal("host", "report-host", engagement.id);
    const approved = await approvedScope(store, engagement, service, operator);
    const resource = await store.commit({ id: uuidv7(), schema_version: "1.0.0", engagement_id: engagement.id, kind: "resource", asset_type: "endpoint", identity: { host: "example.test", path: "/" }, revision: 1 }, "L2");
    const observation = await store.commit({ id: uuidv7(), engagement_id: engagement.id, kind: "observation", resource_ref: resource.id, statement: "observed endpoint" }, "L2");
    const revision = await store.commit({
      id: uuidv7(), schema_version: "1.0.0", engagement_id: engagement.id, kind: "resource_revision", resource_ref: resource.id, revision: 1,
      logical_identity: resource.identity, variant: { method: "GET", path_template: "/" }, content_hash: digest("b"), source_observation_refs: [observation.id], valid_from: new Date().toISOString(),
    }, "L2");
    const dimension = { resource_ref: resource.id, resource_revision_ref: revision.id, test_category: "authorization", conditions: ["anonymous"] };
    const manifestResponse = await service.dispatch("coverage.manifest.commit", operator, { engagement_id: engagement.id, scope_revision_ref: approved.revision.id, policy_digest: approved.revision.policy_digest, expected_cells: [dimension], idempotency_key: "public-report-manifest" });
    assert.equal(manifestResponse.ok, true, JSON.stringify(manifestResponse));
    const manifest = manifestResponse.data;
    const coverageWrite = await service.dispatch("coverage.record", host, {
      engagement_id: engagement.id, expected_version: 0, ...dimension, scope_revision_ref: approved.revision.id, policy_digest: approved.revision.policy_digest,
      status: "not_applicable", not_applicable_reason: "no authenticated operation is exposed", limitations: [], evidence_refs: [],
    });
    assert.equal(coverageWrite.ok, true, JSON.stringify(coverageWrite));
    const reportArtifact = await commitArtifact(service, host, engagement.id, join(root, "content"), "report", "# Verified report\n");
    const reportArtifactId = reportArtifact.artifact_id;
    const reportArtifactRef = reportArtifact.content_ref;
    const coverageResponse = await service.dispatch("coverage.snapshot", host, { engagement_id: engagement.id, manifest_ref: manifest.id, manifest_digest: manifest.manifest_digest, include_candidates: true, visibility_mode: "complete", page_size: 200 });
    assert.equal(coverageResponse.ok, true, JSON.stringify(coverageResponse));
    const coverage = coverageResponse.data;
    assert.equal(coverage.complete_domain, true);
    const request = {
      engagement_id: engagement.id, expected_authority_seq: coverage.read_seq, manifest_ref: manifest.id, manifest_digest: manifest.manifest_digest, scope_revision_ref: approved.revision.id,
      resource_revision_refs: [revision.id], coverage_read_seq: coverage.read_seq, coverage_snapshot_digest: coverage.snapshot_digest,
      report_artifact_session_id: "report", report_artifact_ref: reportArtifactRef, idempotency_key: "public-report-1",
    };
    const model = createPrincipal("model", "model", engagement.id);
    assert.equal((await service.dispatch("report.snapshot.commit", model, request)).error.code, "authorization_error");
    const snapshot = await service.dispatch("report.snapshot.commit", operator, request);
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.equal(snapshot.data.kind, "report_snapshot");
    assert.equal(snapshot.data.report_artifact_id, reportArtifactId);
    assert.deepEqual(snapshot.data.resource_revision_refs, [revision.id]);
    assert.equal(snapshot.data.evidence_read_seq, coverage.read_seq);
    const restartedService = await createCoreService(store, join(root, "changed-content-root"));
    const replay = await restartedService.dispatch("report.snapshot.commit", operator, request);
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.data.id, snapshot.data.id, "an exact report retry remains idempotent across service recreation and content-root relocation");
    await assert.rejects(store.commit({ ...snapshot.data, report_artifact_digest: digest("d") }, "L2", undefined, undefined, true, snapshot.data.version), /immutable revision records/);
    const closeRequest = { engagement_id: engagement.id, expected_engagement_version: engagement.version, expected_authority_seq: snapshot.data.commit_seq, report_snapshot_ref: snapshot.data.id, reason: "complete", idempotency_key: "public-close-1" };
    assert.equal((await service.dispatch("engagement.close", createPrincipal("host", "host", engagement.id), closeRequest)).error.code, "authorization_error");
    const closed = await service.dispatch("engagement.close", operator, closeRequest);
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(closed.data.engagement.status, "completed");
    assert.equal((await service.dispatch("engagement.close", operator, closeRequest)).data.id, closed.data.id);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
