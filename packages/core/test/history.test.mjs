import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactContentStore, AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "taric-history-"));
  const store = new AuthorityStore();
  const root = join(directory, "content");
  const service = await createCoreService(store, root);
  const engagement_id = uuidv7();
  const session_id = "history-session";
  const host = createPrincipal("host", "history-host", engagement_id);
  const model = createPrincipal("model", "history-model", engagement_id, ["history_read"]);
  const otherModel = createPrincipal("model", "other-history-model", engagement_id, ["history_read"]);
  const foreignModel = createPrincipal("model", "foreign-history-model", uuidv7(), ["history_read"]);
  await service.dispatch("artifact.session.bind", host, {
    engagement_id,
    session_id,
    root,
    mode: "host-session",
  });
  return { directory, store, service, engagement_id, session_id, host, model, otherModel, foreignModel };
}

async function publishText(fixtureValue, text, history_content_class) {
  const bytes = Buffer.from(text, "utf8");
  const begun = await fixtureValue.service.dispatch("artifact.store.begin", fixtureValue.host, {
    engagement_id: fixtureValue.engagement_id,
    session_id: fixtureValue.session_id,
    payload_kind: "text",
    media_type: "text/plain",
    history_content_class,
    expected_bytes: bytes.length,
    expected_hash: digest(bytes),
  });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const appended = await fixtureValue.service.dispatch("artifact.store.append", fixtureValue.host, {
    engagement_id: fixtureValue.engagement_id,
    session_id: fixtureValue.session_id,
    upload_id: begun.data.upload_id,
    ordinal: 0,
    data: bytes.toString("base64"),
    encoding: "base64",
    chunk_hash: digest(bytes),
  });
  assert.equal(appended.ok, true, JSON.stringify(appended));
  const committed = await fixtureValue.service.dispatch("artifact.store.commit", fixtureValue.host, {
    engagement_id: fixtureValue.engagement_id,
    session_id: fixtureValue.session_id,
    upload_id: begun.data.upload_id,
    total_bytes: bytes.length,
    chunk_count: 1,
    content_hash: digest(bytes),
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  return committed.data;
}

test("execution history Artifacts are indexed, searchable, readable, and cursor-bound", async () => {
  const fixtureValue = await fixture();
  try {
    const first = await publishText(fixtureValue, "checkpoint alpha: target is reachable\n", "execution_history");
    await publishText(fixtureValue, "checkpoint beta: target is blocked\n", "execution_history");

    const hostSearch = await fixtureValue.service.dispatch("artifact.search", fixtureValue.host, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "checkpoint",
    });
    assert.equal(hostSearch.ok, false);
    assert.equal(hostSearch.error.code, "authorization_error");
    const page = await fixtureValue.service.dispatch("artifact.search", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "checkpoint",
      page_size: 1,
    });
    assert.equal(page.ok, true, JSON.stringify(page));
    assert.equal(page.data.complete, true);
    assert.equal(page.data.items.length, 1);
    assert.equal(page.data.items[0].content_ref, first.content_ref);
    assert.equal(page.data.items[0].byte_offset, 0);
    assert.equal(page.data.items[0].integrity_status, "verified");
    assert.ok(page.data.next_cursor, "a second indexed Artifact should produce a continuation cursor");

    const continuation = await fixtureValue.service.dispatch("artifact.search", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "checkpoint",
      page_size: 1,
      cursor: page.data.next_cursor,
    });
    assert.equal(continuation.ok, true, JSON.stringify(continuation));
    assert.equal(continuation.data.items.length, 1);
    assert.notEqual(continuation.data.items[0].content_ref, page.data.items[0].content_ref);

    const crossPrincipal = await fixtureValue.service.dispatch("artifact.search", fixtureValue.otherModel, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "checkpoint",
      page_size: 1,
      cursor: page.data.next_cursor,
    });
    assert.equal(crossPrincipal.ok, false);
    assert.equal(crossPrincipal.error.code, "invalid_cursor");

    const foreign = await fixtureValue.service.dispatch("artifact.search", fixtureValue.foreignModel, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "checkpoint",
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error.code, "authorization_error");

    const capped = await fixtureValue.service.dispatch("artifact.search", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "checkpoint",
      max_response_bytes: 1,
    });
    assert.equal(capped.ok, false);
    assert.equal(capped.error.code, "validation_error");

    const read = await fixtureValue.service.dispatch("artifact.history.read", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      content_ref: first.content_ref,
      length: 256,
    });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(Buffer.from(read.data.data, "base64").toString("utf8"), "checkpoint alpha: target is reachable\n");
    const rawRead = await fixtureValue.service.dispatch("artifact.content.read", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      content_ref: first.content_ref,
    });
    assert.equal(rawRead.ok, false);
    assert.equal(rawRead.error.code, "authorization_error");
  } finally {
    await fixtureValue.service.close();
    rmSync(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("history.query reports sidecar incompleteness and binds continuation cursors to the model", async () => {
  const fixtureValue = await fixture();
  try {
    const firstId = uuidv7();
    const secondId = uuidv7();
    await fixtureValue.store.sql.run(
      "INSERT INTO execution_catalog(execution_id,engagement_id,session_id,work_run_id,attempt_id,sequence,body) VALUES(?,?,?,?,?,?,?)",
      firstId, fixtureValue.engagement_id, fixtureValue.session_id, null, null, 1,
      JSON.stringify({ execution_id: firstId, kind: "checkpoint", sequence: 1 }),
    );
    await fixtureValue.store.sql.run(
      "INSERT INTO execution_catalog(execution_id,engagement_id,session_id,work_run_id,attempt_id,sequence,body) VALUES(?,?,?,?,?,?,?)",
      secondId, fixtureValue.engagement_id, fixtureValue.session_id, null, null, 2,
      JSON.stringify({ execution_id: secondId, kind: "result", sequence: 2 }),
    );
    const page = await fixtureValue.service.dispatch("history.query", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      page_size: 1,
    });
    assert.equal(page.ok, true, JSON.stringify(page));
    assert.equal(page.data.items.length, 1);
    assert.equal(page.data.items[0].execution_id, firstId);
    assert.equal(page.data.complete, false);
    assert.equal(page.data.incomplete, true);
    assert.ok(page.data.next_cursor);

    const crossPrincipal = await fixtureValue.service.dispatch("history.query", fixtureValue.otherModel, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      page_size: 1,
      cursor: page.data.next_cursor,
    });
    assert.equal(crossPrincipal.ok, false);
    assert.equal(crossPrincipal.error.code, "invalid_cursor");
  } finally {
    await fixtureValue.service.close();
    rmSync(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("history.query pins pages across later events and authority restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-history-pages-"));
  const db = join(directory, "authority.sqlite");
  const root = join(directory, "content");
  const engagement_id = uuidv7();
  const session_id = "paged-history-session";
  let store = new AuthorityStore(db);
  let service = await createCoreService(store, root);
  const host = createPrincipal("host", "paged-history-host", engagement_id);
  const model = createPrincipal("model", "paged-history-model", engagement_id, ["history_read"]);
  const insert = async (sequence, kind) => {
    const execution_id = uuidv7();
    await store.sql.run(
      "INSERT INTO execution_catalog(execution_id,engagement_id,session_id,work_run_id,attempt_id,sequence,body) VALUES(?,?,?,?,?,?,?)",
      execution_id, engagement_id, session_id, null, null, sequence,
      JSON.stringify({ execution_id, kind, sequence }),
    );
    return execution_id;
  };
  try {
    await service.dispatch("artifact.session.bind", host, { engagement_id, session_id, root, mode: "host-session" });
    const firstId = await insert(1, "checkpoint");
    const secondId = await insert(2, "result");
    const first = await service.dispatch("history.query", model, { engagement_id, session_id, page_size: 1 });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.data.items.map((item) => item.execution_id), [firstId]);
    assert.equal(first.data.read_seq, 2);
    assert.equal(first.data.index_watermark, 2);
    assert.equal(first.data.items[0].sidecar_path, undefined, "host filesystem paths must not cross the history contract");
    assert.equal(first.data.complete, false, "missing sidecars remain explicitly incomplete");
    assert.ok(first.data.next_cursor);

    const thirdId = await insert(3, "error");
    const second = await service.dispatch("history.query", model, {
      engagement_id, session_id, page_size: 1, cursor: first.data.next_cursor,
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.data.items.map((item) => item.execution_id), [secondId]);
    assert.equal(second.data.items.some((item) => item.execution_id === thirdId), false, "later events stay outside the pinned page");
    assert.equal(second.data.read_seq, 2);
    assert.equal(second.data.next_cursor, undefined);

    const changedPageSize = await service.dispatch("history.query", model, {
      engagement_id, session_id, page_size: 2, cursor: first.data.next_cursor,
    });
    assert.equal(changedPageSize.ok, false);
    assert.equal(changedPageSize.error.code, "invalid_cursor");
    const filtered = await service.dispatch("history.query", model, { engagement_id, session_id, kind: "result", page_size: 2 });
    assert.equal(filtered.ok, true, JSON.stringify(filtered));
    assert.deepEqual(filtered.data.items.map((item) => item.execution_id), [secondId]);

    await service.close();
    store = new AuthorityStore(db);
    service = await createCoreService(store, root);
    const resumed = await service.dispatch("history.query", model, {
      engagement_id, session_id, page_size: 1, cursor: first.data.next_cursor,
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.deepEqual(resumed.data.items.map((item) => item.execution_id), [secondId]);
    assert.equal(resumed.data.read_seq, 2);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("history reads reject opaque and unclassified Artifacts", async () => {
  const fixtureValue = await fixture();
  try {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const begun = await fixtureValue.service.dispatch("artifact.store.begin", fixtureValue.host, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      payload_kind: "binary",
      media_type: "application/octet-stream",
      expected_bytes: bytes.length,
      expected_hash: digest(bytes),
    });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    await fixtureValue.service.dispatch("artifact.store.append", fixtureValue.host, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      upload_id: begun.data.upload_id,
      ordinal: 0,
      data: bytes.toString("base64"),
      encoding: "base64",
      chunk_hash: digest(bytes),
    });
    const committed = await fixtureValue.service.dispatch("artifact.store.commit", fixtureValue.host, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      upload_id: begun.data.upload_id,
      total_bytes: bytes.length,
      chunk_count: 1,
      content_hash: digest(bytes),
    });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    const opaqueRead = await fixtureValue.service.dispatch("artifact.history.read", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      content_ref: committed.data.content_ref,
    });
    assert.equal(opaqueRead.ok, false);
    assert.equal(opaqueRead.error.code, "authorization_error");

    const unclassified = await publishText(fixtureValue, "ordinary host text\n");
    const search = await fixtureValue.service.dispatch("artifact.search", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "ordinary",
    });
    assert.equal(search.ok, true, JSON.stringify(search));
    assert.equal(search.data.items.some((item) => item.content_ref === unclassified.content_ref), false);
    const unclassifiedRead = await fixtureValue.service.dispatch("artifact.history.read", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      content_ref: unclassified.content_ref,
    });
    assert.equal(unclassifiedRead.ok, false);
    assert.equal(unclassifiedRead.error.code, "authorization_error");

    const invalidDesignation = await fixtureValue.service.dispatch("artifact.store.begin", fixtureValue.host, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      payload_kind: "binary",
      media_type: "application/octet-stream",
      history_content_class: "execution_history",
    });
    assert.equal(invalidDesignation.ok, false);
    assert.equal(invalidDesignation.error.code, "validation_error");
  } finally {
    await fixtureValue.service.close();
    rmSync(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("reconcile re-indexes a repaired execution-history Artifact", async () => {
  const fixtureValue = await fixture();
  try {
    const committed = await publishText(fixtureValue, "repairable history original\n", "execution_history");
    const row = await fixtureValue.store.artifactCatalogRow(fixtureValue.engagement_id, fixtureValue.session_id, committed.content_ref);
    const payloadPath = join(fixtureValue.directory, "content", row.relative_dir, "payload-000001.part");
    const original = readFileSync(payloadPath);
    writeFileSync(payloadPath, "tampered history\n");
    const restarted = new ArtifactContentStore(join(fixtureValue.directory, "content"), fixtureValue.store);
    await restarted.initialize();
    const failed = await restarted.reconcile({ engagement_id: fixtureValue.engagement_id, session_id: fixtureValue.session_id });
    assert.deepEqual(failed.integrity_failed, [committed.content_ref]);
    writeFileSync(payloadPath, original);
    const repaired = await restarted.reconcile({ engagement_id: fixtureValue.engagement_id, session_id: fixtureValue.session_id });
    assert.deepEqual(repaired.integrity_failed, []);
    const search = await fixtureValue.service.dispatch("artifact.search", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "repairable",
    });
    assert.equal(search.ok, true, JSON.stringify(search));
    assert.equal(search.data.items[0].content_ref, committed.content_ref);
  } finally {
    await fixtureValue.service.close();
    rmSync(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("history search reports a missing derived row until reconcile repairs it", async () => {
  const fixtureValue = await fixture();
  try {
    const committed = await publishText(fixtureValue, "crash recovery history\n", "execution_history");
    await fixtureValue.store.sql.run("DELETE FROM artifact_history_fts WHERE content_ref=?", committed.content_ref);
    await fixtureValue.store.sql.run("DELETE FROM artifact_history_index WHERE content_ref=?", committed.content_ref);
    const incomplete = await fixtureValue.service.dispatch("artifact.search", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "crash recovery",
    });
    assert.equal(incomplete.ok, true, JSON.stringify(incomplete));
    assert.equal(incomplete.data.complete, false);
    assert.equal(incomplete.data.incomplete, true);
    assert.deepEqual(incomplete.data.items, []);

    const restarted = new ArtifactContentStore(join(fixtureValue.directory, "content"), fixtureValue.store);
    await restarted.initialize();
    const repaired = await restarted.reconcile({ engagement_id: fixtureValue.engagement_id, session_id: fixtureValue.session_id });
    assert.equal(repaired.valid, true, JSON.stringify(repaired));
    const complete = await fixtureValue.service.dispatch("artifact.search", fixtureValue.model, {
      engagement_id: fixtureValue.engagement_id,
      session_id: fixtureValue.session_id,
      query: "crash recovery",
    });
    assert.equal(complete.ok, true, JSON.stringify(complete));
    assert.equal(complete.data.complete, true);
    assert.equal(complete.data.items[0].content_ref, committed.content_ref);
  } finally {
    await fixtureValue.service.close();
    rmSync(fixtureValue.directory, { recursive: true, force: true });
  }
});
