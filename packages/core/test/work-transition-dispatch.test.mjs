import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

async function setup() {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const work_item_id = uuidv7();
  await store.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "transition", status: "queued", acceptance_criteria: ["complete"] }, "L2");
  const host = createPrincipal("host", "transition-host", engagement_id);
  const run = await service.dispatch("work.claim", host, { engagement_id, work_item_id, agent_id: "worker" });
  assert.equal(run.ok, true, JSON.stringify(run));
  return { store, service, engagement_id, host, run: run.data };
}

test("work.transition applies a fenced transition and retries idempotently", async () => {
  const { store, service, engagement_id, host, run } = await setup();
  try {
    const request = { engagement_id, work_run_id: run.run_id, generation: run.generation, status: "running", idempotency_key: "transition-running" };
    const first = await service.dispatch("work.transition", host, request);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.status, "running");
    assert.deepEqual(await service.dispatch("work.transition", host, request), first);
    assert.equal((await store.events()).filter((event) => event.event_type === "work_run.transition").length, 1);

    const rebound = await service.dispatch("work.transition", host, { ...request, status: "completed" });
    assert.equal(rebound.ok, false);
    assert.equal(rebound.error.code, "idempotency_conflict");
  } finally {
    await service.close();
  }
});

test("work.transition derives host ownership from the authenticated principal", async () => {
  const { service, engagement_id, host, run } = await setup();
  const otherHost = createPrincipal("host", "other-transition-host", engagement_id);
  try {
    const fenced = await service.dispatch("work.transition", otherHost, {
      engagement_id, work_run_id: run.run_id, generation: run.generation, status: "running",
    });
    assert.equal(fenced.ok, false);
    assert.equal(fenced.error.code, "stale_version");

    for (const extra of [{ host_id: host.id }, { owner: host.id }]) {
      const rejected = await service.dispatch("work.transition", host, {
        engagement_id, work_run_id: run.run_id, generation: run.generation, status: "running", ...extra,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "validation_error");
    }

    const model = createPrincipal("model", "transition-model", engagement_id);
    const denied = await service.dispatch("work.transition", model, {
      engagement_id, work_run_id: run.run_id, generation: run.generation, status: "running",
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "authorization_error");
  } finally {
    await service.close();
  }
});

test("work.transition validates generation, target status, and legal state transitions", async () => {
  const { service, engagement_id, host, run } = await setup();
  try {
    const invalidGeneration = await service.dispatch("work.transition", host, {
      engagement_id, work_run_id: run.run_id, generation: 0, status: "running",
    });
    assert.equal(invalidGeneration.error.code, "validation_error");

    const invalidStatus = await service.dispatch("work.transition", host, {
      engagement_id, work_run_id: run.run_id, generation: run.generation, status: "claimed",
    });
    assert.equal(invalidStatus.error.code, "validation_error");

    const first = await service.dispatch("work.transition", host, {
      engagement_id, work_run_id: run.run_id, generation: run.generation, status: "completed",
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const terminal = await service.dispatch("work.transition", host, {
      engagement_id, work_run_id: run.run_id, generation: run.generation, status: "failed",
    });
    assert.equal(terminal.error.code, "conflict");
  } finally {
    await service.close();
  }
});
