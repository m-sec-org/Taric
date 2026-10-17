import test from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, invalidateContextCache, rebaseDraft, resumeContextDelta, sealDraft } from "../dist/context.js";

function fakeAuthority(history, events = []) {
  const latest = new Map([...history].map(([id, versions]) => [id, versions.at(-1)?.record]));
  const seq = events.at(-1)?.commit_seq ?? Math.max(0, ...[...history.values()].flat().map((entry) => entry.seq));
  const at = (readSeq) => [...history.values()].flatMap((versions) => [...versions].reverse().find((entry) => entry.seq <= readSeq)?.record ?? []);
  const priority = (record, workItemId, deltaIds) => {
    const kind = String(record.kind ?? "");
    if (["engagement", "scope", "rule_of_engagement"].includes(kind)) return 0;
    if (workItemId && (record.id === workItemId || record.work_item_ref === workItemId)) return 1;
    if (kind === "checkpoint") return 2;
    if (record.status === "stale" || deltaIds.has(record.id) || ["conflict", "impact_event", "coverage_gap", "delta"].includes(kind)
      || (kind === "coverage" && ["not_tested", "queued", "in_progress", "tested_no_observation", "inconclusive", "blocked", "blocked_by_control"].includes(String(record.status)))) return 3;
    if (["work_item", "workitem", "observation", "evidence", "coverage", "control_observation", "access_decision_observation", "finding", "claim", "resource"].includes(kind)) return 4;
    return 5;
  };
  return {
    filename: ":memory:",
    authorityId: ":memory:",
    async snapshot(engagementId, options = {}) {
      const readSeq = options.asOf ?? seq;
      const records = [...history.values()].flatMap((versions) => [...versions].reverse().find((entry) => entry.seq <= readSeq)?.record ?? [])
        .filter((record) => record.engagement_id === engagementId && !["stale", "retracted", "superseded", "archived", "expired"].includes(String(record.status)) && record.trust_level !== "L0" && (options.includeCandidates || record.trust_level !== "L1"));
      return { read_seq: readSeq, committed_seq: seq, projected_seq: readSeq, records };
    },
    async contextRecordsPage(input) {
      const readSeq = input.as_of ?? seq;
      const readTime = input.read_time ?? new Date().toISOString();
      const deltaIds = new Set(input.delta_ids ?? []);
      const candidates = at(readSeq).filter((record) => {
        if (record.engagement_id !== input.engagement_id || (record.trust_level !== "L2" && !(input.include_candidates && record.trust_level === "L1"))) return false;
        const status = String(record.status ?? "active");
        if (status !== "stale" && ["retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(status)) return false;
        if (status !== "stale" && [record.expires_at, record.review_after].some((value) => typeof value === "string" && Date.parse(value) <= Date.parse(readTime))) return false;
        if (input.reviewer_mode && record.kind === "review") return false;
        if (input.kind && record.kind !== input.kind) return false;
        return Object.entries(input.filters ?? {}).every(([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value));
      }).sort((a, b) => {
        const pa = priority(a, input.work_item_id, deltaIds);
        const pb = priority(b, input.work_item_id, deltaIds);
        if (pa !== pb) return pa - pb;
        if (pa === 2 && a.kind === "checkpoint" && b.kind === "checkpoint") {
          const byTime = String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? ""));
          if (byTime) return byTime;
        }
        return a.id.localeCompare(b.id);
      });
      const tupleCompare = (record) => {
        const p = priority(record, input.work_item_id, deltaIds);
        const afterPriority = input.after_priority ?? -1;
        if (p !== afterPriority) return p - afterPriority;
        if (p === 2 && record.kind === "checkpoint") {
          const byTime = String(input.after_time ?? "").localeCompare(String(record.updated_at ?? record.created_at ?? ""));
          if (byTime) return byTime;
        }
        return record.id.localeCompare(input.after_id ?? "");
      };
      const after = candidates.filter((record) => tupleCompare(record) > 0);
      const pageSize = input.page_size ?? 256;
      const rows = after.slice(0, pageSize + 1);
      const hasMore = rows.length > pageSize;
      const records = rows.slice(0, pageSize);
      const last = records.at(-1);
      return {
        records, next_after_id: hasMore ? last?.id : undefined,
        next_after_priority: hasMore && last ? priority(last, input.work_item_id, deltaIds) : undefined,
        next_after_time: hasMore && last?.kind === "checkpoint" ? String(last.updated_at ?? last.created_at ?? "") : undefined,
        read_seq: readSeq, committed_seq: seq, read_time: readTime, has_more: hasMore,
        scanned_rows: rows.length, returned_rows: records.length
      };
    },
    async changedRecordSubjects(input) {
      const rows = [...history].flatMap(([id, versions]) => versions
        .filter((entry) => entry.seq > input.from_read_seq && entry.seq <= input.to_read_seq && entry.record.engagement_id === input.engagement_id)
        .map((entry) => ({ id, seq: entry.seq })))
        .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
        .slice(0, input.limit + 1);
      return { ids: [...new Set(rows.slice(0, input.limit).map((row) => row.id))], has_more: rows.length > input.limit, scanned_rows: rows.length };
    },
    async eventsForSubjects(input) {
      const wanted = new Set(input.subject_ids);
      const rows = events.filter((event) => event.commit_seq > input.from_read_seq && event.commit_seq <= input.to_read_seq && event.subject_id && wanted.has(event.subject_id));
      const selected = rows.slice(0, input.limit);
      return { events: selected, has_more: rows.length > input.limit, scanned_rows: Math.min(rows.length, input.limit + 1) };
    },
    async events() { return events; },
    async get(id) { return latest.get(id); },
    async getAt(id, readSeq) { return [...((await history.get(id)) ?? [])].reverse().find((entry) => entry.seq <= readSeq)?.record; }
  };
}

test("advanced context uses an opaque pinned cursor and a source location manifest", async () => {
  const engagement_id = "engagement-a";
  const records = Array.from({ length: 5 }, (_, index) => ({
    id: `record-${index}`, engagement_id, kind: "evidence", trust_level: "L2", version: 1,
    statement: `evidence ${index} `.repeat(30), source_hash: `sha256:${index}`, revision_id: index + 1,
    byte_range: { start: index * 10, end: index * 10 + 9 }, permission_scope: "read:engagement"
  }));
  const history = new Map(records.map((record, index) => [record.id, [{ seq: index + 1, record }]]));
  const store = fakeAuthority(history);
  const pack = (await buildContextPack(store, engagement_id, 800, { principalId: "worker-a", filters: { kind: "evidence" } }));
  assert.ok(pack.cursor);
  assert.match(pack.cursor, /^v2\./);
  assert.ok(!pack.cursor.includes(engagement_id));
  const source = pack.manifest[0];
  assert.equal(source.source_hash, "sha256:0");
  assert.equal(source.revision, 1);
  assert.deepEqual(source.slice.byte_range, { start: 0, end: 9 });
  assert.equal(source.permission, `worker-a@${engagement_id}`);
  assert.equal(source.source_permission, "read:engagement");
  assert.equal(pack.token_estimator_version, "characters/json-length/1");
  const continued = (await buildContextPack(store, engagement_id, 800, { principalId: "worker-a", filters: { kind: "evidence" }, cursor: pack.cursor }));
  assert.equal(continued.read_seq, pack.read_seq);
  assert.equal(continued.context_snapshot_id, pack.context_snapshot_id);
  (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 800, { principalId: "worker-b", filters: { kind: "evidence" }, cursor: pack.cursor })), /binding mismatch/));
  const parts = pack.cursor.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 800, { principalId: "worker-a", filters: { kind: "evidence" }, cursor: parts.join(".") })), /invalid context continuation cursor/));
});

test("resume delta scopes changes to an engagement and blocks changed checkpoint premises", async () => {
  const engagement_id = "engagement-a";
  const resource0 = { id: "resource-a", engagement_id, kind: "resource", trust_level: "L2", version: 1, name: "old" };
  const resource1 = { ...resource0, version: 2, name: "new" };
  const workItem = { id: "work-a", engagement_id, kind: "work_item", trust_level: "L2", version: 1, goal: "verify", acceptance: ["evidence"] };
  const history = new Map([
    [resource0.id, [{ seq: 1, record: resource0 }, { seq: 3, record: resource1 }]],
    [workItem.id, [{ seq: 2, record: workItem }]],
    ["foreign", [{ seq: 4, record: { id: "foreign", engagement_id: "engagement-b", kind: "note", trust_level: "L2", version: 1 } }]],
    ["private", [{ seq: 5, record: { id: "private", engagement_id, kind: "observation", trust_level: "L0", version: 1 } }]]
  ]);
  const events = [
    { commit_seq: 1, event_id: "e1", event_type: "record.commit", subject_id: resource0.id, payload: { engagement_id }, hash: "h1" },
    { commit_seq: 2, event_id: "e2", event_type: "record.commit", subject_id: workItem.id, payload: { engagement_id }, hash: "h2" },
    { commit_seq: 3, event_id: "e3", event_type: "record.commit", subject_id: resource0.id, payload: { engagement_id }, hash: "h3" },
    { commit_seq: 4, event_id: "e4", event_type: "record.commit", subject_id: "foreign", payload: { engagement_id: "engagement-b" }, hash: "h4" },
    { commit_seq: 5, event_id: "e5", event_type: "record.commit", subject_id: "private", payload: { engagement_id }, hash: "h5" }
  ];
  const store = fakeAuthority(history, events);
  const delta = (await resumeContextDelta(store, engagement_id, 2, {
    workItemId: workItem.id,
    checkpoint: { engagement_id, work_item_ref: workItem.id, work_item_version: 1, generation: 2, attempt_ref: "attempt-2", evidence_refs: [resource0.id], host_decision_refs: ["foreign"], observation_refs: ["private"], external_action_state: "unknown" },
    pendingActions: [{ action_id: "action-a", status: "unknown" }]
  }));
  assert.equal(delta.from_read_seq, 2);
  assert.equal(delta.to_read_seq, 5);
  assert.deepEqual(delta.updated.map(({ id }) => id), [resource0.id]);
  assert.deepEqual(delta.dependency_changes, [resource0.id]);
  assert.deepEqual(delta.pending_actions, ["action-a"]);
  assert.ok(delta.reasons.includes("checkpoint_premise_changed"));
  assert.ok(delta.reasons.includes("external_action_unresolved"));
  assert.equal(delta.blocked, true);
  assert.ok(!delta.records.some(({ engagement_id: id }) => id === "engagement-b"));
  assert.deepEqual(delta.events.map(({ subject_id }) => subject_id), [resource0.id]);
  assert.ok(!JSON.stringify(delta.events).includes("foreign"));
  assert.ok(!JSON.stringify(delta.events).includes("private"));
  (await assert.rejects(async () => (await resumeContextDelta(store, engagement_id, 2, { checkpoint: { engagement_id: "engagement-b" } })), /binding mismatch/));
});

test("current stale dependencies remain visible and sort ahead of direct evidence", async () => {
  const engagement_id = "engagement-a";
  const stale = { id: "stale-evidence", engagement_id, kind: "evidence", trust_level: "L2", version: 2, status: "stale", stale_reason: "resource revision changed" };
  const direct = { id: "direct-evidence", engagement_id, kind: "evidence", trust_level: "L2", version: 1, statement: "current" };
  const store = fakeAuthority(new Map([[stale.id, [{ seq: 1, record: stale }]], [direct.id, [{ seq: 2, record: direct }]]]), [
    { commit_seq: 1, event_id: "stale-event", event_type: "record.stale", subject_id: stale.id, payload: {}, hash: "h1" },
    { commit_seq: 2, event_id: "direct-event", event_type: "record.commit", subject_id: direct.id, payload: {}, hash: "h2" }
  ]);
  const pack = (await buildContextPack(store, engagement_id, 2000));
  assert.equal(pack.items[0].id, stale.id);
  assert.equal(pack.items[0].status, "stale");
  assert.ok(pack.items.some((record) => record.id === direct.id));
});

test("context cache invalidates on dependencies and stale drafts require explicit rebase", () => {
  const pack = { context_snapshot_id: "ctx", read_seq: 3, items: [], manifest: [], sources: [] };
  const cache = { key: "k", engagement_id: "engagement-a", read_seq: 3, source_ids: ["resource-a"], pack };
  assert.equal(invalidateContextCache(cache, ["unrelated"], 3), cache);
  assert.equal(invalidateContextCache(cache, ["resource-a"], 3).invalidation_reason, "source_changed");
  assert.equal(invalidateContextCache(cache, [], 4).invalidation_reason, "authority_sequence_changed");

  const draft = sealDraft({ draft_id: "draft-a", engagement_id: "engagement-a", attempt_ref: "attempt-1", generation: 1, content: { statement: "private" } });
  assert.equal(draft.status, "sealed");
  assert.equal(draft.original_attempt_ref, "attempt-1");
  assert.throws(() => rebaseDraft(draft, { engagement_id: "engagement-b", attempt_ref: "attempt-2", generation: 2 }), /engagement binding mismatch/);
  assert.throws(() => rebaseDraft(draft, { engagement_id: "engagement-a", attempt_ref: "attempt-1", generation: 2 }), /new Attempt/);
  const rebased = rebaseDraft(draft, { engagement_id: "engagement-a", attempt_ref: "attempt-2", generation: 2, read_seq: 9 });
  assert.equal(rebased.status, "rebased");
  assert.equal(rebased.original_generation, 1);
  assert.equal(rebased.rebase.read_seq, 9);
  assert.throws(() => rebaseDraft({ ...draft, content: { statement: "tampered" } }, { engagement_id: "engagement-a", attempt_ref: "attempt-2", generation: 2 }), /integrity check/);
});

test("re-fetched continuation keeps checkpoint time ordering and delivers every id once", async () => {
  const engagement_id = "engagement-a";
  const records = [
    { id: "checkpoint-a", engagement_id, kind: "checkpoint", trust_level: "L2", created_at: "2026-01-01T00:00:00.000Z", goal: "old checkpoint ".repeat(100) },
    { id: "checkpoint-z", engagement_id, kind: "checkpoint", trust_level: "L2", created_at: "2026-01-02T00:00:00.000Z", goal: "prior checkpoint ".repeat(100) },
    { id: "checkpoint-new", engagement_id, kind: "checkpoint", trust_level: "L2", created_at: "2026-01-03T00:00:00.000Z", goal: "latest checkpoint ".repeat(100) },
    { id: "note-a", engagement_id, kind: "note", trust_level: "L2", statement: "background ".repeat(100) }
  ];
  const store = fakeAuthority(new Map(records.map((record, index) => [record.id, [{ seq: index + 1, record }]])));
  const first = (await buildContextPack(store, engagement_id, 256));
  const seen = first.items.map((record) => record.id);
  let cursor = first.cursor;
  while (cursor) {
    const page = (await buildContextPack(store, engagement_id, 256, { cursor }));
    seen.push(...page.items.map((record) => record.id));
    cursor = page.cursor;
    assert.ok(seen.length <= records.length);
  }
  assert.deepEqual(seen, ["checkpoint-new", "checkpoint-z", "checkpoint-a", "note-a"]);
});

test("bounded context pages expose the scan bound and reject the legacy cursor format", async () => {
  const engagement_id = "engagement-a";
  const records = Array.from({ length: 8 }, (_, index) => ({
    id: `claim-${index}`, engagement_id, kind: "claim", trust_level: "L2", version: 1,
    statement: `claim ${index}`
  }));
  const history = new Map(records.map((record, index) => [record.id, [{ seq: index + 1, record }]]));
  const store = fakeAuthority(history);
  await assert.rejects(() => buildContextPack(store, engagement_id, 512, { scanBudget: 1 }), /scan budget/);
  const first = await buildContextPack(store, engagement_id, 512, { scanBudget: 3 });
  assert.ok(first.read_stats.scanned_rows <= 3);
  assert.equal(first.read_stats.scan_budget, 3);
  const seen = [...first.items.map((record) => record.id)];
  let cursor = first.cursor;
  while (cursor) {
    const page = await buildContextPack(store, engagement_id, 512, { cursor });
    assert.ok(page.read_stats.scanned_rows <= 3);
    seen.push(...page.items.map((record) => record.id));
    cursor = page.cursor;
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(seen.toSorted(), records.map((record) => record.id).toSorted());
  assert.ok(first.cursor);
  const legacy = `v1${first.cursor.slice(2)}`;
  await assert.rejects(() => buildContextPack(store, engagement_id, 512, { cursor: legacy }), /invalid context continuation cursor/);
});

test("resume delta returns an explicit bounded error for high churn", async () => {
  const engagement_id = "engagement-a";
  const history = new Map();
  const events = [];
  for (let index = 0; index < 4; index++) {
    const id = `changed-${index}`;
    const record = { id, engagement_id, kind: "claim", trust_level: "L2", version: 1, statement: `claim-${index}` };
    history.set(id, [{ seq: index + 1, record }]);
    events.push({ commit_seq: index + 1, event_id: `e-${index}`, event_type: "record.commit", subject_id: id, payload: { engagement_id }, hash: `h-${index}` });
  }
  const store = fakeAuthority(history, events);
  await assert.rejects(
    () => resumeContextDelta(store, engagement_id, 0, { readSeq: 4, scanBudget: 2 }),
    (cause) => cause.code === "minimum_budget_required" && /authority rows/.test(cause.message)
  );
});
