import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactContentStore, AuthorityStore, PostgresAuthorityStore, uuidv7 } from "../dist/index.js";

const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
const requestHash = (value) => hash(Buffer.from(JSON.stringify(canonical(value))));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function wrapAuthority(authority, overrides) {
  return new Proxy(authority, {
    get(target, method) {
      if (method in overrides) return overrides[method];
      const value = Reflect.get(target, method, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("Artifact construction defers asynchronous authority hydration until initialize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-initialize-"));
  const authority = new AuthorityStore(join(dir, "authority.sqlite"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const delayed = wrapAuthority(authority, {
    artifactSessions: async (...args) => { reads++; await gate; return authority.artifactSessions(...args); },
  });
  try {
    const artifacts = new ArtifactContentStore(join(dir, "content"), delayed);
    assert.equal(reads, 0);
    let settled = false;
    const initialized = artifacts.initialize();
    initialized.then(() => { settled = true; }, () => {});
    assert.equal(artifacts.initialize(), initialized);
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(reads, 1);
    release();
    await initialized;
    assert.equal(settled, true);
  } finally { release(); await authority.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Artifact consumers refresh bindings, uploads, idempotency and catalog state from authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-consumers-"));
  const path = join(dir, "authority.sqlite");
  const firstAuthority = new AuthorityStore(path);
  const secondAuthority = new AuthorityStore(path);
  const root = join(dir, "content");
  const engagement_id = uuidv7(); const session_id = "session";
  const first = new ArtifactContentStore(root, firstAuthority);
  const second = new ArtifactContentStore(root, secondAuthority);
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    await first.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
    const begin = { engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", idempotency_key: uuidv7() };
    const upload = await first.begin(begin, "host");
    assert.equal((await second.begin(begin, "host")).upload_id, upload.upload_id);
    const bytes = Buffer.from([0, 255, 17, 42]);
    await second.append({ engagement_id, session_id, upload_id: upload.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: hash(bytes) }, "host");
    const row = await first.commit({ engagement_id, session_id, upload_id: upload.upload_id, total_bytes: bytes.length, content_hash: hash(bytes) }, "host");
    assert.deepEqual(Buffer.from((await second.read({ engagement_id, session_id, content_ref: row.content_ref })).data, "base64"), bytes);
    assert.equal((await second.metadata({ engagement_id, session_id, content_ref: row.content_ref })).content_status, "available");
    await firstAuthority.updateArtifactCatalogRow({ ...row, content_status: "quarantined", integrity_status: "unverified" }, "artifact.publication.quarantined");
    assert.equal((await second.metadata({ engagement_id, session_id, content_ref: row.content_ref })).content_status, "quarantined");
    await assert.rejects(second.read({ engagement_id, session_id, content_ref: row.content_ref }), { code: "unavailable_host" });
    const external = await first.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain", storage_mode: "external", host_ref: "opaque-host-ref" }, "host");
    assert.deepEqual(new Set((await second.list({ engagement_id, session_id })).items.map((item) => item.content_ref)), new Set([row.content_ref, external.content_ref]));
  } finally { await Promise.all([firstAuthority.close(), secondAuthority.close()]); rmSync(dir, { recursive: true, force: true }); }
});

async function assertConcurrentArtifactIdempotency(firstAuthority, secondAuthority, dir) {
  const root = join(dir, "content"); const engagement_id = uuidv7(); const session_id = "session";
  const first = new ArtifactContentStore(root, firstAuthority); const second = new ArtifactContentStore(root, secondAuthority);
  await Promise.all([first.initialize(), second.initialize()]);
  await first.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
  const externalInput = { engagement_id, session_id, payload_kind: "text", media_type: "text/plain", storage_mode: "external", host_ref: "opaque-host-ref", idempotency_key: uuidv7() };
  const [firstExternal, secondExternal] = await Promise.all([first.begin(externalInput, "host"), second.begin(externalInput, "host")]);
  assert.deepEqual(secondExternal, firstExternal);
  assert.equal((await firstAuthority.artifactCatalogRows({ engagement_id, session_id })).length, 1);
  assert.equal((await firstAuthority.events()).filter((event) => event.event_type === "artifact.reference.external").length, 1);
  const beginInput = { engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", idempotency_key: uuidv7() };
  const [firstBegin, secondBegin] = await Promise.all([first.begin(beginInput, "host"), second.begin(beginInput, "host")]);
  assert.deepEqual(secondBegin, firstBegin);

  const bytes = Buffer.from([0, 255, 17, 42]);
  const appendInput = { engagement_id, session_id, upload_id: firstBegin.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: hash(bytes), idempotency_key: uuidv7() };
  const [firstAppend, secondAppend] = await Promise.all([first.append(appendInput, "host"), second.append(appendInput, "host")]);
  assert.deepEqual(secondAppend, firstAppend);
  const uploads = await firstAuthority.artifactUploads({ engagement_id, session_id });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.total_bytes, bytes.length);
  assert.equal(uploads[0].body.chunks.length, 1);

  const commitKey = uuidv7();
  const commitInput = { engagement_id, session_id, upload_id: firstBegin.upload_id, total_bytes: bytes.length, content_hash: hash(bytes), idempotency_key: commitKey };
  const row = await first.commit(commitInput, "host");
  const persistedRow = JSON.parse(JSON.stringify(row));
  const chunks = [{ ordinal: 0, offset: 0, bytes: bytes.length, hash: hash(bytes), path: `${row.relative_dir}/payload-000001.part` }];
  await assert.rejects(firstAuthority.completeArtifactPublication(firstBegin.upload_id, { ...row, content_hash: hash(Buffer.from("different")) }, chunks, { key: commitKey, principal: "host", request_hash: "mismatched", result: row }), { code: "conflict" });
  assert.deepEqual(await firstAuthority.artifactCatalogRow(engagement_id, session_id, row.content_ref), persistedRow);
  assert.deepEqual(await firstAuthority.artifactIdempotencyResult(commitKey, "artifact.store.commit", "host", engagement_id, requestHash(commitInput)), persistedRow);
  assert.deepEqual(await second.commit(commitInput, "host"), persistedRow);
  assert.equal((await firstAuthority.artifactCatalogRows({ engagement_id, session_id })).length, 2);
  assert.equal((await firstAuthority.artifactUploads({ engagement_id, session_id })).length, 0);
  assert.equal((await firstAuthority.events()).filter((event) => event.event_type === "artifact.content.committed").length, 1);
}

test("SQLite Artifact begin and append idempotency is serialized across authority instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-idempotency-race-"));
  const path = join(dir, "authority.sqlite");
  const firstAuthority = new AuthorityStore(path); const secondAuthority = new AuthorityStore(path);
  try { await assertConcurrentArtifactIdempotency(firstAuthority, secondAuthority, dir); }
  finally { await Promise.all([firstAuthority.close(), secondAuthority.close()]); rmSync(dir, { recursive: true, force: true }); }
});

test("Artifact commit succeeds when another initializer completes after rename but before publication mark", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-publication-race-"));
  const authority = new AuthorityStore(join(dir, "authority.sqlite"));
  let markEntered; const entered = new Promise((resolve) => { markEntered = resolve; });
  let releaseMark; const markGate = new Promise((resolve) => { releaseMark = resolve; });
  const delayedAuthority = wrapAuthority(authority, {
    markArtifactPublication: async (...args) => { markEntered(); await markGate; return authority.markArtifactPublication(...args); },
  });
  const root = join(dir, "content"); const engagement_id = uuidv7(); const session_id = "session";
  const first = new ArtifactContentStore(root, delayedAuthority); const second = new ArtifactContentStore(root, authority);
  try {
    await first.initialize();
    await first.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
    const work = await authority.createRecord({ engagement_id, kind: "work_item", title: "artifact publication race", status: "queued", acceptance_criteria: ["publish once"] }, "L1");
    const run = await authority.claimWorkRun({ engagement_id, work_item_id: work.id, host_id: "host", agent_id: "agent", task_session_ref: session_id, ttl_ms: 60_000 });
    const bytes = Buffer.from("published by recovery");
    const upload = await first.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain", work_run_id: run.run_id, attempt_id: run.attempt_ref, generation: run.generation }, "host");
    await first.append({ engagement_id, session_id, upload_id: upload.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: hash(bytes) }, "host");
    const commitKey = uuidv7();
    const commitInput = { engagement_id, session_id, upload_id: upload.upload_id, total_bytes: bytes.length, content_hash: hash(bytes), idempotency_key: commitKey };
    const committing = first.commit(commitInput, "host");
    await entered;
    await second.initialize();
    assert.deepEqual(await authority.artifactPublications(), []);
    await authority.transitionWorkRun(run.run_id, run.generation, "host", "completed");
    await assert.rejects(authority.validateArtifactFence({ engagement_id, session_id, work_run_id: run.run_id, attempt_id: run.attempt_ref, generation: run.generation, principal: "host" }), { code: "stale_version" });
    releaseMark();
    const row = await committing;
    const persistedRow = JSON.parse(JSON.stringify(row));
    assert.deepEqual(await authority.artifactCatalogRow(engagement_id, session_id, row.content_ref), persistedRow);
    assert.deepEqual(await authority.artifactIdempotencyResult(commitKey, "artifact.store.commit", "host", engagement_id, requestHash(commitInput)), persistedRow);
    assert.equal((await authority.artifactCatalogRows({ engagement_id, session_id })).length, 1);
    assert.equal((await authority.events()).filter((event) => event.event_type === "artifact.content.committed").length, 1);
    assert.deepEqual(Buffer.from((await second.read({ engagement_id, session_id, content_ref: row.content_ref })).data, "base64"), bytes);
  } finally { releaseMark(); await authority.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Artifact recovery and reconcile leave another host's spool and markers alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-host-roots-"));
  const authority = new AuthorityStore(join(dir, "authority.sqlite"));
  const root = join(dir, "first-host"); const otherRoot = join(dir, "second-host");
  const engagement_id = uuidv7(); const session_id = "session";
  const bytes = Buffer.from("private first-host payload");
  try {
    const first = new ArtifactContentStore(root, authority, { fault: (point) => { if (point === "after_rename") throw new Error("simulated process stop"); } });
    await first.initialize();
    await first.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
    const upload = await first.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain" }, "host");
    await first.append({ engagement_id, session_id, upload_id: upload.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: hash(bytes) }, "host");
    await assert.rejects(first.commit({ engagement_id, session_id, upload_id: upload.upload_id, total_bytes: bytes.length, content_hash: hash(bytes) }, "host"), /simulated process stop/);
    const marker = (await authority.artifactPublications())[0];
    let completions = 0;
    const observed = wrapAuthority(authority, {
      completeArtifactPublication: async (...args) => { completions++; return authority.completeArtifactPublication(...args); },
    });
    const second = new ArtifactContentStore(otherRoot, observed);
    await second.initialize();
    const report = await second.reconcile();
    assert.equal(completions, 0);
    assert.equal(report.checked, 0);
    assert.deepEqual(report.pending_publications, []);
    assert.equal((await authority.artifactCatalogRows()).length, 0);
    assert.deepEqual(await authority.artifactPublications(), [marker]);
    assert.deepEqual(readFileSync(join(root, session_id, marker.body.row.relative_dir, "payload-000001.part")), bytes);
    await assert.rejects(second.list({ engagement_id, session_id }), { code: "authorization_error" });
    const restarted = new ArtifactContentStore(root, authority);
    await restarted.initialize();
    assert.equal((await authority.artifactPublications()).length, 0);
    assert.deepEqual(Buffer.from((await restarted.read({ engagement_id, session_id, content_ref: marker.content_ref })).data, "base64"), bytes);
  } finally { await authority.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Artifact awaits backend failures before exposing a publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-await-failure-"));
  const authority = new AuthorityStore(join(dir, "authority.sqlite"));
  const failure = Object.assign(new Error("authority unavailable"), { code: "unavailable_host" });
  let rejected = false;
  const broken = wrapAuthority(authority, {
    completeArtifactPublication: async () => { await nextTurn(); rejected = true; throw failure; },
  });
  const root = join(dir, "content"); const engagement_id = uuidv7(); const session_id = "session";
  try {
    const artifacts = new ArtifactContentStore(root, broken);
    await artifacts.initialize();
    await artifacts.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
    const bytes = Buffer.from("not yet published");
    const upload = await artifacts.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain" }, "host");
    await artifacts.append({ engagement_id, session_id, upload_id: upload.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: hash(bytes) }, "host");
    await assert.rejects(artifacts.commit({ engagement_id, session_id, upload_id: upload.upload_id, total_bytes: bytes.length, content_hash: hash(bytes) }, "host"), failure);
    assert.equal(rejected, true);
    assert.equal((await authority.artifactCatalogRows()).length, 0);
    assert.equal((await artifacts.list({ engagement_id, session_id })).items.length, 0);
    assert.equal((await authority.artifactPublications())[0].phase, "quarantined");
    const restarted = new ArtifactContentStore(root, authority);
    await restarted.initialize();
    assert.equal((await authority.artifactCatalogRows()).length, 0);
  } finally { await authority.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Artifact serializes concurrent ordered appends and commit within one process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-ordered-"));
  const authority = new AuthorityStore(join(dir, "authority.sqlite"));
  const root = join(dir, "content"); const engagement_id = uuidv7(); const session_id = "session";
  try {
    const artifacts = new ArtifactContentStore(root, authority);
    await artifacts.initialize();
    await artifacts.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
    const chunks = [Buffer.from([0, 1, 255]), Buffer.from([17, 42, 0])]; const bytes = Buffer.concat(chunks);
    const upload = await artifacts.begin({ engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream" }, "host");
    const append = (ordinal, principal = "host") => artifacts.append({ engagement_id, session_id, upload_id: upload.upload_id, ordinal, data: chunks[ordinal].toString("base64"), chunk_hash: hash(chunks[ordinal]) }, principal);
    await assert.rejects(append(0, "other-host"), { code: "authorization_error" });
    const [first, second, row] = await Promise.all([
      append(0), append(1),
      artifacts.commit({ engagement_id, session_id, upload_id: upload.upload_id, total_bytes: bytes.length, chunk_count: 2, content_hash: hash(bytes) }, "host"),
    ]);
    assert.equal(first.next_ordinal, 1); assert.equal(second.next_ordinal, 2); assert.equal(row.chunk_count, 2);
    const firstRead = await artifacts.read({ engagement_id, session_id, content_ref: row.content_ref });
    const secondRead = await artifacts.read({ engagement_id, session_id, content_ref: row.content_ref, chunk_cursor: firstRead.next_cursor });
    assert.deepEqual(Buffer.concat([Buffer.from(firstRead.data, "base64"), Buffer.from(secondRead.data, "base64")]), bytes);
    assert.equal(secondRead.next_cursor, undefined);
    assert.equal((await authority.verifyAudit()).valid, true);
  } finally { await authority.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Artifact reconcile continues bounded pages across local sessions and optional engagement scopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-reconcile-pages-"));
  const authority = new AuthorityStore(join(dir, "authority.sqlite"));
  const root = join(dir, "content"); const engagement_id = uuidv7();
  try {
    const artifacts = new ArtifactContentStore(root, authority);
    await artifacts.initialize();
    for (const session_id of ["second", "first"]) {
      await artifacts.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
      await artifacts.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain", storage_mode: "external", host_ref: "opaque" }, "host");
    }
    for (const scope of [{}, { engagement_id }]) {
      const first = await artifacts.reconcile({ ...scope, page_size: 1 });
      assert.equal(first.checked, 1);
      assert.equal(typeof first.next_cursor, "string");
      const second = await artifacts.reconcile({ ...scope, page_size: 1, cursor: first.next_cursor });
      assert.equal(second.checked, 1);
      assert.equal(second.next_cursor, undefined);
    }
  } finally { await authority.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("live PostgreSQL Artifact consumers refresh shared catalogs without processing another spool", async (t) => {
  const connectionString = process.env.TARIC_TEST_DATABASE_URL;
  if (!connectionString) return t.skip("set TARIC_TEST_DATABASE_URL to run live PostgreSQL Artifact consumers");
  const { Pool } = await import("pg");
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-postgresql-"));
  const schema = `taric_artifact_async_${randomBytes(6).toString("hex")}`;
  const firstPool = new Pool({ connectionString, max: 4 }); const secondPool = new Pool({ connectionString, max: 4 });
  const firstAuthority = new PostgresAuthorityStore(firstPool, { profile: "multi_host_authority", schema });
  const secondAuthority = new PostgresAuthorityStore(secondPool, { profile: "multi_host_authority", schema, migrate: false });
  const root = join(dir, "content"); const engagement_id = uuidv7(); const session_id = "session";
  try {
    await firstAuthority.migrate();
    const first = new ArtifactContentStore(root, firstAuthority);
    const second = new ArtifactContentStore(root, secondAuthority);
    // These consumers run in one process; catalog sharing does not grant filesystem safety.
    await Promise.all([first.initialize(), second.initialize()]);
    await first.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
    const bytes = Buffer.from([0, 255, 17, 42]);
    const upload = await first.begin({ engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream" }, "host");
    await second.append({ engagement_id, session_id, upload_id: upload.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: hash(bytes) }, "host");
    const row = await first.commit({ engagement_id, session_id, upload_id: upload.upload_id, total_bytes: bytes.length, content_hash: hash(bytes) }, "host");
    assert.deepEqual(Buffer.from((await second.read({ engagement_id, session_id, content_ref: row.content_ref })).data, "base64"), bytes);
    await firstAuthority.updateArtifactCatalogRow({ ...row, content_status: "quarantined", integrity_status: "unverified" }, "artifact.publication.quarantined");
    assert.equal((await second.metadata({ engagement_id, session_id, content_ref: row.content_ref })).content_status, "quarantined");
    await assert.rejects(second.read({ engagement_id, session_id, content_ref: row.content_ref }), { code: "unavailable_host" });
    const other = new ArtifactContentStore(join(dir, "other-host"), secondAuthority);
    await other.initialize();
    assert.equal((await other.reconcile({ engagement_id })).checked, 0);
    const delayedRow = await firstAuthority.artifactCatalogRow(engagement_id, session_id, row.content_ref);
    assert.equal(delayedRow.content_status, "quarantined");
    assert.equal((await firstAuthority.verifyAudit()).valid, true);
  } finally {
    await Promise.all([firstAuthority.close(), secondAuthority.close()]);
    await firstPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.all([firstPool.end(), secondPool.end()]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live PostgreSQL Artifact idempotency races serialize across authority instances", async (t) => {
  const connectionString = process.env.TARIC_TEST_DATABASE_URL;
  if (!connectionString) return t.skip("set TARIC_TEST_DATABASE_URL to run live PostgreSQL Artifact idempotency races");
  const { Pool } = await import("pg");
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-postgresql-race-"));
  const schema = `taric_artifact_race_${randomBytes(6).toString("hex")}`;
  const firstPool = new Pool({ connectionString, max: 4 }); const secondPool = new Pool({ connectionString, max: 4 });
  const firstAuthority = new PostgresAuthorityStore(firstPool, { profile: "multi_host_authority", schema });
  const secondAuthority = new PostgresAuthorityStore(secondPool, { profile: "multi_host_authority", schema, migrate: false });
  try {
    await firstAuthority.migrate();
    await assertConcurrentArtifactIdempotency(firstAuthority, secondAuthority, dir);
  } finally {
    await Promise.all([firstAuthority.close(), secondAuthority.close()]);
    await firstPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.all([firstPool.end(), secondPool.end()]);
    rmSync(dir, { recursive: true, force: true });
  }
});
