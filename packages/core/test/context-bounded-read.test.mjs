import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack } from "../dist/context.js";
import { AuthorityStore } from "../dist/store.js";

test("Context keyset reads stay bounded and pinned without snapshot or full event hydration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-context-pages-"));
  const store = new AuthorityStore(join(directory, "authority.sqlite"));
  try {
    const engagement = await store.initializeEngagement({ name: "bounded context", scope: { allowed_targets: ["https://context.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:authorized" } });
    const foreign = await store.initializeEngagement({ name: "foreign context", scope: { allowed_targets: ["https://foreign.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:authorized" } });
    const claims = await Promise.all(Array.from({ length: 7 }, (_, index) => store.createRecord({
      engagement_id: engagement.id, kind: "claim", proposition: `original-${index}`, status: "proposed", evidence_refs: [], limitations: []
    }, "L2")));
    const hidden = await store.createRecord({ engagement_id: engagement.id, kind: "claim", proposition: "L0 private", status: "proposed", evidence_refs: [], limitations: [] }, "L0");
    const foreignClaim = await store.createRecord({ engagement_id: foreign.id, kind: "claim", proposition: "foreign", status: "proposed", evidence_refs: [], limitations: [] }, "L2");

    const first = await buildContextPack(store, engagement.id, 1200, {
      principalId: "reader", includeCandidates: true, filters: { kind: "claim" }, scanBudget: 3,
      cursorKeyRoot: join(directory, "content")
    });
    assert.ok(first.cursor);
    assert.ok(first.read_stats.scanned_rows <= 3);
    assert.equal(first.read_stats.scan_budget, 3);
    assert.ok(!first.items.some((record) => record.id === hidden.id || record.id === foreignClaim.id));

    const changed = claims[6];
    await store.commit({ ...changed, proposition: "updated after first page" }, "L2", undefined, undefined, true, changed.version);
    await store.createRecord({ engagement_id: engagement.id, kind: "claim", proposition: "created after first page", status: "proposed", evidence_refs: [], limitations: [] }, "L2");
    store.snapshot = async () => { throw new Error("Context must not hydrate a full snapshot"); };
    store.events = async () => { throw new Error("Context must not hydrate the full event stream"); };

    const seen = first.items.map((record) => record.id);
    let cursor = first.cursor;
    while (cursor) {
      const page = await buildContextPack(store, engagement.id, 1200, {
        principalId: "reader", includeCandidates: true, filters: { kind: "claim" }, scanBudget: 3,
        cursorKeyRoot: join(directory, "content"), cursor
      });
      assert.equal(page.read_seq, first.read_seq);
      assert.ok(page.read_stats.scanned_rows <= 3);
      assert.ok(page.items.every((record) => record.version === 1));
      seen.push(...page.items.map((record) => record.id));
      cursor = page.cursor;
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen.toSorted(), claims.map((record) => record.id).toSorted());

    const current = await store.contextRecordsPage({ engagement_id: engagement.id, page_size: 1 });
    const boundedChanges = await store.changedRecordSubjects({
      engagement_id: engagement.id, from_read_seq: first.read_seq, to_read_seq: current.read_seq, limit: 2
    });
    assert.ok(boundedChanges.scanned_rows <= 3);
    assert.equal(boundedChanges.has_more, false);

    const rejectedEvents = await store.eventsForSubjects({
      engagement_id: engagement.id, from_read_seq: 0, to_read_seq: current.read_seq,
      subject_ids: [hidden.id, foreignClaim.id], include_candidates: true, limit: 4
    });
    assert.deepEqual(rejectedEvents.events, []);
    const boundedEvents = await store.eventsForSubjects({
      engagement_id: engagement.id, from_read_seq: 0, to_read_seq: first.read_seq,
      subject_ids: claims.map((record) => record.id), include_candidates: true, limit: 2
    });
    assert.equal(boundedEvents.events.length, 2);
    assert.equal(boundedEvents.has_more, true);
    assert.ok(boundedEvents.scanned_rows <= 3);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
