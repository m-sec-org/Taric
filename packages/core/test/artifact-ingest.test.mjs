import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, rename, rm, symlink, truncate, writeFile, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "taric-ingest-"));
  const contentRoot = join(directory, "content");
  const root = join(contentRoot, "session-root");
  await mkdir(root, { recursive: true });
  const store = new AuthorityStore();
  const service = await createCoreService(store, contentRoot);
  const engagement_id = uuidv7();
  const session_id = "ingest-session";
  const host = createPrincipal("host", "host-a", engagement_id, ["content_read"]);
  const bound = await service.dispatch("artifact.session.bind", host, { engagement_id, session_id, root, mode: "host-session" });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  return { directory, root, store, service, engagement_id, session_id, host };
}

const writeRandomFile = async (path, totalBytes, blockSize = 8 * 1024 * 1024) => {
  const { createWriteStream } = await import("node:fs");
  const digest = createHash("sha256");
  await new Promise((resolveDone, rejectDone) => {
    const stream = createWriteStream(path);
    stream.on("finish", resolveDone);
    stream.on("error", rejectDone);
    (async () => {
      let written = 0;
      while (written < totalBytes) {
        const block = Buffer.from(randomBytes(Math.min(blockSize, totalBytes - written)));
        await new Promise((resolveChunk) => stream.write(block, resolveChunk));
        digest.update(block);
        written += block.length;
      }
      stream.end();
    })().catch(rejectDone);
  });
  return `sha256:${digest.digest("hex")}`;
};

test("artifact.ingest_file round-trips a 1 GiB original with verified hash", async () => {
  const { directory, root, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "tool-output.bin");
  try {
    const expected = await writeRandomFile(source, 1024 * 1024 * 1024 + 17);
    const ingested = await service.dispatch("artifact.ingest_file", host, {
      engagement_id, session_id, path: source, payload_kind: "binary", media_type: "application/octet-stream", category: "tool-output",
      authorize_spool_access: true,
      idempotency_key: "ingest-1gib",
    });
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.equal(ingested.data.content_hash, expected);
    assert.equal(ingested.data.byte_length, 1024 * 1024 * 1024 + 17);
    assert.ok(ingested.data.chunk_count >= 16, `expected multi-chunk storage: ${ingested.data.chunk_count}`);

    const metadata = await service.dispatch("artifact.metadata", host, { engagement_id, session_id, content_ref: ingested.data.content_ref });
    assert.equal(metadata.ok, true, JSON.stringify(metadata));
    assert.equal(metadata.data.content_hash, expected);
    assert.equal(metadata.data.integrity_status, "verified");

    // 读回首尾 512 KiB 逐字节核对。
    const { readFile } = await import("node:fs/promises");
    const whole = await readFile(source);
    const head = await service.dispatch("artifact.content.read", host, { engagement_id, session_id, content_ref: ingested.data.content_ref, offset: 0, length: 512 * 1024 });
    assert.equal(head.ok, true, JSON.stringify(head));
    assert.equal(Buffer.compare(Buffer.from(head.data.data, "base64"), whole.subarray(0, 512 * 1024)), 0);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("artifact.ingest_file retries with the same idempotency key without duplicates", async () => {
  const { directory, root, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "retry.txt");
  try {
    await writeFile(source, "retry payload");
    const request = { engagement_id, session_id, path: source, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain", idempotency_key: "ingest-retry" };
    const first = await service.dispatch("artifact.ingest_file", host, request);
    assert.equal(first.ok, true, JSON.stringify(first));
    // 重试（等价于 kill 后重放同请求）：返回原始结果，目录无重复。
    const retry = await service.dispatch("artifact.ingest_file", host, request);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.data.content_ref, first.data.content_ref);
    const listed = await service.dispatch("artifact.content.list", host, { engagement_id, session_id });
    assert.equal(listed.data.items.filter((item) => item.content_ref === first.data.content_ref).length, 1);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("artifact.ingest_file rejects path escapes, symlinks, oversized files, and mode mixing", async () => {
  const { directory, root, service, engagement_id, session_id, host } = await fixture();
  const outside = join(directory, "outside.txt");
  const link = join(root, "escape-link");
  const inside = join(root, "inside.txt");
  try {
    await writeFile(outside, "outside");
    await writeFile(inside, "inside");
    await symlink(outside, link);

    const attempts = await Promise.all([
      service.dispatch("artifact.ingest_file", host, { engagement_id, session_id, path: join(root, "..", "outside.txt"), authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" }),
      service.dispatch("artifact.ingest_file", host, { engagement_id, session_id, path: link, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" }),
      service.dispatch("artifact.ingest_file", host, { engagement_id, session_id, path: join(root, "missing.txt"), authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" }),
      service.dispatch("artifact.ingest_file", host, { engagement_id, session_id, path: root, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" }),
      service.dispatch("artifact.ingest_file", host, { engagement_id, session_id, path: inside, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain", storage_mode: "external" }),
    ]);
    for (const attempt of attempts) {
      assert.equal(attempt.ok, false, JSON.stringify(attempt));
      assert.equal(attempt.error.code, "validation_error");
    }
    assert.match(attempts[0].error.message, /traversal|escapes|unavailable/);
    assert.match(attempts[1].error.message, /symlink|escapes/);
    // 越界尝试不得读取任何文件入库。
    const listed = await service.dispatch("artifact.content.list", host, { engagement_id, session_id });
    assert.equal(listed.data.items.length, 0);

    process.env.TARIC_INGEST_MAX_BYTES = "4";
    try {
      const oversized = await service.dispatch("artifact.ingest_file", host, { engagement_id, session_id, path: inside, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" });
      assert.equal(oversized.ok, false);
      assert.equal(oversized.error.code, "validation_error");
      process.env.TARIC_INGEST_MAX_BYTES = "0";
      const invalidLimit = await service.dispatch("artifact.ingest_file", host, { engagement_id, session_id, path: inside, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" });
      assert.equal(invalidLimit.ok, false);
      assert.equal(invalidLimit.error.code, "validation_error");
    } finally { delete process.env.TARIC_INGEST_MAX_BYTES; }
    await access(inside);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("spool reads require explicit host authorization", async () => {
  const { directory, root, store, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "explicit.txt");
  try {
    await writeFile(source, "opaque bytes");
    const before = await store.events();
    for (const authorization of [undefined, false]) {
      const result = await service.dispatch("artifact.ingest_file", host, {
        engagement_id, session_id, path: source,
        ...(authorization === undefined ? {} : { authorize_spool_access: authorization }),
        payload_kind: "text", media_type: "text/plain",
      });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "validation_error");
    }
    assert.deepEqual(await store.events(), before);
    await access(source);
    const listed = await service.dispatch("artifact.content.list", host, { engagement_id, session_id });
    assert.equal(listed.data.items.length, 0);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("host-managed external Artifact references never open or copy the referenced path", async () => {
  const { directory, root, service, engagement_id, session_id, host } = await fixture();
  const hostManagedPath = join(root, "operator-owned-never-opened.bin");
  try {
    const external = await service.dispatch("artifact.store.begin", host, {
      engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream",
      storage_mode: "external", host_ref: hostManagedPath, expected_bytes: 9,
    });
    assert.equal(external.ok, true, JSON.stringify(external));
    assert.equal(external.data.storage_mode, "external");
    assert.equal(external.data.content_status, "external");
    await assert.rejects(access(hostManagedPath));
    const listed = await service.dispatch("artifact.content.list", host, { engagement_id, session_id });
    assert.equal(listed.data.items.some((item) => item.host_ref === hostManagedPath), false, "path locators are not copied into public Artifact metadata");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("source replacement or interrupted reads preserve the directory entry and publish nothing", async () => {
  const { directory, root, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "replace-during-read.bin");
  const original = join(root, "renamed-original.bin");
  try {
    await writeFile(source, "");
    await truncate(source, 256 * 1024 * 1024);
    const ingest = service.dispatch("artifact.ingest_file", host, {
      engagement_id, session_id, path: source, authorize_spool_access: true,
      payload_kind: "binary", media_type: "application/octet-stream", delete_source: true,
    });
    let firstChunk = false;
    const deadline = Date.now() + 30_000;
    while (!firstChunk && Date.now() < deadline) {
      try {
        for (const upload of await readdir(join(root, ".staging"))) {
          const staging = join(root, ".staging", upload);
          for (const name of await readdir(staging)) {
            if (name.startsWith("chunk-00000000.") && name.endsWith(".receive") && (await stat(join(staging, name))).size > 0) { firstChunk = true; break; }
          }
          if (!firstChunk) {
            const staged = join(staging, "chunk-00000000.part");
            try { if ((await stat(staged)).size > 0) firstChunk = true; } catch { /* receive file has not been finalized */ }
          }
          if (firstChunk) break;
        }
      } catch { /* upload staging is created asynchronously */ }
      if (!firstChunk) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(firstChunk, true, "the test waits until source bytes have entered private staging");
    await rename(source, original);
    await writeFile(source, "replacement entry");
    await truncate(original, 0);
    const result = await ingest;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "conflict");
    assert.equal(await (await import("node:fs/promises")).readFile(source, "utf8"), "replacement entry");
    assert.equal((await stat(original)).size, 0, "the interrupted original remains where the host moved it");
    const listed = await service.dispatch("artifact.content.list", host, { engagement_id, session_id });
    assert.equal(listed.data.items.length, 0, "partial staged bytes are not published");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("replacement after the source read is committed but never deleted", async () => {
  const { directory, root, store, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "replace-before-delete.bin");
  const original = join(root, "read-original.bin");
  let resumePublication;
  let signalPublication;
  const publicationReached = new Promise((resolve) => { signalPublication = resolve; });
  const publicationGate = new Promise((resolve) => { resumePublication = resolve; });
  const saveIdempotency = store.saveArtifactIdempotency.bind(store);
  try {
    await writeFile(source, "fully read before publication");
    store.saveArtifactIdempotency = async (...args) => {
      await saveIdempotency(...args);
      if (args[1] === "artifact.ingest_file") {
        signalPublication();
        await publicationGate;
      }
    };
    const ingest = service.dispatch("artifact.ingest_file", host, {
      engagement_id, session_id, path: source, authorize_spool_access: true,
      payload_kind: "text", media_type: "text/plain", delete_source: true, idempotency_key: "replace-before-delete",
    });
    await publicationReached;
    await rename(source, original);
    await writeFile(source, "replacement entry");
    resumePublication();
    const result = await ingest;
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.source_deleted, false);
    assert.equal(await (await import("node:fs/promises")).readFile(source, "utf8"), "replacement entry");
    assert.equal(await (await import("node:fs/promises")).readFile(original, "utf8"), "fully read before publication");
    const listed = await service.dispatch("artifact.content.list", host, { engagement_id, session_id });
    assert.equal(listed.data.items.length, 1);
    assert.equal(listed.data.items[0].content_hash, result.data.content_hash);
  } finally { resumePublication(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("delete_source remains explicit and source is preserved when conditional unlink is unavailable", async () => {
  const { directory, root, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "move.txt");
  const failing = join(root, "failing.txt");
  try {
    await writeFile(source, "move me");
    const moveRequest = { engagement_id, session_id, path: source, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain", delete_source: true, idempotency_key: "ingest-delete-retry" };
    const moved = await service.dispatch("artifact.ingest_file", host, moveRequest);
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.data.delete_source_requested, true);
    assert.equal(moved.data.source_deleted, false);
    assert.match(moved.data.source_delete_reason, /atomic identity-safe unlink/);
    await access(source);
    const moveRetry = await service.dispatch("artifact.ingest_file", host, moveRequest);
    assert.equal(moveRetry.ok, true, JSON.stringify(moveRetry));
    assert.equal(moveRetry.data.content_ref, moved.data.content_ref);
    assert.equal(moveRetry.data.source_deleted, false);

    await writeFile(failing, "do not delete");
    // 预置错误 expected_hash 迫使 commit 失败：源文件必须原样保留且无可见产物。
    const failed = await service.dispatch("artifact.ingest_file", host, {
      engagement_id, session_id, path: failing, payload_kind: "text", media_type: "text/plain",
      authorize_spool_access: true,
      delete_source: true, expected_hash: `sha256:${"0".repeat(64)}`, idempotency_key: "ingest-fail",
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, "conflict");
    await access(failing);
    const failingHash = `sha256:${createHash("sha256").update("do not delete").digest("hex")}`;
    const listed = await service.dispatch("artifact.content.list", host, { engagement_id, session_id });
    assert.equal(listed.data.items.filter((item) => item.content_hash === failingHash).length, 0, "failed ingestion must leave no visible artifact");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("opaque payload bytes never appear in Artifact audit events", async () => {
  const { directory, root, store, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "opaque-payload.txt");
  const marker = "opaque-payload-marker-9c7d";
  try {
    await writeFile(source, marker);
    const result = await service.dispatch("artifact.ingest_file", host, {
      engagement_id, session_id, path: source, authorize_spool_access: true,
      payload_kind: "text", media_type: "text/plain",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(JSON.stringify(await store.events()).includes(marker), false);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("publication failure leaves the source untouched and the Artifact invisible", async () => {
  const { directory, root, store, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "publication-failure.txt");
  const startPublication = store.startArtifactPublication.bind(store);
  try {
    await writeFile(source, "publication failure must preserve source");
    store.startArtifactPublication = async () => { throw new Error("injected publication failure"); };
    const result = await service.dispatch("artifact.ingest_file", host, {
      engagement_id, session_id, path: source, authorize_spool_access: true,
      payload_kind: "text", media_type: "text/plain", delete_source: true,
    });
    assert.equal(result.ok, false);
    await access(source);
    const listed = await service.dispatch("artifact.content.list", host, { engagement_id, session_id });
    assert.equal(listed.data.items.length, 0);
  } finally { store.startArtifactPublication = startPublication; await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("artifact.ingest_file separates roles and engagements", async () => {
  const { directory, root, service, engagement_id, session_id, host } = await fixture();
  const source = join(root, "authz.txt");
  const other_engagement = uuidv7();
  try {
    await writeFile(source, "authz");
    const model = createPrincipal("model", "model-a", engagement_id, ["content_read"]);
    const reviewer = createPrincipal("reviewer", "reviewer-a", engagement_id, ["content_read"]);
    for (const principal of [model, reviewer]) {
      const denied = await service.dispatch("artifact.ingest_file", principal, { engagement_id, session_id, path: source, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" });
      assert.equal(denied.ok, false);
      assert.equal(denied.error.code, "authorization_error");
    }
    const cross = await service.dispatch("artifact.ingest_file", host, { engagement_id: other_engagement, session_id, path: source, authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" });
    assert.equal(cross.ok, false);
    assert.equal(cross.error.code, "authorization_error");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
