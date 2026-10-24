import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, policyDigest, uuidv7 } from "../dist/index.js";

const workItem = (engagement_id, overrides = {}) => ({
  id: uuidv7(), engagement_id, kind: "work_item", title: "verify target",
  status: "queued", acceptance_criteria: ["evidence"], ...overrides,
});

async function seedRows(store, records) {
  const now = new Date().toISOString();
  await store.sql.transaction("write", async () => {
    for (const record of records) {
      await store.sql.run(
        "INSERT INTO records(id,engagement_id,kind,trust_level,version,display_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        record.id, record.engagement_id, record.kind, "L2", 1, null, JSON.stringify(record), now, now,
      );
    }
  });
}

test("work item resource references validate fail-closed at proposal time", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const other_engagement = uuidv7();
  const resource_id = uuidv7();
  const resource_elsewhere = uuidv7();
  (await store.commit({ id: resource_id, engagement_id, kind: "resource", asset_type: "service", identity: "api.internal", revision: 1 }, "L2"));
  (await store.commit({ id: resource_elsewhere, engagement_id: other_engagement, kind: "resource", asset_type: "service", identity: "other.internal", revision: 1 }, "L2"));
  const host = createPrincipal("host", "host-a", engagement_id);
  const submit = (content) => service.dispatch("proposal.submit", host, { engagement_id, subject_type: "work_item", expected_version: 0, content: { schema_version: "1.0.0", engagement_id, kind: "work_item", ...content } });
  try {
    const accepted = await submit({ title: "verify", status: "queued", acceptance_criteria: ["evidence"], resource_refs: [resource_id] });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const dangling = await submit({ title: "verify", status: "queued", acceptance_criteria: ["evidence"], resource_refs: [uuidv7()] });
    assert.equal(dangling.ok, false);
    assert.equal(dangling.error.code, "validation_error");
    const crossEngagement = await submit({ title: "verify", status: "queued", acceptance_criteria: ["evidence"], resource_refs: [resource_elsewhere] });
    assert.equal(crossEngagement.ok, false);
    assert.equal(crossEngagement.error.code, "validation_error");
    const wrongKind = await submit({ title: "verify", status: "queued", acceptance_criteria: ["evidence"], resource_refs: [engagement_id] });
    assert.equal(wrongKind.ok, false);
    const oversized = await submit({ title: "verify", status: "queued", acceptance_criteria: ["evidence"], resource_refs: Array.from({ length: 65 }, () => resource_id) });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error.code, "validation_error");
    const legacy = await submit({ title: "verify legacy", status: "queued", acceptance_criteria: ["evidence"] });
    assert.equal(legacy.ok, true, JSON.stringify(legacy));
  } finally { await service.close(); }
});

test("work.query filters by resource and status and joins active runs from one snapshot", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resourceA = uuidv7();
  const resourceB = uuidv7();
  (await store.commit({ id: resourceA, engagement_id, kind: "resource", asset_type: "endpoint", identity: "a.internal", revision: 1 }, "L2"));
  (await store.commit({ id: resourceB, engagement_id, kind: "resource", asset_type: "endpoint", identity: "b.internal", revision: 1 }, "L2"));
  const itemA = workItem(engagement_id, { resource_refs: [resourceA] });
  const itemA2 = workItem(engagement_id, { resource_refs: [resourceA, resourceB], status: "in_progress" });
  const itemB = workItem(engagement_id, { resource_refs: [resourceB] });
  const itemNone = workItem(engagement_id);
  for (const item of [itemA, itemA2, itemB, itemNone]) (await store.commit(item, "L2"));
  const run = await store.claimWorkRun({ work_item_id: itemA2.id, engagement_id, host_id: "host-a", agent_id: "agent-1" });
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    const byResource = await service.dispatch("work.query", host, { engagement_id, resource_refs: [resourceA] });
    assert.equal(byResource.ok, true, JSON.stringify(byResource));
    assert.deepEqual(byResource.data.items.map((item) => item.id).sort(), [itemA.id, itemA2.id].sort());
    const byStatus = await service.dispatch("work.query", host, { engagement_id, status: ["in_progress"] });
    assert.deepEqual(byStatus.data.items.map((item) => item.id), [itemA2.id]);
    const withRuns = await service.dispatch("work.query", host, { engagement_id, resource_refs: [resourceA], include_active_runs: true });
    const withRun = withRuns.data.items.find((item) => item.id === itemA2.id);
    assert.equal(withRun.active_run.run_id, run.run_id);
    assert.equal(withRun.active_run.generation, run.generation);
    assert.equal(withRun.active_run.owner_host, "host-a");
    assert.ok(withRun.active_run.lease_expires_at > new Date().toISOString());
    const withoutRun = withRuns.data.items.find((item) => item.id === itemA.id);
    assert.equal(withoutRun.active_run, undefined);
    const plain = await service.dispatch("work.query", host, { engagement_id });
    assert.equal(plain.data.items.length, 4);
    assert.equal(plain.data.items.every((item) => item.active_run === undefined), true);
  } finally { await service.close(); }
});

test("work.query paginates by keyset without duplicates or skipped matches", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource = uuidv7();
  (await store.commit({ id: resource, engagement_id, kind: "resource", asset_type: "service", identity: "paged.internal", revision: 1 }, "L2"));
  const all = Array.from({ length: 5 }, () => workItem(engagement_id, { resource_refs: [resource] }));
  const noise = Array.from({ length: 3 }, () => workItem(engagement_id));
  for (const item of [...all, ...noise]) (await store.commit(item, "L2"));
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    const seen = [];
    let cursor;
    let pages = 0;
    for (;;) {
      const page = await service.dispatch("work.query", host, { engagement_id, resource_refs: [resource], page_size: 2, ...(cursor ? { cursor } : {}) });
      assert.equal(page.ok, true, JSON.stringify(page));
      seen.push(...page.data.items.map((item) => item.id));
      pages += 1;
      if (!page.data.has_more) { assert.equal(page.data.next_cursor, undefined); break; }
      cursor = page.data.next_cursor;
      assert.ok(pages < 10, "pagination did not terminate");
    }
    assert.equal(pages, 3);
    assert.deepEqual(seen.sort(), all.map((item) => item.id).sort());
    const reused = await service.dispatch("work.query", host, { engagement_id, resource_refs: [resource], page_size: 2, cursor: "v1.not-a-cursor.sig" });
    assert.equal(reused.ok, false);
    assert.equal(reused.error.code, "invalid_cursor");
  } finally { await service.close(); }
});

test("work.query dense matches crossing the scan budget are not skipped", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource_ref = uuidv7();
  const host = createPrincipal("host", "host-a", engagement_id);
  const expected = [];
  try {
    await store.commit({ id: resource_ref, engagement_id, kind: "resource", asset_type: "service", identity: "dense.internal", revision: 1 }, "L2");
    const records = Array.from({ length: 520 }, (_, index) => workItem(engagement_id, { title: `dense-${index}`, status: "queued", resource_refs: [resource_ref] }));
    expected.push(...records.map((item) => item.id));
    await seedRows(store, records);
    const seen = [];
    let cursor;
    let firstPage;
    for (;;) {
      const page = await service.dispatch("work.query", host, { engagement_id, resource_refs: [resource_ref], page_size: 200, ...(cursor ? { cursor } : {}) });
      assert.equal(page.ok, true, JSON.stringify(page));
      firstPage ??= page.data;
      seen.push(...page.data.items.map((item) => item.id));
      if (!page.data.has_more) break;
      cursor = page.data.next_cursor;
    }
    assert.equal(firstPage.scan_stats.scanned_rows, 500);
    assert.equal(firstPage.scan_stats.returned_rows, 200);
    assert.equal(seen.length, 520);
    assert.equal(new Set(seen).size, 520);
    assert.deepEqual(seen.sort(), expected.sort());
  } finally { await service.close(); }
});

test("work.query empty scan windows advance until the source is exhausted", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const missing_ref = uuidv7();
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    await seedRows(store, Array.from({ length: 520 }, (_, index) => workItem(engagement_id, { title: `noise-${index}`, resource_refs: [] })));
    const first = await service.dispatch("work.query", host, { engagement_id, resource_refs: [missing_ref], page_size: 50 });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.data.items, []);
    assert.equal(first.data.has_more, true);
    assert.ok(first.data.next_cursor);
    const second = await service.dispatch("work.query", host, { engagement_id, resource_refs: [missing_ref], page_size: 50, cursor: first.data.next_cursor });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.data.items, []);
    assert.equal(second.data.has_more, false);
    assert.equal(second.data.next_cursor, undefined);
  } finally { await service.close(); }
});

test("work.query sparse matches beyond the scan window are neither skipped nor repeated", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource_ref = uuidv7();
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    const records = Array.from({ length: 520 }, (_, index) => workItem(engagement_id, { title: `sparse-${index}`, resource_refs: [] }));
    records.sort((left, right) => left.id.localeCompare(right.id));
    records[10].resource_refs = [resource_ref];
    records[510].resource_refs = [resource_ref];
    const expected = [records[10].id, records[510].id].sort();
    await seedRows(store, records);

    const seen = [];
    let cursor;
    let firstPage;
    for (;;) {
      const page = await service.dispatch("work.query", host, { engagement_id, resource_refs: [resource_ref], page_size: 50, ...(cursor ? { cursor } : {}) });
      assert.equal(page.ok, true, JSON.stringify(page));
      firstPage ??= page.data;
      seen.push(...page.data.items.map((item) => item.id));
      if (!page.data.has_more) break;
      cursor = page.data.next_cursor;
      assert.ok(cursor);
    }
    assert.equal(firstPage.scan_stats.scanned_rows, 500);
    assert.equal(firstPage.scan_stats.returned_rows, 1);
    assert.deepEqual(seen.sort(), expected);
    assert.equal(new Set(seen).size, expected.length);
  } finally { await service.close(); }
});

test("work.query authorization separates roles and engagements", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const other_engagement = uuidv7();
  (await store.commit(workItem(engagement_id), "L2"));
  (await store.commit(workItem(other_engagement), "L2"));
  const model = createPrincipal("model", "model-a", engagement_id);
  const reviewer = createPrincipal("reviewer", "reviewer-a", engagement_id);
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    const modelView = await service.dispatch("work.query", model, { engagement_id });
    assert.equal(modelView.ok, true, JSON.stringify(modelView));
    assert.equal(modelView.data.items.length, 1);
    const denied = await service.dispatch("work.query", reviewer, { engagement_id });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "authorization_error");
    const cross = await service.dispatch("work.query", host, { engagement_id: other_engagement });
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, "authorization_error");
    const unsupported = await service.dispatch("work.query", host, { engagement_id, unexpected: true });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error.code, "validation_error");
  } finally { await service.close(); }
});

test("work.query projects model responses from an explicit safe field allowlist", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource_ref = uuidv7();
  const item = workItem(engagement_id, {
    goal: "Check the approved service boundary",
    resource_refs: [resource_ref],
    host_only_notes: "operator-only internal note",
    callback_url: "https://internal.example.test/callback",
    secret_token: "do-not-return",
    provenance: { host_id: "host-a", producer_id: "agent-a", source_kind: "host" },
  });
  await store.commit({ id: resource_ref, engagement_id, kind: "resource", asset_type: "service", identity: "projection.internal", revision: 1 }, "L2");
  await store.commit(item, "L2");
  const model = createPrincipal("model", "model-a", engagement_id);
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    const beforeEvents = Number((await store.sql.get("SELECT COUNT(*) AS count FROM events")).count);
    const beforeRuns = Number((await store.sql.get("SELECT COUNT(*) AS count FROM work_runs")).count);
    const modelResponse = await service.dispatch("work.query", model, { engagement_id, include_active_runs: true });
    assert.equal(modelResponse.ok, true, JSON.stringify(modelResponse));
    const projected = modelResponse.data.items[0];
    assert.deepEqual(Object.keys(projected).sort(), ["acceptance_criteria", "engagement_id", "goal", "id", "kind", "resource_refs", "status", "title", "version"].sort());
    assert.equal(projected.goal, item.goal);
    assert.equal(projected.resource_refs[0], item.resource_refs[0]);
    assert.equal("host_only_notes" in projected, false);
    assert.equal("callback_url" in projected, false);
    assert.equal("secret_token" in projected, false);
    assert.equal("provenance" in projected, false);
    assert.equal("active_run" in projected, false);
    assert.equal(Number((await store.sql.get("SELECT COUNT(*) AS count FROM events")).count), beforeEvents);
    assert.equal(Number((await store.sql.get("SELECT COUNT(*) AS count FROM work_runs")).count), beforeRuns);

    const hostResponse = await service.dispatch("work.query", host, { engagement_id });
    assert.equal(hostResponse.ok, true, JSON.stringify(hostResponse));
    assert.equal(hostResponse.data.items[0].host_only_notes, item.host_only_notes);
    assert.equal(hostResponse.data.items[0].callback_url, item.callback_url);
  } finally { await service.close(); }
});
