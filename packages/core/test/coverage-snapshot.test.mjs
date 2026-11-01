import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, coverageCloseGate, uuidv7 } from "../dist/index.js";

const policy = {
  allowed_targets: ["coverage.fixture.invalid"],
  excluded_targets: [],
  protocols: ["https"],
  ports: [{ from: 443, to: 443 }],
  methods: ["GET"],
  dns: { require_pinned_addresses: true, reject_private_addresses: true, max_addresses: 8 },
  redirects: { max_hops: 2, same_scope_only: true },
  valid_from: "2026-01-01T00:00:00.000Z",
  valid_until: "2030-01-01T00:00:00.000Z",
};

async function saveRoe(store, engagementId) {
  const artifactId = uuidv7();
  const contentRef = `${artifactId}@v1`;
  const contentHash = `sha256:${"b".repeat(64)}`;
  const bytes = Buffer.from("approved ROE");
  await store.saveArtifactCatalogRow({
    content_ref: contentRef,
    engagement_id: engagementId,
    session_id: "coverage-roe",
    artifact_id: artifactId,
    version: 1,
    payload_kind: "text",
    media_type: "text/plain",
    storage_mode: "taric_stored",
    byte_length: bytes.length,
    chunk_count: 1,
    content_hash: contentHash,
    content_status: "available",
    integrity_status: "verified",
    stored_at: new Date().toISOString(),
    relative_dir: "",
    manifest_path: "",
  }, [{ ordinal: 0, offset: 0, bytes: bytes.length, hash: contentHash, path: "roe/chunk" }]);
  return { content_ref: contentRef };
}

async function fixture({ omitCell = -1 } = {}) {
  const store = new AuthorityStore();
  const engagement = await store.initializeEngagement({
    name: "coverage manifest fixture",
    scope: { allowed_targets: policy.allowed_targets, excluded_targets: [], rules_of_engagement_ref: "fixture:roe" },
  });
  const scope = await store.get(engagement.scope_ref);
  const roe = await saveRoe(store, engagement.id);
  const { revision } = await store.reviseScope({
    engagement_id: engagement.id,
    scope_id: scope.id,
    expected_version: scope.version,
    policy,
    roe_artifact_ref: roe.content_ref,
    roe_artifact_version: 1,
    idempotency_key: "coverage-snapshot-scope-revision",
    principal: "operator",
  });
  const policyDigest = revision.policy_digest;
  const resources = await Promise.all(Array.from({ length: 3 }, (_, index) => store.commit({
    id: uuidv7(), schema_version: "1.0.0", engagement_id: engagement.id, kind: "resource", asset_type: "endpoint",
    identity: { origin: "https://coverage.fixture.invalid", path: `/${index}` }, revision: 1,
  }, "L2", undefined, undefined, false, 0)));
  const expected_cells = resources.map((resource, index) => ({
    resource_ref: resource.id, test_category: "authorization", conditions: [`role-${index}`],
  }));
  const manifest = await store.commitCoverageManifest({
    engagement_id: engagement.id, scope_revision_ref: revision.id, policy_digest: policyDigest, expected_cells,
    principal: "operator", idempotency_key: "coverage-manifest-1",
  });
  const cells = await Promise.all(expected_cells.flatMap((dimension, index) => index === omitCell ? [] : [store.commit({
    id: uuidv7(), schema_version: "1.0.0", engagement_id: engagement.id, kind: "coverage", ...dimension,
    scope_revision_ref: revision.id, policy_digest: policyDigest,
    status: index === 2 ? "inconclusive" : "not_applicable",
    ...(index === 2 ? {} : { not_applicable_reason: "fixture dimension is not applicable" }),
    limitations: [], conditions: dimension.conditions, evidence_refs: [],
  }, "L1", undefined, undefined, false, 0)]));
  return { store, engagement_id: engagement.id, revision, manifest, cells, expected_cells };
}

test("Coverage manifest binds the expected dimensions and rejects missing or stale scope bindings", async () => {
  const { store, engagement_id, manifest, cells } = await fixture();
  try {
    const snapshot = await store.coverageSnapshotPage({ engagement_id, manifest_ref: manifest.id, manifest_digest: manifest.manifest_digest, include_candidates: true, page_size: 1 });
    assert.equal(snapshot.expected_items_source, "canonical_manifest");
    assert.equal(snapshot.manifest_binding_verified, true);
    assert.equal(snapshot.manifest_binding_state, "approved");
    assert.equal(snapshot.expected_cell_count, 3);
    assert.equal(snapshot.missing_items_complete, true);
    assert.deepEqual(snapshot.missing_items, []);
    assert.equal(snapshot.complete_domain, true, "the fixed domain is complete even when the page has a continuation");
    await assert.rejects(store.coverageSnapshotPage({
      engagement_id, manifest_ref: manifest.id, manifest_digest: `sha256:${"c".repeat(64)}`, include_candidates: true,
    }), (error) => error.code === "stale_version");
    assert.equal(cells.length, 3);
  } finally { await store.close(); }
});

test("Coverage cursor preserves record_versions at its watermark and binds all query dimensions", async () => {
  const { store, engagement_id, manifest, cells } = await fixture();
  try {
    const ordered = [...cells].sort((left, right) => left.id.localeCompare(right.id));
    const first = await store.coverageSnapshotPage({ engagement_id, manifest_ref: manifest.id, include_candidates: true, page_size: 1 });
    const asOf = first.read_seq;
    const nextCell = ordered.find((cell) => cell.id !== first.cells[0].id);
    assert.ok(nextCell);
    await store.commit({ ...nextCell, status: "queued" }, "L1", undefined, undefined, true, nextCell.version);
    const ids = [...first.cells.map((cell) => cell.id)];
    let cursor = first.next_cursor;
    let digest = first.snapshot_digest;
    let nextCellOldVersionSeen = false;
    while (cursor) {
      const page = await store.coverageSnapshotPage({ engagement_id, manifest_ref: manifest.id, include_candidates: true, page_size: 1, cursor });
      assert.equal(page.read_seq, asOf);
      assert.equal(page.snapshot_digest, digest);
      ids.push(...page.cells.map((cell) => cell.id));
      if (page.cells.some((cell) => cell.id === nextCell.id)) {
        assert.equal(page.cells.find((cell) => cell.id === nextCell.id).status, nextCell.status);
        nextCellOldVersionSeen = true;
      }
      cursor = page.next_cursor;
    }
    assert.equal(nextCellOldVersionSeen, true);
    assert.equal(new Set(ids).size, 3);
    await assert.rejects(store.coverageSnapshotPage({
      engagement_id, manifest_ref: manifest.id, include_candidates: true, page_size: 2, cursor: first.next_cursor,
    }), (error) => error.code === "invalid_cursor");
  } finally { await store.close(); }
});

test("Coverage continuation keeps missing manifest metadata fixed at the snapshot watermark", async () => {
  const { store, engagement_id, manifest } = await fixture({ omitCell: 2 });
  try {
    const first = await store.coverageSnapshotPage({ engagement_id, manifest_ref: manifest.id, include_candidates: true, page_size: 1 });
    assert.equal(first.missing_items.length, 1);
    assert.equal(first.missing_items_complete, true);
    assert.equal(first.has_more, true);
    const second = await store.coverageSnapshotPage({ engagement_id, manifest_ref: manifest.id, include_candidates: true, page_size: 1, cursor: first.next_cursor });
    assert.deepEqual(second.missing_items, first.missing_items);
    assert.equal(second.missing_items_complete, first.missing_items_complete);
    assert.equal(second.complete_domain, first.complete_domain);
    assert.equal(second.snapshot_digest, first.snapshot_digest);
  } finally { await store.close(); }
});

test("Coverage continuation recomputes large missing lists without oversized cursors", async () => {
  const { store, engagement_id, revision, expected_cells } = await fixture();
  try {
    const resource_ref = expected_cells[0].resource_ref;
    for (let index = 0; index < 2; index += 1) {
      await store.commit({
        id: uuidv7(), schema_version: "1.0.0", engagement_id, kind: "coverage", resource_ref,
        scope_revision_ref: revision.id, policy_digest: revision.policy_digest,
        test_category: "unrelated", conditions: [`extra-${index}`], status: "not_applicable",
        not_applicable_reason: "outside this manifest", limitations: [], evidence_refs: [],
      }, "L1", undefined, undefined, false, 0);
    }
    const expected = Array.from({ length: 50 }, (_, index) => ({
      resource_ref, test_category: "bulk", conditions: [`expected-${index}`],
    }));
    const manifest = await store.commitCoverageManifest({
      engagement_id, scope_revision_ref: revision.id, policy_digest: revision.policy_digest,
      expected_cells: expected, idempotency_key: "coverage-large-missing-manifest",
    });
    const first = await store.coverageSnapshotPage({ engagement_id, manifest_ref: manifest.id, include_candidates: true, page_size: 1 });
    assert.equal(first.missing_items.length, expected.length);
    assert.equal(first.has_more, true);
    assert.ok(first.next_cursor.length <= 4096);
    const second = await store.coverageSnapshotPage({ engagement_id, manifest_ref: manifest.id, include_candidates: true, page_size: 1, cursor: first.next_cursor });
    assert.deepEqual(second.missing_items, first.missing_items);
    assert.equal(second.missing_items_complete, true);
    assert.equal(second.read_seq, first.read_seq);
  } finally { await store.close(); }
});

test("coverage.snapshot exposes the fixed snapshot through the public operation contract", async () => {
  const { store, engagement_id, manifest, cells } = await fixture();
  const service = await createCoreService(store);
  const host = createPrincipal("host", "coverage-host", engagement_id);
  const otherHost = createPrincipal("host", "other-coverage-host", engagement_id);
  const model = createPrincipal("model", "coverage-model", engagement_id);
  try {
    const request = {
      engagement_id,
      manifest_ref: manifest.id,
      manifest_digest: manifest.manifest_digest,
      include_candidates: true,
      visibility_mode: "complete",
      page_size: 1,
    };
    const first = await service.dispatch("coverage.snapshot", host, request);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.expected_cell_count, 3);
    assert.equal(first.data.complete_domain, true);
    assert.equal(first.data.has_more, true);

    const nextCell = [...cells].sort((left, right) => left.id.localeCompare(right.id)).find((cell) => cell.id !== first.data.cells[0].id);
    assert.ok(nextCell);
    await store.commit({ ...nextCell, status: "queued" }, "L1", undefined, undefined, true, nextCell.version);
    const second = await service.dispatch("coverage.snapshot", host, { ...request, cursor: first.data.next_cursor });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.data.read_seq, first.data.read_seq);
    assert.equal(second.data.snapshot_id, first.data.snapshot_id);
    assert.equal(second.data.snapshot_digest, first.data.snapshot_digest);
    assert.equal(second.data.cells[0].status, nextCell.status);

    const gate = await service.dispatch("coverage.gate", host, {
      engagement_id,
      manifest_ref: manifest.id,
      manifest_digest: manifest.manifest_digest,
      as_of: first.data.read_seq,
    });
    assert.equal(gate.ok, true, JSON.stringify(gate));
    assert.equal(gate.data.read_seq, first.data.read_seq);
    assert.equal(gate.data.snapshot_id, first.data.snapshot_id);
    assert.equal(gate.data.snapshot_digest, first.data.snapshot_digest);

    const crossPrincipal = await service.dispatch("coverage.snapshot", otherHost, { ...request, cursor: first.data.next_cursor });
    assert.equal(crossPrincipal.ok, false);
    assert.equal(crossPrincipal.error.code, "invalid_cursor");
    const modelRead = await service.dispatch("coverage.snapshot", model, request);
    assert.equal(modelRead.ok, false);
    assert.equal(modelRead.error.code, "authorization_error");
    const invalidStatus = await service.dispatch("coverage.snapshot", host, { ...request, status: ["unknown"] });
    assert.equal(invalidStatus.ok, false);
    assert.equal(invalidStatus.error.code, "validation_error");
  } finally {
    await service.close();
  }
});

test("Coverage gate fails closed for an unmanifested observed set and reports inconclusive manifest cells", async () => {
  const { store, engagement_id, manifest } = await fixture();
  try {
    const observedOnly = await coverageCloseGate(store, engagement_id);
    assert.equal(observedOnly.can_close, false);
    assert.equal(observedOnly.expected_items_source, "observed_cells");
    assert.equal(observedOnly.complete_domain, false);
    assert.ok(observedOnly.gaps.some((gap) => gap.kind === "incomplete_snapshot"));

    const gate = await coverageCloseGate(store, engagement_id, { manifest_ref: manifest.id, manifest_digest: manifest.manifest_digest });
    assert.equal(gate.expected_items_source, "canonical_manifest");
    assert.equal(gate.complete_domain, true);
    assert.equal(gate.expected_cell_count, 3);
    assert.equal(gate.returned_cell_count, 3);
    assert.equal(gate.can_close, false);
    assert.ok(gate.gaps.some((gap) => gap.kind === "conflicting"));
  } finally { await store.close(); }
});

test("Coverage gate invalidates manifest cells pinned to a superseded ResourceRevision", async () => {
  const { store, engagement_id, revision, expected_cells } = await fixture();
  try {
    const resource_ref = expected_cells[0].resource_ref;
    const source = await store.commit({
      id: uuidv7(), schema_version: "1.0.0", engagement_id, kind: "observation",
      resource_ref, observed_at: new Date().toISOString(), statement: "resource state observed", artifact_refs: [{ host_ref: "fixture:observation" }],
    }, "L1");
    const firstRevision = (await store.createResourceRevision({
      engagement_id, resource_id: resource_ref, expected_version: (await store.get(resource_ref)).version,
      method: "GET", path: "/covered", content_hash: `sha256:${"c".repeat(64)}`,
      source_observation_refs: [source.id],
    })).revision;
    const dimension = { resource_ref, resource_revision_ref: firstRevision.id, test_category: "authorization", conditions: [] };
    const manifest = await store.commitCoverageManifest({
      engagement_id, scope_revision_ref: revision.id, policy_digest: revision.policy_digest,
      expected_cells: [dimension], idempotency_key: "coverage-stale-resource-manifest",
    });
    await store.commit({
      id: uuidv7(), schema_version: "1.0.0", engagement_id, kind: "coverage", ...dimension,
      scope_revision_ref: revision.id, policy_digest: revision.policy_digest, status: "not_applicable",
      not_applicable_reason: "fixture has no stateful authorization", limitations: [], evidence_refs: [],
    }, "L1", undefined, undefined, false, 0);
    await store.createResourceRevision({
      engagement_id, resource_id: resource_ref, expected_version: (await store.get(resource_ref)).version,
      method: "GET", path: "/covered", content_hash: `sha256:${"d".repeat(64)}`,
      source_observation_refs: [source.id],
    });

    const gate = await coverageCloseGate(store, engagement_id, { manifest_ref: manifest.id, manifest_digest: manifest.manifest_digest });
    assert.equal(gate.can_close, false);
    assert.equal(gate.complete_domain, false);
    assert.ok(gate.gaps.some((gap) => gap.kind === "pending_revalidation" && gap.reason.includes("ResourceRevision")));
  } finally { await store.close(); }
});
