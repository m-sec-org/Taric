import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

async function fixture() {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const other_engagement_id = uuidv7();
  const host = createPrincipal("host", "state-host", engagement_id);
  const model = createPrincipal("model", "state-model", engagement_id);
  await store.commit({ id: engagement_id, engagement_id, kind: "engagement", name: "state" }, "L2");
  await store.commit({ id: other_engagement_id, engagement_id: other_engagement_id, kind: "engagement", name: "other" }, "L2");
  return { store, service, engagement_id, other_engagement_id, host, model };
}

test("host.state is scoped, bounded, and hides its internal sequence", async () => {
  const ctx = await fixture();
  try {
    for (let index = 0; index < 3; index++) {
      await ctx.store.commit({ id: uuidv7(), engagement_id: ctx.engagement_id, kind: "claim", proposition: `candidate-${index}` }, "L1");
    }
    await ctx.store.commit({ id: uuidv7(), engagement_id: ctx.other_engagement_id, kind: "claim", proposition: "other" }, "L1");
    const state = await ctx.service.dispatch("host.state", ctx.host, { engagement_id: ctx.engagement_id, limit: 1 });
    assert.equal(state.ok, true);
    assert.deepEqual(state.data.aggregates, { l1_pending: 1, conflicts: 0, impacts: 0, unknown_actions: 0, expired_leases: 0, freshness_due: 0 });
    assert.deepEqual(state.data.aggregate_completeness, { l1_pending: false, conflicts: true, impacts: true, unknown_actions: true, expired_leases: true, freshness_due: false });
    assert.equal(state.data.bounded, true);
    assert.equal(Object.hasOwn(state.data.watermark, "latest_record_sequence"), false);
    assert.equal(state.data.engagement_id, ctx.engagement_id);
    assert.equal(JSON.stringify(state.data).includes(ctx.other_engagement_id), false);

    const next = await ctx.store.commit({ id: uuidv7(), engagement_id: ctx.engagement_id, kind: "claim", proposition: "later" }, "L2");
    const after = await ctx.service.dispatch("host.state", ctx.host, { engagement_id: ctx.engagement_id, limit: 1 });
    assert.equal(after.ok, true);
    assert.notEqual(after.data.watermark.scope, state.data.watermark.scope, "a later scoped record commit changes the watermark");
    assert.equal(next.engagement_id, ctx.engagement_id);
  } finally {
    await ctx.store.close();
  }
});

test("host.state rejects model and cross-Engagement reads before state lookup", async () => {
  const ctx = await fixture();
  try {
    assert.equal((await ctx.service.dispatch("host.state", ctx.model, { engagement_id: ctx.engagement_id })).error.code, "authorization_error");
    assert.equal((await ctx.service.dispatch("host.state", ctx.host, { engagement_id: ctx.other_engagement_id })).error.code, "authorization_error");
  } finally {
    await ctx.store.close();
  }
});

test("host.state evaluates lease expiry at read time without an intervening commit", async () => {
  const ctx = await fixture();
  try {
    const work_item_id = uuidv7();
    await ctx.store.commit({ id: work_item_id, engagement_id: ctx.engagement_id, kind: "work_item", title: "lease", status: "queued", acceptance_criteria: ["observe"] }, "L2");
    const run = await ctx.store.claimWorkRun({ work_item_id, engagement_id: ctx.engagement_id, host_id: ctx.host.id, agent_id: "worker", ttl_ms: 1000 });
    const recommended = await ctx.store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "llm_recommend", target: "target", method: "GET /", rationale: "check", status: "recommended", host_id: ctx.host.id });
    await ctx.store.recordActionIntent({ action_id: recommended.action_id, run_id: run.run_id, generation: run.generation, mode: "llm_recommend", status: "authorized", host_decision_ref: "decision", host_id: ctx.host.id });
    await ctx.store.recordActionIntent({ action_id: recommended.action_id, run_id: run.run_id, generation: run.generation, mode: "llm_recommend", status: "unknown", host_id: ctx.host.id });
    await ctx.store.commit({ id: uuidv7(), engagement_id: ctx.engagement_id, kind: "claim", proposition: "time-bound", expires_at: new Date(Date.now() + 500).toISOString() }, "L2");
    const before = await ctx.service.dispatch("host.state", ctx.host, { engagement_id: ctx.engagement_id, limit: 10 });
    assert.equal(before.ok, true);
    assert.equal(before.data.aggregates.expired_leases, 0);
    assert.equal(before.data.aggregates.freshness_due, 0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const state = await ctx.service.dispatch("host.state", ctx.host, { engagement_id: ctx.engagement_id, limit: 10 });
    assert.equal(state.ok, true);
    assert.equal(state.data.aggregates.expired_leases, 1);
    assert.equal(state.data.aggregates.unknown_actions, 1);
    assert.equal(state.data.aggregates.freshness_due, 1);
    assert.equal(state.data.freshness.lease_expired_at_read, true);
    assert.equal(state.data.freshness.evaluated_at, state.data.read_time);
  } finally {
    await ctx.store.close();
  }
});
