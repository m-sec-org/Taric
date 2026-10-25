import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

async function setup() {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource_ref = uuidv7();
  await store.commit({ id: resource_ref, engagement_id, kind: "resource", asset_type: "service", identity: "coverage-record.internal", revision: 1 }, "L2");
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
    assert.equal((await store.get(first.data.id)).version, 2);
  } finally {
    await service.close();
  }
});

test("coverage.record enforces stable dimensions, principal roles, and request-bound idempotency", async () => {
  const { service, engagement_id, resource_ref, host } = await setup();
  try {
    const request = {
      engagement_id,
      resource_ref,
      test_category: "authorization",
      status: "queued",
      limitations: [],
      expected_version: 0,
      idempotency_key: "coverage-create-2",
    };
    const created = await service.dispatch("coverage.record", host, request);
    assert.equal(created.ok, true, JSON.stringify(created));

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
