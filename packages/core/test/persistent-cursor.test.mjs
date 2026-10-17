import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, buildContextPack, createCoreService, createPrincipal, rotateContextCursorKey } from "../dist/index.js";

const keyName = ".taric-context-cursor-key.v1";
async function continueInProcess(cwd, input) {
  const source = `
    import { AuthorityStore, buildContextPack } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const input = JSON.parse(process.env.TARIC_CURSOR_FIXTURE);
    const store = new AuthorityStore(input.filename);
    try {
      const page = await buildContextPack(store, input.engagement_id, input.budget, input.options);
      process.stdout.write(JSON.stringify(page));
    } finally { await store.close(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd, env: { ...process.env, TARIC_CURSOR_FIXTURE: JSON.stringify(input) }, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = []; const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`cursor process failed: ${Buffer.concat(stderr).toString("utf8")}`)));
  });
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}
async function fixture(directory, count = 12) {
  mkdirSync(directory, { recursive: true });
  const filename = join(directory, "authority.sqlite");
  const store = new AuthorityStore(filename);
  const engagement = (await store.initializeEngagement({ name: "pinned cursor", scope: { allowed_targets: ["https://cursor.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:authorized" } }));
  const records = (await Promise.all(Array.from({ length: count }, async (_, index) => (await store.createRecord({ engagement_id: engagement.id, kind: "claim", proposition: `original-${index} `.repeat(90), status: "proposed", evidence_refs: [], limitations: [] })))));
  return { store, filename, engagement_id: engagement.id, records, root: join(directory, "content") };
}
function decode(cursor, root) {
  const [, iv, body, tag] = cursor.split(".");
  const document = JSON.parse(readFileSync(join(root, keyName), "utf8"));
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(document.key, "base64url"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
}

test("persisted slim cursors survive restart and another instance with fixed versions and no omissions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-persistent-cursor-"));
  let active;
  try {
    const fixture_ = (await fixture(directory));
    active = fixture_.store;
    const { engagement_id, records, root, filename } = fixture_;
    const options = { principalId: "reader", filters: { kind: "claim" }, cursorKeyRoot: root, includeCandidates: true };
    const first = (await buildContextPack(active, engagement_id, 1100, options));
    assert.ok(first.cursor);
    const state = decode(first.cursor, root);
    assert.equal(Object.hasOwn(state, "records"), false);
    assert.equal(JSON.stringify(state).includes("original-"), false);
    assert.equal(state.read_seq, first.read_seq);
    assert.equal(statSync(join(root, keyName)).mode & 0o777, 0o600);
    const key = JSON.parse(readFileSync(join(root, keyName), "utf8"));
    assert.equal(key.version, 1);
    assert.equal(key.format, "taric-authority-cursor-key");
    assert.match(key.authority_digest, /^[a-f0-9]{64}$/);

    const changed = (await records.at(-1));
    (await active.commit({ ...changed, proposition: "later mutation" }, "L1", undefined, undefined, true, changed.version));
    (await active.createRecord({ engagement_id, kind: "claim", proposition: "new after cursor", status: "proposed", evidence_refs: [], limitations: [] }));
    (await active.close());
    active = new AuthorityStore(filename);
    const other = new AuthorityStore(filename);
    try {
      const ids = first.items.map((record) => record.id);
      let cursor = first.cursor;
      let pageCount = 0;
      while (cursor) {
        const page = (await buildContextPack(pageCount++ % 2 ? active : other, engagement_id, 1100, { ...options, cursor }));
        assert.equal(page.read_seq, first.read_seq);
        assert.equal(page.context_snapshot_id, first.context_snapshot_id);
        assert.ok(page.items.every((record) => record.version === 1));
        ids.push(...page.items.map((record) => record.id));
        cursor = page.cursor;
        assert.ok(pageCount <= records.length);
      }
      assert.equal(new Set(ids).size, ids.length);
      assert.deepEqual([...ids].sort(), records.map((record) => record.id).sort());
    } finally { (await other.close()); }
  } finally { (await active?.close()); rmSync(directory, { recursive: true, force: true }); }
});

test("cursor binding includes principal, Engagement, filters, ordering, budget, and fixed sequence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-cursor-bindings-"));
  const { store, root, engagement_id } = (await fixture(directory));
  try {
    const options = { principalId: "reader", filters: { kind: "claim" }, workItemId: "task", workerRole: "observer", policyVersion: "policy/2", ordering: "scope,work_item,checkpoint,delta,direct,entity_evidence,background", cursorKeyRoot: root, includeCandidates: true };
    const first = (await buildContextPack(store, engagement_id, 1100, options));
    const invalid = async (changes = {}, id = engagement_id, budget = 1100) => (await assert.rejects(async () => (await buildContextPack(store, id, budget, { ...options, cursor: first.cursor, ...changes })), (cause) => cause.code === "invalid_cursor"));
    (await invalid({ principalId: "other" }));
    (await invalid({}, "foreign-engagement"));
    (await invalid({ filters: {} }));
    (await invalid({ ordering: "other-order" }));
    (await invalid({}, engagement_id, 1200));
    (await invalid({ readSeq: first.read_seq - 1 }));
    (await invalid({ workItemId: "other-task" }));
    (await invalid({ workerRole: "other-role" }));
    (await invalid({ policyVersion: "policy/3" }));
    (await invalid({ includeCandidates: false }));
    (await invalid({ scanBudget: 3 }));
    const parts = first.cursor.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    (await invalid({ cursor: parts.join(".") }));
    const service = (await createCoreService(store, root));
    const principal = createPrincipal("model", "reader", engagement_id);
    const response = (await service.buildContext(principal, { engagement_id, cursor: "corrupt" }));
    assert.equal(response.error.code, "invalid_cursor");
    assert.ok(!response.error.message.includes(directory));
  } finally { (await store.close()); rmSync(directory, { recursive: true, force: true }); }
});

test("missing, invalid-permission, rotated, and copied keys reject existing cursors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-cursor-keys-"));
  const { store, root, engagement_id } = (await fixture(directory));
  try {
    const options = { principalId: "reader", cursorKeyRoot: root, filters: { kind: "claim" }, includeCandidates: true };
    const first = (await buildContextPack(store, engagement_id, 1100, options));
    const path = join(root, keyName);
    chmodSync(path, 0o644);
    (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 1100, { ...options, cursor: first.cursor })), (cause) => cause.code === "invalid_cursor"));
    chmodSync(path, 0o600);
    unlinkSync(path);
    (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 1100, { ...options, cursor: first.cursor })), (cause) => cause.code === "invalid_cursor"));
    const second = (await buildContextPack(store, engagement_id, 1100, options));
    assert.ok(second.cursor);
    (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 1100, { ...options, cursor: first.cursor })), (cause) => cause.code === "invalid_cursor"));
    const previousKey = JSON.parse(readFileSync(path, "utf8")).key_id;
    const rotated = rotateContextCursorKey(root, store.authorityId);
    assert.notEqual(rotated.key_id, previousKey);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    (await assert.rejects(async () => (await buildContextPack(store, engagement_id, 1100, { ...options, cursor: second.cursor })), (cause) => cause.code === "invalid_cursor"));
    const foreign = (await fixture(join(directory, "foreign")));
    try {
      (await buildContextPack(foreign.store, foreign.engagement_id, 1100, { ...options, cursorKeyRoot: foreign.root }));
      copyFileSync(path, join(foreign.root, keyName));
      (await assert.rejects(async () => (await buildContextPack(foreign.store, foreign.engagement_id, 1100, { ...options, cursorKeyRoot: foreign.root })), (cause) => cause.code === "invalid_cursor"));
    } finally { (await foreign.store.close()); }
  } finally { (await store.close()); rmSync(directory, { recursive: true, force: true }); }
});

test("cursor continues in fresh processes with different working directories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-cursor-cwd-"));
  const { store, root, engagement_id, filename, records } = await fixture(join(directory, "authority"), 5);
  try {
    const firstCwd = join(directory, "first-cwd"); const secondCwd = join(directory, "second-cwd");
    mkdirSync(firstCwd); mkdirSync(secondCwd);
    await store.close();
    const options = { principalId: "reader", cursorKeyRoot: root, filters: { kind: "claim" }, includeCandidates: true };
    const request = { filename, engagement_id, budget: 1100, options };
    const first = await continueInProcess(firstCwd, request);
    assert.ok(first.cursor);
    const ids = first.items.map((record) => record.id);
    let cursor = first.cursor; let pages = 0;
    while (cursor) {
      const page = await continueInProcess(pages++ % 2 ? firstCwd : secondCwd, { ...request, options: { ...options, cursor } });
      assert.equal(page.read_seq, first.read_seq);
      assert.equal(page.context_snapshot_id, first.context_snapshot_id);
      ids.push(...page.items.map((record) => record.id));
      cursor = page.cursor;
      assert.ok(pages <= records.length);
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids.toSorted(), records.map((record) => record.id).toSorted());
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("continuation retains stale dependency and delta ordering", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-cursor-order-"));
  const { store, root, engagement_id } = (await fixture(directory, 5));
  try {
    const baseline = (await store.snapshot(engagement_id, { includeCandidates: true })).read_seq;
    const stale = (await store.createRecord({ engagement_id, kind: "claim", proposition: "stale dependency", status: "proposed", evidence_refs: [], limitations: [] }));
    (await store.markStale(stale.id, "dependency changed"));
    const options = { principalId: "reader", cursorKeyRoot: root, filters: { kind: "claim" }, includeCandidates: true };
    const first = (await buildContextPack(store, engagement_id, 1100, { ...options, resumeFromSeq: baseline }));
    assert.ok(first.cursor);
    const seen = first.items.map((record) => record.id);
    let cursor = first.cursor;
    while (cursor) {
      const next = (await buildContextPack(store, engagement_id, 1100, { ...options, cursor }));
      seen.push(...next.items.map((record) => record.id));
      cursor = next.cursor;
      assert.ok(seen.length <= 6);
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.ok(seen.includes(stale.id));
    assert.equal(seen.length, 6);
  } finally { (await store.close()); rmSync(directory, { recursive: true, force: true }); }
});

test("continuation uses the first page's expiry decision rather than event creation time", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-context-expiry-"));
  const { store, root, engagement_id, records } = (await fixture(directory, 5));
  try {
    const expired = (await store.createRecord({ engagement_id, kind: "claim", proposition: "expired before first page", status: "proposed", evidence_refs: [], limitations: [], expires_at: new Date(Date.now() + 30).toISOString() }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const options = { principalId: "reader", cursorKeyRoot: root, filters: { kind: "claim" }, includeCandidates: true };
    const first = (await buildContextPack(store, engagement_id, 1100, options));
    const seen = first.items.map((record) => record.id);
    let cursor = first.cursor;
    while (cursor) {
      const next = (await buildContextPack(store, engagement_id, 1100, { ...options, cursor }));
      seen.push(...next.items.map((record) => record.id));
      cursor = next.cursor;
      assert.ok(seen.length <= records.length);
    }
    assert.equal(seen.includes(expired.id), false);
    assert.deepEqual(seen.toSorted(), records.map((record) => record.id).toSorted());
  } finally { (await store.close()); rmSync(directory, { recursive: true, force: true }); }
});
