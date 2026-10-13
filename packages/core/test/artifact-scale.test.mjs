import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ARTIFACT_CHUNK_BYTES, AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("synthetic 100 GiB catalog stays metadata-paged and indexed across UTC partitions", () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-scale-"));
  const dbPath = join(dir, "authority.sqlite");
  const contentRoot = join(dir, "content");
  const engagement_id = uuidv7();
  const session_id = "scale-session";
  const count = (100 * 1024 ** 3) / ARTIFACT_CHUNK_BYTES;
  const database = new AuthorityStore(dbPath);
  database.close();

  const fixture = new DatabaseSync(dbPath);
  const insert = fixture.prepare("INSERT INTO artifact_catalog(content_ref,engagement_id,session_id,artifact_id,version,category,stored_at,work_run_id,attempt_id,body) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const partitionDays = new Set();
  try {
    fixture.exec("BEGIN");
    for (let i = 0; i < count; i++) {
      const artifact_id = `artifact-${String(i).padStart(4, "0")}`;
      const day = (i % 9) + 1;
      const stored_at = `2025-01-${String(day).padStart(2, "0")}T12:00:00.000Z`;
      const relative_dir = join("artifacts", "2025", "01", String(day).padStart(2, "0"), artifact_id.slice(0, 2), artifact_id, "v000001");
      const row = {
        content_ref: `${artifact_id}@v1`, artifact_id, version: 1, engagement_id, session_id,
        payload_kind: "binary", media_type: "application/octet-stream", storage_mode: "taric_stored",
        category: i % 2 ? "capture" : "scanner", byte_length: ARTIFACT_CHUNK_BYTES, chunk_count: 1,
        content_hash: "sha256:" + "0".repeat(64), content_status: "available", integrity_status: "verified",
        stored_at, relative_dir, manifest_path: join(relative_dir, "content.manifest.json"),
      };
      insert.run(row.content_ref, engagement_id, session_id, artifact_id, 1, row.category, stored_at, null, null, JSON.stringify(row));
      partitionDays.add(stored_at.slice(0, 10));
    }
    fixture.exec("COMMIT");

    assert.equal(count, 1600);
    assert.equal(count * ARTIFACT_CHUNK_BYTES, 100 * 1024 ** 3);
    assert.ok(partitionDays.size > 7, "fixture spans more than seven UTC dates");
    for (const row of fixture.prepare("SELECT stored_at,body FROM artifact_catalog LIMIT 9").all()) {
      const artifact = JSON.parse(row.body);
      const utcDay = new Date(row.stored_at).toISOString().slice(0, 10).split("-");
      assert.deepEqual(artifact.relative_dir.split(sep).slice(1, 4), utcDay);
    }

    const plans = (sql, ...args) => fixture.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail).join(" ");
    assert.match(plans("SELECT content_ref,body FROM artifact_catalog WHERE engagement_id=? AND session_id=? ORDER BY stored_at,content_ref", engagement_id, session_id), /artifact_catalog_session_time/);
    assert.match(plans("SELECT content_ref,body FROM artifact_catalog WHERE engagement_id=? AND session_id=? AND category=? ORDER BY stored_at,content_ref", engagement_id, session_id, "capture"), /artifact_catalog_category_time/);
    assert.match(plans("SELECT content_ref,body FROM artifact_catalog WHERE engagement_id=? AND session_id=? AND artifact_id=? ORDER BY version", engagement_id, session_id, "artifact-0001"), /artifact_catalog_reference_version/);
    assert.match(plans("SELECT content_ref,body FROM artifact_catalog WHERE engagement_id=? AND session_id=? AND work_run_id=? AND attempt_id=? ORDER BY stored_at", engagement_id, session_id, "run-1", "attempt-1"), /artifact_catalog_work_run/);
    assert.match(plans("SELECT relative_path FROM artifact_chunks WHERE content_ref=? AND ordinal=?", "artifact-0001@v1", 0), /SEARCH artifact_chunks/);
    assert.doesNotMatch(plans("SELECT content_ref,body FROM artifact_catalog WHERE engagement_id=? AND session_id=? ORDER BY stored_at,content_ref", engagement_id, session_id), /SCAN artifact_catalog/);
    const tableNames = fixture.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.equal(tableNames.some((name) => /payload|manifest/i.test(name)), false, "raw payloads and manifests are outside the authority database");
  } finally {
    fixture.close();
  }

  let store;
  try {
    store = new AuthorityStore(dbPath);
    const service = createCoreService(store, contentRoot);
    const host = createPrincipal("host", "scale-host", engagement_id);
    service.dispatch("artifact.session.bind", host, { engagement_id, session_id, root: join(contentRoot, session_id) });

    let cursor;
    let seen = 0;
    let totalBytes = 0;
    const cursorSet = new Set();
    do {
      const response = service.dispatch("artifact.content.list", host, { engagement_id, session_id, page_size: 37, cursor });
      assert.equal(response.ok, true);
      assert.ok(response.data.items.length <= 37);
      assert.ok(Buffer.byteLength(JSON.stringify(response.data)) < 256 * 1024);
      for (const item of response.data.items) {
        assert.equal("data" in item, false);
        seen++;
        totalBytes += item.byte_length;
      }
      cursor = response.data.next_cursor;
      if (cursor) {
        assert.equal(cursorSet.has(cursor), false, "cursor advances without looping");
        cursorSet.add(cursor);
      }
    } while (cursor);

    assert.equal(seen, count);
    assert.equal(totalBytes, 100 * 1024 ** 3);
    assert.equal(cursorSet.size, Math.ceil(count / 37) - 1);
    assert.deepEqual(readdirSync(join(contentRoot, session_id)).sort(), ["manifest.json"], "metadata paging does not open payload or per-Artifact manifest files");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session output resumes within the 64 MiB response bound", () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-output-scale-"));
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const session_id = "output-session";
  const host = createPrincipal("host", "output-host", engagement_id);
  const reader = createPrincipal("host", "output-reader", engagement_id, ["content_read"]);
  const service = createCoreService(store, join(dir, "content"));
  const bytes = Buffer.from("bounded resumable output");
  const digest = sha256(bytes);
  try {
    service.dispatch("artifact.session.bind", host, { engagement_id, session_id, root: join(dir, "content", session_id) });
    const begun = service.dispatch("artifact.store.begin", host, { engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", expected_bytes: bytes.length, expected_hash: digest });
    assert.equal(begun.ok, true);
    service.dispatch("artifact.store.append", host, { engagement_id, session_id, upload_id: begun.data.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: digest });
    const committed = service.dispatch("artifact.store.commit", host, { engagement_id, session_id, upload_id: begun.data.upload_id, total_bytes: bytes.length, chunk_count: 1, content_hash: digest });
    assert.equal(committed.ok, true);

    const output = service.dispatch("artifact.session.output", reader, { engagement_id, session_id, page_size: 1, include_content: true, max_response_bytes: 1024 });
    assert.equal(output.ok, true);
    assert.equal(output.data.content.content_ref, committed.data.content_ref);
    assert.deepEqual(Buffer.from(output.data.content.data, "base64"), bytes);
    assert.equal(output.data.content.max_response_bytes, 1024);
    assert.ok(output.data.max_response_bytes <= ARTIFACT_CHUNK_BYTES);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
