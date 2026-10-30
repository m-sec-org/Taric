import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuthorityStore, createCoreService, createPrincipal, coverageCloseGate, uuidv7 } from "../dist/index.js";

const cell = (engagement_id, resource_ref, overrides = {}) => ({
  id: uuidv7(), engagement_id, kind: "coverage", resource_ref, test_category: "access-control",
  conditions: [], status: "not_tested", evidence_refs: [], limitations: [], ...overrides,
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

async function seededEngagement() {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource_ref = uuidv7();
  (await store.commit({ id: resource_ref, engagement_id, kind: "resource", asset_type: "service", identity: "cov.internal", revision: 1 }, "L2"));
  return { store, service, engagement_id, resource_ref };
}

test("coverage.gate matches the library close gate field-for-field", async () => {
  const { store, service, engagement_id, resource_ref } = await seededEngagement();
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    // 无内容时的干净闸门
    const empty = await service.dispatch("coverage.gate", host, { engagement_id });
    assert.equal(empty.ok, true, JSON.stringify(empty));
    const libraryEmpty = await coverageCloseGate(store, engagement_id);
    assert.deepEqual(empty.data, libraryEmpty);
    assert.equal(empty.data.read_seq, (await store.maintenanceRead((watermarks) => watermarks.read_seq)));

    const untestedCell = cell(engagement_id, resource_ref);
    (await store.commit(untestedCell, "L2")); // not_tested → untested gap
    (await store.commit(cell(engagement_id, resource_ref, { status: "positive", evidence_refs: [] }), "L2")); // unverified_positive gap
    (await store.commit(cell(engagement_id, resource_ref, { status: "not_applicable" }), "L2")); // unjustified gap
    // 未完成的影响传播：pending_impact gap 只进库函数/闸门的合并视图
    (await store.commit({ id: uuidv7(), engagement_id, kind: "impact_event", source_ref: resource_ref, changed_dependency_ref: resource_ref, affected_refs: [untestedCell.id], criticality: "high", disposition: "requires_revalidation", reason_code: "resource_changed", continuation: "pending:1", pending_watermark: 1 }, "L2"));

    const dispatched = await service.dispatch("coverage.gate", host, { engagement_id });
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    const library = await coverageCloseGate(store, engagement_id);
    assert.equal(dispatched.data.can_close, false);
    assert.deepEqual(dispatched.data, library);
    assert.equal(dispatched.data.read_seq, await store.maintenanceRead((watermarks) => watermarks.read_seq));
    const kinds = dispatched.data.gaps.map((gap) => gap.kind).sort();
    for (const expected of ["untested", "unverified_positive", "unjustified_not_applicable", "pending_impact"]) assert.ok(kinds.includes(expected), `missing gap kind ${expected}: ${kinds}`);
    assert.equal(dispatched.data.visibility.pending_impact_count, 1);
    assert.equal(dispatched.data.visibility.complete, false);
  } finally { await service.close(); }
});

test("coverage.gate keeps its decision, visibility, and watermark on one snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-coverage-snapshot-"));
  const database = join(directory, "authority.sqlite");
  const store = new AuthorityStore(database);
  const concurrentWriter = new DatabaseSync(database);
  concurrentWriter.exec("PRAGMA busy_timeout=5000");
  const service = await createCoreService(store);
  const engagement_id = uuidv7();
  const resource_ref = uuidv7();
  const host = createPrincipal("host", "host-a", engagement_id);
  let reachedFirstRead;
  let releaseFirstRead;
  const firstReadReached = new Promise((resolve) => { reachedFirstRead = resolve; });
  const continueGate = new Promise((resolve) => { releaseFirstRead = resolve; });
  const originalList = store.list.bind(store);
  let pauseOnce = true;
  store.list = async (...args) => {
    const records = await originalList(...args);
    if (pauseOnce) {
      pauseOnce = false;
      reachedFirstRead();
      await continueGate;
    }
    return records;
  };
  try {
    await store.ready;
    await store.commit({ id: resource_ref, engagement_id, kind: "resource", asset_type: "service", identity: "snapshot.internal", revision: 1 }, "L2");
    const gatePromise = service.dispatch("coverage.gate", host, { engagement_id });
    const firstReadOrResponse = await Promise.race([
      firstReadReached.then(() => ({ kind: "read" })),
      gatePromise.then((response) => ({ kind: "response", response })),
    ]);
    assert.equal(firstReadOrResponse.kind, "read", JSON.stringify(firstReadOrResponse));
    const concurrentCell = cell(engagement_id, resource_ref, { status: "not_tested" });
    const now = new Date().toISOString();
    concurrentWriter.exec("BEGIN IMMEDIATE");
    try {
      concurrentWriter.prepare("INSERT INTO events(event_id,event_type,subject_id,payload,prev_hash,hash,created_at) VALUES(?,?,?,?,?,?,?)").run(uuidv7(), "test.concurrent", concurrentCell.id, "{}", null, "concurrent-test-hash", now);
      concurrentWriter.prepare("INSERT INTO records(id,engagement_id,kind,trust_level,version,display_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(concurrentCell.id, engagement_id, "coverage", "L2", 1, null, JSON.stringify(concurrentCell), now, now);
      concurrentWriter.exec("COMMIT");
    } catch (error) {
      concurrentWriter.exec("ROLLBACK");
      throw error;
    }
    const writerReadSeq = Number(concurrentWriter.prepare("SELECT COALESCE(MAX(commit_seq),0) AS seq FROM events").get().seq);
    releaseFirstRead();
    const response = await gatePromise;
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.ok(response.data.read_seq < writerReadSeq);
    assert.equal(response.data.gaps.some((gap) => gap.cell_ids.includes(concurrentCell.id)), false);
    assert.equal(response.data.visibility.complete, true);
  } finally {
    releaseFirstRead();
    store.list = originalList;
    await service.close();
    concurrentWriter.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coverage.gate is host/operator only; coverage.query withholds candidates from models", async () => {
  const { store, service, engagement_id, resource_ref } = await seededEngagement();
  const host = createPrincipal("host", "host-a", engagement_id);
  const model = createPrincipal("model", "model-a", engagement_id);
  const operator = createPrincipal("operator", "op-a");
  try {
    (await store.commit(cell(engagement_id, resource_ref, { status: "positive", evidence_refs: [], tested_at: "2026-10-23T00:00:00.000Z" }), "L2"));
    // L1 候选 cell：host/operator 显式请求可见，model 不可见
    (await store.commit(cell(engagement_id, resource_ref, { status: "queued" }), "L1"));

    const modelGate = await service.dispatch("coverage.gate", model, { engagement_id });
    assert.equal(modelGate.ok, false);
    assert.equal(modelGate.error.code, "authorization_error");
    const operatorGate = await service.dispatch("coverage.gate", operator, { engagement_id });
    assert.equal(operatorGate.ok, true, JSON.stringify(operatorGate));

    const modelView = await service.dispatch("coverage.query", model, { engagement_id, include_candidates: true });
    assert.equal(modelView.ok, true, JSON.stringify(modelView));
    assert.equal(modelView.data.cells.length, 1);
    assert.equal(modelView.data.cells[0].trust_level === undefined || modelView.data.cells[0].status !== "queued", true);

    const hostPlain = await service.dispatch("coverage.query", host, { engagement_id });
    assert.equal(hostPlain.data.cells.length, 1);
    const hostWithCandidates = await service.dispatch("coverage.query", host, { engagement_id, include_candidates: true });
    assert.equal(hostWithCandidates.data.cells.length, 2);
  } finally { await service.close(); }
});

test("coverage.query filters, paginates, and isolates engagements", async () => {
  const { store, service, engagement_id, resource_ref } = await seededEngagement();
  const other = await seededEngagement();
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    const noiseResource = uuidv7();
    (await store.commit({ id: noiseResource, engagement_id, kind: "resource", asset_type: "service", identity: "noise.internal", revision: 1 }, "L2"));
    const matching = Array.from({ length: 5 }, (_, index) => cell(engagement_id, resource_ref, { status: "in_progress", test_category: index % 2 ? "authz" : "access-control" }));
    const noise = Array.from({ length: 3 }, () => cell(engagement_id, noiseResource));
    for (const item of [...matching, ...noise]) (await store.commit(item, "L2"));

    const byResource = await service.dispatch("coverage.query", host, { engagement_id, resource_ref });
    assert.equal(byResource.data.cells.length, 5);
    const byCategory = await service.dispatch("coverage.query", host, { engagement_id, resource_ref, test_category: "authz" });
    assert.equal(byCategory.data.cells.length, 2);
    const byStatus = await service.dispatch("coverage.query", host, { engagement_id, resource_ref, status: "in_progress" });
    assert.equal(byStatus.data.cells.length, 5);

    const seen = [];
    let cursor;
    let pages = 0;
    let read_seq;
    for (;;) {
      const page = await service.dispatch("coverage.query", host, { engagement_id, resource_ref, page_size: 2, ...(cursor ? { cursor } : {}) });
      assert.equal(page.ok, true, JSON.stringify(page));
      read_seq ??= page.data.read_seq;
      assert.equal(page.data.read_seq, read_seq, "all pages in the query walk must retain one read watermark");
      seen.push(...page.data.cells.map((item) => item.id));
      pages += 1;
      if (!page.data.has_more) break;
      cursor = page.data.next_cursor;
      assert.ok(pages < 10, "pagination did not terminate");
    }
    assert.equal(pages, 3);
    assert.deepEqual(seen.sort(), matching.map((item) => item.id).sort());

    const badCursor = await service.dispatch("coverage.query", host, { engagement_id, cursor: "v1.bad.sig" });
    assert.equal(badCursor.ok, false);
    assert.equal(badCursor.error.code, "invalid_cursor");
    const cross = await service.dispatch("coverage.query", host, { engagement_id: other.engagement_id });
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, "authorization_error");
    const unsupported = await service.dispatch("coverage.query", host, { engagement_id, status: "unknown-status" });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error.code, "validation_error");
  } finally { await service.close(); await other.service.close(); }
});

test("coverage.query dense matches crossing the scan budget are not skipped", async () => {
  const { store, service, engagement_id, resource_ref } = await seededEngagement();
  const host = createPrincipal("host", "host-a", engagement_id);
  const expected = [];
  try {
    const records = Array.from({ length: 520 }, () => cell(engagement_id, resource_ref, { status: "in_progress", test_category: "dense" }));
    expected.push(...records.map((item) => item.id));
    await seedRows(store, records);
    const seen = [];
    let cursor;
    let firstPage;
    for (;;) {
      const page = await service.dispatch("coverage.query", host, { engagement_id, resource_ref, test_category: "dense", page_size: 200, ...(cursor ? { cursor } : {}) });
      assert.equal(page.ok, true, JSON.stringify(page));
      firstPage ??= page.data;
      seen.push(...page.data.cells.map((item) => item.id));
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

test("coverage.query empty scan windows advance until the source is exhausted", async () => {
  const { store, service, engagement_id, resource_ref } = await seededEngagement();
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    await seedRows(store, Array.from({ length: 520 }, () => cell(engagement_id, resource_ref, { status: "not_tested", test_category: "noise" })));
    const first = await service.dispatch("coverage.query", host, { engagement_id, resource_ref, test_category: "missing", page_size: 50 });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.data.cells, []);
    assert.equal(first.data.has_more, true);
    assert.ok(first.data.next_cursor);
    const second = await service.dispatch("coverage.query", host, { engagement_id, resource_ref, test_category: "missing", page_size: 50, cursor: first.data.next_cursor });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.data.cells, []);
    assert.equal(second.data.has_more, false);
    assert.equal(second.data.next_cursor, undefined);
  } finally { await service.close(); }
});

test("coverage.query sparse matches beyond the scan window are neither skipped nor repeated", async () => {
  const { store, service, engagement_id, resource_ref } = await seededEngagement();
  const host = createPrincipal("host", "host-a", engagement_id);
  try {
    const records = Array.from({ length: 520 }, (_, index) => cell(engagement_id, resource_ref, { status: "in_progress", test_category: `sparse-${index}` }));
    records.sort((left, right) => left.id.localeCompare(right.id));
    records[10].test_category = "wanted";
    records[510].test_category = "wanted";
    const expected = [records[10].id, records[510].id].sort();
    await seedRows(store, records);

    const seen = [];
    let cursor;
    let firstPage;
    for (;;) {
      const page = await service.dispatch("coverage.query", host, { engagement_id, resource_ref, test_category: "wanted", page_size: 50, ...(cursor ? { cursor } : {}) });
      assert.equal(page.ok, true, JSON.stringify(page));
      firstPage ??= page.data;
      seen.push(...page.data.cells.map((item) => item.id));
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
