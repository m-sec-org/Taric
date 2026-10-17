import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactContentStore, AuthorityStore, ARTIFACT_CHUNK_BYTES, ARTIFACT_DEPLOYMENT_PROFILE, uuidv7 } from "../dist/index.js";

const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const points = ["before_manifest", "before_rename", "after_rename", "after_publication_marker", "before_catalog_commit", "after_catalog_commit"];

test("Artifact profile keeps the 64 MiB limit and declares process-crash recovery", () => {
  assert.equal(ARTIFACT_DEPLOYMENT_PROFILE.decoded_chunk_bytes, ARTIFACT_CHUNK_BYTES);
  assert.equal(ARTIFACT_CHUNK_BYTES, 64 * 1024 ** 2);
  assert.equal(ARTIFACT_DEPLOYMENT_PROFILE.power_loss_durable, false);
  assert.equal(ARTIFACT_DEPLOYMENT_PROFILE.fsync, "none");
  assert.ok(ARTIFACT_DEPLOYMENT_PROFILE.transport_envelope_max_bytes > ARTIFACT_CHUNK_BYTES);
});

for (const point of points) test(`Artifact restart after ${point} exposes only verified publications`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-fault-"));
  const path = join(dir, "authority.sqlite"); const root = join(dir, "content"); const sessionRoot = join(root, "session");
  const engagement_id = uuidv7(); const session_id = "session";
  let authority = new AuthorityStore(path);
  try {
    let artifacts = new ArtifactContentStore(root, authority, { fault: (at) => { if (at === point) throw new Error("injected process stop"); } }); await artifacts.initialize();
    (await artifacts.bind({ engagement_id, session_id, root: sessionRoot, mode: "host-session" }));
    const body = Buffer.from("verified textual original\n"); const content_hash = hash(body);
    const started = (await artifacts.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain" }));
    (await artifacts.append({ engagement_id, session_id, upload_id: started.upload_id, ordinal: 0, data: body.toString("base64"), chunk_hash: content_hash }));
    (await assert.rejects(async () => (await artifacts.commit({ engagement_id, session_id, upload_id: started.upload_id, total_bytes: body.length, content_hash })), /injected process stop/));
    (await authority.close()); authority = new AuthorityStore(path); artifacts = new ArtifactContentStore(root, authority); await artifacts.initialize();
    const report = (await artifacts.reconcile({ engagement_id, session_id }));
    const rows = (await authority.artifactCatalogRows());
    const shouldRecover = ["after_rename", "after_publication_marker", "after_catalog_commit"].includes(point);
    assert.equal(rows.length, shouldRecover ? 1 : 0);
    assert.equal(report.pending_publications.length, shouldRecover ? 0 : 1);
    if (shouldRecover) {
      const row = rows[0];
      assert.equal(row.content_status, "available"); assert.equal(row.integrity_status, "verified");
      const result = (await artifacts.read({ engagement_id, session_id, content_ref: row.content_ref }));
      assert.deepEqual(Buffer.from(result.data, "base64"), body); assert.equal(row.content_hash, content_hash);
    } else assert.equal((await artifacts.list({ engagement_id, session_id })).items.length, 0);
    assert.equal((await authority.verifyAudit()).valid, true);
  } finally { (await authority.close()); rmSync(dir, { recursive: true, force: true }); }
});

test("restart cannot recover a published marker with a tampered chunk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-integrity-")); const path = join(dir, "authority.sqlite"); const root = join(dir, "content");
  let authority = new AuthorityStore(path);
  const engagement_id = uuidv7(); const session_id = "session";
  try {
    const artifacts = new ArtifactContentStore(root, authority, { fault: (point) => { if (point === "after_publication_marker") throw new Error("crash"); } }); await artifacts.initialize();
    (await artifacts.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" }));
    const body = Buffer.from([0, 255, 8, 42]); const content_hash = hash(body);
    const started = (await artifacts.begin({ engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream" }));
    (await artifacts.append({ engagement_id, session_id, upload_id: started.upload_id, ordinal: 0, data: body.toString("base64"), chunk_hash: content_hash }));
    (await assert.rejects(async () => (await artifacts.commit({ engagement_id, session_id, upload_id: started.upload_id, total_bytes: body.length, content_hash })), /crash/));
    const marker = (await authority.artifactPublications())[0]; const row = marker.body.row;
    writeFileSync(join(root, session_id, row.relative_dir, "payload-000001.part"), Buffer.from([1, 2, 3, 4]));
    (await authority.close()); authority = new AuthorityStore(path);
    const restarted = new ArtifactContentStore(root, authority); await restarted.initialize();
    assert.equal((await authority.artifactCatalogRows()).length, 0);
    assert.equal((await restarted.reconcile({ engagement_id, session_id })).pending_publications.length, 1);
    assert.equal((await restarted.list({ engagement_id, session_id })).items.length, 0);
  } finally { (await authority.close()); rmSync(dir, { recursive: true, force: true }); }
});

test("restart leaves run-bound publication pending after its Attempt lease expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-expired-run-"));
  const path = join(dir, "authority.sqlite"); const root = join(dir, "content"); const engagement_id = uuidv7(); const session_id = "leased-session"; const host_id = "host-a";
  let authority = new AuthorityStore(path);
  try {
    const work_item_id = uuidv7();
    await authority.commit({ id: work_item_id, engagement_id, kind: "work_item", title: "leased artifact", status: "queued", acceptance_criteria: ["persist"] }, "L2");
    const run = await authority.claimWorkRun({ work_item_id, engagement_id, host_id, agent_id: "worker", ttl_ms: 1000 });
    let artifacts = new ArtifactContentStore(root, authority, { fault: (point) => { if (point === "after_publication_marker") throw new Error("injected process stop"); } });
    await artifacts.initialize();
    await artifacts.bind({ engagement_id, session_id, root: join(root, session_id), mode: "run-bound", work_run_id: run.run_id, attempt_id: run.attempt_ref, generation: run.generation, owner_host: host_id }, host_id);
    const body = Buffer.from("must remain unavailable"); const content_hash = hash(body);
    const started = await artifacts.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain" }, host_id);
    await artifacts.append({ engagement_id, session_id, upload_id: started.upload_id, ordinal: 0, data: body.toString("base64"), chunk_hash: content_hash }, host_id);
    await assert.rejects(() => artifacts.commit({ engagement_id, session_id, upload_id: started.upload_id, total_bytes: body.length, content_hash }, host_id), /injected process stop/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await authority.close(); authority = new AuthorityStore(path);
    artifacts = new ArtifactContentStore(root, authority);
    await artifacts.initialize();
    assert.equal((await authority.artifactCatalogRows()).length, 0);
    assert.equal((await artifacts.list({ engagement_id, session_id })).items.length, 0);
    assert.equal((await artifacts.reconcile({ engagement_id, session_id })).pending_publications.length, 1);
  } finally { await authority.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reconcile detects both absent and corrupted committed chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifact-reconcile-")); const root = join(dir, "content"); const authority = new AuthorityStore(join(dir, "authority.sqlite"));
  try {
    const artifacts = new ArtifactContentStore(root, authority); await artifacts.initialize(); const engagement_id = uuidv7(); const session_id = "session";
    (await artifacts.bind({ engagement_id, session_id, root: join(root, session_id), mode: "host-session" }));
    const put = async () => { const body = Buffer.from("same length"); const content_hash = hash(body); const started = (await artifacts.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain" })); (await artifacts.append({ engagement_id, session_id, upload_id: started.upload_id, ordinal: 0, data: body.toString("base64"), chunk_hash: content_hash })); return (await artifacts.commit({ engagement_id, session_id, upload_id: started.upload_id, total_bytes: body.length, content_hash })); };
    const absent = (await put()); const corrupt = (await put());
    rmSync(join(root, session_id, absent.relative_dir, "payload-000001.part"));
    writeFileSync(join(root, session_id, corrupt.relative_dir, "payload-000001.part"), "wrong bytes");
    const report = (await artifacts.reconcile({ engagement_id, session_id }));
    assert.deepEqual(report.unavailable, [absent.content_ref]); assert.deepEqual(report.integrity_failed, [corrupt.content_ref]);
    assert.equal((await authority.artifactCatalogRow(engagement_id, session_id, absent.content_ref)).content_status, "unavailable");
    assert.equal((await authority.artifactCatalogRow(engagement_id, session_id, corrupt.content_ref)).content_status, "integrity_failed");
  } finally { (await authority.close()); rmSync(dir, { recursive: true, force: true }); }
});
