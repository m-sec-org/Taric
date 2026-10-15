import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthorityStore, ContractValidationError, uuidv7 } from "../dist/index.js";

test("display ids are allocated once and idempotency is request-bound", async () => {
  const store = new AuthorityStore();
  const engagement = uuidv7();
  const first = (await store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", proposition: "safe" }, "L1", "key", { operation: "capture", principal: "worker-a", engagement_id: engagement }));
  assert.match(String(first.display_id), /^TAR-\d{6}$/);
  (await assert.rejects(async () => (await store.commit({ id: first.id, engagement_id: engagement, kind: "claim", proposition: "unguarded" })), /expected version/i, "existing canonical records require an explicit CAS version"));
  assert.equal((await store.commit({ id: first.id, engagement_id: engagement, kind: "claim", proposition: "changed" }, "L1", undefined, { expected_version: first.version })).display_id, first.display_id);
  assert.deepEqual((await store.commit({ id: first.id, engagement_id: engagement, kind: "claim", proposition: "safe" }, "L1", "key", { operation: "capture", principal: "worker-a", engagement_id: engagement })), first);
  (await assert.rejects(async () => (await store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", proposition: "different" }, "L1", "key", { operation: "capture", principal: "worker-a", engagement_id: engagement })), ContractValidationError));
  (await assert.rejects(async () => (await store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", display_id: "TAR-999999" }, "L1")), ContractValidationError));
  (await store.close());
});

test("as-of snapshots remain fixed and doctor reports pending outbox", async () => {
  const store = new AuthorityStore();
  const engagement = uuidv7();
  const first = (await store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", proposition: "before" }));
  const old = (await store.snapshot(engagement, { asOf: first.commit_seq, includeCandidates: true }));
  assert.equal(typeof old.committed_seq, "number");
  assert.equal(typeof old.projected_seq, "number");
  (await store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", proposition: "after" }));
  assert.equal(old.records.length, 1);
  assert.equal((await store.snapshot(engagement, { includeCandidates: true })).records.length, 2);
  assert.ok((await store.doctor()).pending_outbox > 0);
  const exported = (await store.exportSnapshot(engagement, old.read_seq));
  assert.equal(exported.records.length, 1);
  assert.equal(exported.committed_seq >= exported.read_seq, true);
  assert.equal(exported.projected_seq <= exported.read_seq, true);
  (await store.close());
});

test("unversioned authority files fail before writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-schema-"));
  const filename = join(directory, "authority.db");
  // A controlled legacy fixture has an authority table but no schema marker.
  const fixture = new DatabaseSync(filename);
  fixture.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE records (id TEXT PRIMARY KEY)");
  fixture.close();
  const incompatible = new AuthorityStore(filename);
  try { await assert.rejects(incompatible.events(), ContractValidationError); }
  finally { await incompatible.close(); }
  await rm(directory, { recursive: true, force: true });
});
