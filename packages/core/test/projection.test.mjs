import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, publishProjection, readProjection, uuidv7 } from "../dist/index.js";

test("projection allowlist excludes sensitive fields and publishes complete files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "test", token: "secret", private_path: "/tmp/private", artifact_body: "raw" }, "L2");
  const result = await publishProjection(store, { engagementId: engagement_id, outputDir: dir });
  const body = await readFile(join(dir, "current", "STATE.md"), "utf8");
  assert.equal(result.remotePushAllowed, false); assert.match(body, /test/); assert.doesNotMatch(body, /secret|private|raw/);
  await assert.rejects(() => readProjection(join(dir, "current", "STATE.md"), false), /permission denied/);
  await rm(dir, { recursive: true, force: true }); store.close();
});

test("remote push requires all explicit safeguards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  const result = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, canPushRemote: true, remote: { privateRepository: true, accessControl: true, retentionPolicy: true, secretScan: true } });
  assert.equal(result.remotePushAllowed, true); await rm(dir, { recursive: true, force: true }); store.close();
});
