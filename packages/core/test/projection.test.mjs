import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AuthorityStore, pinProjection, publishProjection, readProjection, unpinProjection, uuidv7 } from "../dist/index.js";
import { retryProjectionCheckpoint } from "../dist/projection.js";
const execFileAsync = promisify(execFile);

test("projection allowlist excludes sensitive fields and publishes complete files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  (await store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "test", token: "secret", secret_ref: "vault://secret", private_path: "/tmp/private", artifact_body: "raw", draft_body: "sensitive draft" }, "L2"));
  (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "unreviewed canary", status: "proposed", evidence_refs: [], limitations: [] } }));
  const result = await publishProjection(store, { engagementId: engagement_id, outputDir: dir });
  const body = await readFile(join(dir, "current", "STATE.md"), "utf8");
  assert.equal(result.remotePushAllowed, false); assert.match(body, /test/); assert.doesNotMatch(body, /secret|private|raw|unreviewed canary|sensitive draft/);
  assert.equal(result.manifest.authority_sequence, result.manifest.projected_watermark);
  assert.ok(result.manifest.files["STATE.md"].startsWith("sha256:"));
  assert.deepEqual(result.manifest.entity_ids, (await store.snapshot(engagement_id)).records.filter((record) => record.trust_level === "L2").map((record) => record.id));
  assert.ok(result.manifest.policy_digest.startsWith("sha256:"));
  const manifestContents = await readFile(join(dir, result.generation, "manifest.json"), "utf8");
  assert.equal(JSON.parse(manifestContents).manifest_hash, result.manifest.manifest_hash);
  assert.equal(result.localGit.authority_sequence, result.manifest.authority_sequence);
  assert.equal(result.localGit.manifest_hash, result.manifest.manifest_hash);
  const request = { principalId: "worker", engagementId: engagement_id, outputDir: dir, generation: result.generation, file: "STATE.md" };
  await assert.rejects(async () => (await readProjection(request, () => false)), /permission denied/);
  assert.match(await readProjection(request, (principal, engagement) => principal === "worker" && engagement === engagement_id), /Engagement Brief/);
  const next = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  assert.notEqual(next.generation, result.generation);
  assert.match(await readProjection(request, () => true), /Engagement Brief/, "the previous immutable generation remains readable");
  await assert.rejects(async () => (await readProjection({ ...request, engagementId: uuidv7() }, () => true)), /permission denied/);
  await assert.rejects(async () => (await readProjection({ ...request, file: "../../authority.db" }, () => true)), /path denied/);
  await rm(dir, { recursive: true, force: true }); (await store.close());
});

test("remote push requires all explicit safeguards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  let scanCalled = false; let pushCalled = false;
  const config = { repository: "https://example.invalid/private.git", privateRepository: true, accessControl: true, retentionPolicy: "30 days", authorizeRemotePush: () => false, secretScanCallback: () => { scanCalled = true; return { passed: true, scanner_tool_version: "scanner/1", result_hash: "sha256:result" }; }, pushCallback: () => { pushCalled = true; return true; } };
  const result = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, remote: config });
  assert.equal(scanCalled, false, "a negative Engagement authorization prevents scanning and pushing");
  assert.equal(pushCalled, false);
  assert.equal(result.remote.status, "blocked");
  assert.equal(result.remotePushAllowed, false);
  await rm(dir, { recursive: true, force: true }); (await store.close());
});

test("remote push needs explicit Engagement authorization and a versioned real scan result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-remote-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  let scans = 0; let pushes = 0;
  const scanHash = `sha256:${"a".repeat(64)}`;
  const remote = {
    repository: "https://example.invalid/private.git",
    privateRepository: true,
    accessControl: true,
    retentionPolicy: "30 days",
    authorizeRemotePush: (id) => id === engagement_id,
    secretScanCallback: (input) => { scans++; assert.equal(input.engagementId, engagement_id); return { passed: true, scanner_tool_version: "scanner/2.1", result_hash: scanHash }; },
    pushCallback: (input) => { pushes++; assert.equal(input.scan.scanner_tool_version, "scanner/2.1"); return { pushed: true }; },
  };
  const pushed = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, remote, localGit: false });
  assert.equal(pushed.remotePushAllowed, true);
  assert.equal(pushed.remote.status, "pushed");
  assert.equal(pushed.remote.scan.result_hash, scanHash);
  assert.equal(pushed.remote.configuration.private_repository, true);
  assert.equal(scans, 1); assert.equal(pushes, 1);
  const checkpoint = JSON.parse(await readFile(join(dir, "checkpoints", `${pushed.generation}.json`), "utf8"));
  assert.equal(checkpoint.remote.scan.scanner_tool_version, "scanner/2.1");
  assert.equal(checkpoint.remote.scan.result_hash, scanHash);
  assert.equal(checkpoint.manifest_hash, pushed.manifest.manifest_hash);
  await rm(dir, { recursive: true, force: true }); (await store.close());
});

test("failed scanner or remote push never pushes and remains retryable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-retry-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  let pushes = 0; let scans = 0;
  const remote = {
    repository: "https://example.invalid/private.git", privateRepository: true, accessControl: true, retentionPolicy: "30 days",
    authorizeRemotePush: () => true,
    secretScanCallback: () => { scans++; return scans === 1 ? { passed: false, scanner_tool_version: "scanner/2.1", result_hash: `sha256:${"b".repeat(64)}` } : { passed: true, scanner_tool_version: "scanner/2.1", result_hash: `sha256:${"c".repeat(64)}` }; },
    pushCallback: () => { pushes++; return true; },
  };
  const first = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, remote, localGit: false });
  assert.equal(first.remote.status, "pending"); assert.equal(first.remote.retryable, true); assert.equal(pushes, 0);
  const retried = await retryProjectionCheckpoint({ outputDir: dir, generation: first.generation, localGit: false, remote });
  assert.equal(retried.remote.status, "pushed"); assert.equal(retried.remote.scan.result_hash, `sha256:${"c".repeat(64)}`); assert.equal(pushes, 1);
  const pushFailureRemote = { ...remote, pushCallback: () => { throw new Error("temporary network error"); } };
  const failedPush = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, remote: pushFailureRemote, localGit: false });
  assert.equal(failedPush.remote.status, "pending"); assert.equal(failedPush.remote.retryable, true); assert.equal(pushes, 1);
  await rm(dir, { recursive: true, force: true }); (await store.close());
});

test("local git checkpoint is default-on and a failure keeps the authority generation published", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-git-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  (await store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "checked" }, "L2"));
  const enabled = await publishProjection(store, { engagementId: engagement_id, outputDir: dir });
  assert.notEqual(enabled.localGit.status, "disabled");
  if (enabled.localGit.status === "pending") assert.ok(enabled.localGit.reason, "a pending checkpoint records why it failed");
  const disabled = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  assert.equal(disabled.localGit.status, "disabled");
  assert.match(await readFile(join(dir, "current", "STATE.md"), "utf8"), /checked/);
  assert.equal((await store.verifyAudit()).valid, true);
  await rm(dir, { recursive: true, force: true }); (await store.close());
});

test("a pending local Git checkpoint can be retried without changing its pinned generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-git-retry-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  (await store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "retry" }, "L2"));
  const pending = await publishProjection(store, { engagementId: engagement_id, outputDir: dir });
  assert.equal(pending.localGit.status, "pending");
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Taric Tests"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "taric-tests@example.invalid"], { cwd: dir });
  const retried = await retryProjectionCheckpoint({ outputDir: dir, generation: pending.generation, localGit: true });
  assert.equal(retried.local_git.status, "committed");
  assert.equal(retried.manifest_hash, pending.manifest.manifest_hash);
  assert.equal(retried.authority_sequence, pending.manifest.authority_sequence);
  const commitMessage = (await execFileAsync("git", ["log", "-1", "--format=%B"], { cwd: dir })).stdout;
  assert.match(commitMessage, new RegExp(`authority-sequence=${pending.manifest.authority_sequence}`));
  assert.match(commitMessage, new RegExp(`manifest-hash=${pending.manifest.manifest_hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const persisted = JSON.parse(await readFile(join(dir, "checkpoints", `${pending.generation}.json`), "utf8"));
  assert.equal(persisted.local_git.status, "committed");
  assert.equal((await store.verifyAudit()).valid, true);
  await rm(dir, { recursive: true, force: true }); (await store.close());
});

test("reader pins keep a published generation alive across republication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-pin-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  (await store.commit({ id: uuidv7(), engagement_id, kind: "finding", title: "pinned" }, "L2"));
  const first = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  const request = { principalId: "reader", engagementId: engagement_id, outputDir: dir, generation: first.generation, file: "STATE.md" };
  await pinProjection(request, () => true);
  const second = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  assert.deepEqual(second.pinned_generations, [first.generation], "publication reports the reader-pinned generation");
  assert.match(await readProjection(request, () => true), /pinned/, "a pinned generation stays readable after republication");
  await unpinProjection(dir, first.generation);
  const third = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  assert.deepEqual(third.pinned_generations, [], "a released generation is no longer pinned");
  await rm(dir, { recursive: true, force: true }); (await store.close());
});

test("reader rejects a changed generation manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-projection-integrity-")); const store = new AuthorityStore(); const engagement_id = uuidv7();
  const result = await publishProjection(store, { engagementId: engagement_id, outputDir: dir, localGit: false });
  const manifestPath = join(dir, result.generation, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { writeFile } = await import("node:fs/promises");
  manifest.authority_sequence += 1;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(async () => (await readProjection({ principalId: "reader", engagementId: engagement_id, outputDir: dir, generation: result.generation, file: "manifest.json" }, () => true)), /manifest integrity check failed/);
  await rm(dir, { recursive: true, force: true }); (await store.close());
});
