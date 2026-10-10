import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, pinProjection, publishProjection, readProjection, unpinProjection, uuidv7 } from "../dist/index.js";

test("projection allowlist excludes sensitive fields and publishes complete files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "test", token: "secret", secret_ref: "vault://secret", private_path: "/tmp/private", artifact_body: "raw", draft_body: "sensitive draft" }, "L2");
  store.submitProposal({ engagement_id, subject_type: "claim", base_version: 0, content: { id: uuidv7(), engagement_id, kind: "claim", proposition: "unreviewed canary" } });
  const result = await publishProjection(store, { engagementId: engagement_id, outputDir: dir });
  const body = await readFile(join(dir, "current", "STATE.md"), "utf8");
  assert.equal(result.remotePushAllowed, false); assert.match(body, /test/); assert.doesNotMatch(body, /secret|private|raw|unreviewed canary|sensitive draft/);
  assert.equal(result.manifest.authority_sequence, result.manifest.projected_watermark);
  assert.ok(result.manifest.files["STATE.md"].startsWith("sha256:"));
  const request = { principalId: "worker", engagementId: engagement_id, outputDir: dir, generation: result.generation, file: "STATE.md" };
  await assert.rejects(() => readProjection(request, () => false), /permission denied/);
  assert.match(await readProjection(request, (principal, engagement) => principal === "worker" && engagement === engagement_id), /Engagement Brief/);
  const next = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  assert.notEqual(next.generation, result.generation);
  assert.match(await readProjection(request, () => true), /Engagement Brief/, "the previous immutable generation remains readable");
  await assert.rejects(() => readProjection({ ...request, engagementId: uuidv7() }, () => true), /permission denied/);
  await assert.rejects(() => readProjection({ ...request, file: "../../authority.db" }, () => true), /path denied/);
  await rm(dir, { recursive: true, force: true }); store.close();
});

test("remote push requires all explicit safeguards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  let scanCalled = false;
  const result = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, canPushRemote: true, remote: { privateRepository: true, accessControl: true, retentionPolicy: true, secretScan: true, secretScanCallback: () => { scanCalled = true; return true; } } });
  assert.equal(scanCalled, false);
  assert.equal(result.remotePushAllowed, false); await rm(dir, { recursive: true, force: true }); store.close();
});

test("local git checkpoint is default-on and a failure keeps the authority generation published", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-git-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "checked" }, "L2");
  const enabled = await publishProjection(store, { engagementId: engagement_id, outputDir: dir });
  assert.notEqual(enabled.localGit.status, "disabled");
  if (enabled.localGit.status === "pending") assert.ok(enabled.localGit.reason, "a pending checkpoint records why it failed");
  const disabled = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  assert.equal(disabled.localGit.status, "disabled");
  assert.match(await readFile(join(dir, "current", "STATE.md"), "utf8"), /checked/);
  assert.equal(store.verifyAudit().valid, true);
  await rm(dir, { recursive: true, force: true }); store.close();
});

test("reader pins keep a published generation alive across republication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-pin-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "pinned" }, "L2");
  const first = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  const request = { principalId: "reader", engagementId: engagement_id, outputDir: dir, generation: first.generation, file: "STATE.md" };
  await pinProjection(request, () => true);
  const second = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  assert.deepEqual(second.pinned_generations, [first.generation], "publication reports the reader-pinned generation");
  assert.match(await readProjection(request, () => true), /pinned/, "a pinned generation stays readable after republication");
  await unpinProjection(dir, first.generation);
  const third = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  assert.deepEqual(third.pinned_generations, [], "a released generation is no longer pinned");
  await rm(dir, { recursive: true, force: true }); store.close();
});
