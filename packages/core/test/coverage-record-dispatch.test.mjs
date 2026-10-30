import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

async function setup() {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource_ref = uuidv7();
  await store.commit({ id: resource_ref, engagement_id, kind: "resource", asset_type: "service", identity: { origin: "coverage-record.internal" }, revision: 1 }, "L2");
  const host = createPrincipal("host", "coverage-writer", engagement_id);
  return { store, service, engagement_id, resource_ref, host };
}

test("coverage.record creates an L1 cell idempotently and exposes a versioned CAS update", async () => {
  const { store, service, engagement_id, resource_ref, host } = await setup();
  try {
    const create = {
      engagement_id,
      resource_ref,
      test_category: "access-control",
      status: "not_tested",
      limitations: [],
      expected_version: 0,
      idempotency_key: "coverage-create-1",
    };
    const first = await service.dispatch("coverage.record", host, create);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.kind, "coverage");
    assert.equal(first.data.version, 1);
    assert.equal(first.data.trust_level, "L1");
    assert.deepEqual(await service.dispatch("coverage.record", host, create), first);
    assert.equal((await store.events()).find((event) => event.event_type === "record.commit" && event.subject_id === first.data.id)?.payload.actor_id, host.id);

    const update = {
      engagement_id,
      cell_id: first.data.id,
      resource_ref,
      test_category: "access-control",
      status: "positive",
      evidence_refs: [],
      limitations: ["result requires independent evidence"],
      expected_version: 1,
      idempotency_key: "coverage-update-1",
    };
    const updated = await service.dispatch("coverage.record", host, update);
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.data.version, 2);
    assert.equal(updated.data.status, "positive");
    assert.deepEqual(await service.dispatch("coverage.record", host, update), updated);

    const reusedKeyWithDifferentVersion = await service.dispatch("coverage.record", host, { ...update, expected_version: 2 });
    assert.equal(reusedKeyWithDifferentVersion.ok, false);
    assert.equal(reusedKeyWithDifferentVersion.error.code, "idempotency_conflict");

    const staleRequest = { ...update };
    delete staleRequest.idempotency_key;
    const stale = await service.dispatch("coverage.record", host, staleRequest);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "stale_version");
    const afterStale = await store.get(first.data.id);
    assert.equal(afterStale.version, 2);
    assert.equal(afterStale.status, "positive", "a failed stale-version CAS must not apply the update");
  } finally {
    await service.close();
  }
});

test("coverage.record accepts only same-Engagement Resource and Resource revision references", async () => {
  const { store, service, engagement_id, resource_ref, host } = await setup();
  const foreign_engagement_id = uuidv7();
  const foreign_resource = await store.commit({ id: uuidv7(), engagement_id: foreign_engagement_id, kind: "resource", asset_type: "service", identity: { origin: "foreign.internal" }, revision: 1 }, "L2");
  const source = await store.commit({ id: uuidv7(), engagement_id: foreign_engagement_id, kind: "observation", statement: "foreign revision source" }, "L2");
  const foreign_revision = (await store.createResourceRevision({
    engagement_id: foreign_engagement_id,
    resource_id: foreign_resource.id,
    expected_version: foreign_resource.version,
    method: "GET",
    path: "/foreign",
    content_hash: `sha256:${"f".repeat(64)}`,
    source_observation_refs: [source.id],
  })).revision;
  try {
    const cross_resource = await service.dispatch("coverage.record", host, {
      engagement_id,
      resource_ref: foreign_resource.id,
      test_category: "authorization",
      status: "not_tested",
      limitations: [],
      expected_version: 0,
      idempotency_key: "coverage-foreign-resource",
    });
    assert.equal(cross_resource.ok, false);
    assert.equal(cross_resource.error.code, "validation_error");
    assert.match(cross_resource.error.message, /cross-engagement/);

    const cross_revision = await service.dispatch("coverage.record", host, {
      engagement_id,
      resource_ref,
      resource_revision_ref: foreign_revision.id,
      test_category: "authorization",
      status: "not_tested",
      limitations: [],
      expected_version: 0,
      idempotency_key: "coverage-foreign-revision",
    });
    assert.equal(cross_revision.ok, false);
    assert.equal(cross_revision.error.code, "validation_error");
    assert.match(cross_revision.error.message, /cross-engagement/);
  } finally {
    await service.close();
  }
});

test("coverage.record enforces stable dimensions, principal roles, and request-bound idempotency", async () => {
  const { store, service, engagement_id, resource_ref, host } = await setup();
  try {
    const alternate_resource = await store.commit({ id: uuidv7(), engagement_id, kind: "resource", asset_type: "service", identity: { origin: "alternate.internal" }, revision: 1 }, "L2");
    const identity_ref = await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "test identity" }, "L2");
    const alternate_identity_ref = await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "alternate identity" }, "L2");
    const tenant_ref = await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "test tenant" }, "L2");
    const alternate_tenant_ref = await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "alternate tenant" }, "L2");
    const source = await store.commit({ id: uuidv7(), engagement_id, kind: "observation", statement: "revision source" }, "L2");
    const revision = (await store.createResourceRevision({
      engagement_id,
      resource_id: resource_ref,
      expected_version: (await store.get(resource_ref)).version,
      method: "GET",
      path: "/",
      content_hash: `sha256:${"a".repeat(64)}`,
      source_observation_refs: [source.id],
    })).revision;
    const alternate_revision = (await store.createResourceRevision({
      engagement_id,
      resource_id: resource_ref,
      expected_version: (await store.get(resource_ref)).version,
      method: "POST",
      path: "/",
      content_hash: `sha256:${"b".repeat(64)}`,
      source_observation_refs: [source.id],
    })).revision;
    const request = {
      engagement_id,
      resource_ref,
      test_category: "authorization",
      resource_revision_ref: revision.id,
      identity_ref: identity_ref.id,
      role: "user",
      tenant_ref: tenant_ref.id,
      operation: "GET",
      parameter: "id",
      conditions: ["tls", "role=user"],
      path: "/",
      network_condition: "vpn",
      method: "GET",
      status: "queued",
      limitations: [],
      expected_version: 0,
      idempotency_key: "coverage-create-2",
    };
    const created = await service.dispatch("coverage.record", host, request);
    assert.equal(created.ok, true, JSON.stringify(created));

    const changed_dimensions = [
      ["resource_ref", alternate_resource.id],
      ["resource_revision_ref", alternate_revision.id],
      ["test_category", "different-category"],
      ["identity_ref", alternate_identity_ref.id],
      ["role", "admin"],
      ["tenant_ref", alternate_tenant_ref.id],
      ["operation", "POST"],
      ["parameter", "tenant_id"],
      ["conditions", ["tls", "role=admin"]],
      ["path", "/admin"],
      ["network_condition", "direct"],
      ["method", "POST"],
    ];
    for (const [field, value] of changed_dimensions) {
      const changed = await service.dispatch("coverage.record", host, {
        ...request,
        cell_id: created.data.id,
        expected_version: 1,
        [field]: value,
        idempotency_key: undefined,
      });
      assert.equal(changed.ok, false, `${field} must remain stable: ${JSON.stringify(changed)}`);
      assert.equal(changed.error.code, "conflict", `${field} must reject dimension changes`);
    }

    const changedIdentity = await service.dispatch("coverage.record", host, {
      ...request,
      cell_id: created.data.id,
      expected_version: 1,
      resource_ref: uuidv7(),
      idempotency_key: "coverage-change-identity",
    });
    assert.equal(changedIdentity.ok, false);
    assert.equal(changedIdentity.error.code, "conflict");

    const changedReplay = await service.dispatch("coverage.record", host, {
      ...request,
      cell_id: created.data.id,
      expected_version: 1,
      resource_ref: uuidv7(),
    });
    assert.equal(changedReplay.ok, false);
    assert.equal(changedReplay.error.code, "idempotency_conflict");

    const reusedKey = await service.dispatch("coverage.record", host, { ...request, status: "blocked" });
    assert.equal(reusedKey.ok, false);
    assert.equal(reusedKey.error.code, "idempotency_conflict");
    assert.equal((await store.get(created.data.id)).version, 1, "rejected dimension changes must leave the cell version unchanged");

    const model = createPrincipal("model", "coverage-model", engagement_id);
    const denied = await service.dispatch("coverage.record", model, request);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "authorization_error");

    const selfAssigned = await service.dispatch("coverage.record", host, { ...request, owner: host.id });
    assert.equal(selfAssigned.ok, false);
    assert.equal(selfAssigned.error.code, "validation_error");
  } finally {
    await service.close();
  }
});
