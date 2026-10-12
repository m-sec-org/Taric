import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthorityStore, ContractValidationError, uuidv7 } from "../dist/index.js";

test("display ids are allocated once and idempotency is request-bound", () => {
  const store = new AuthorityStore();
  const engagement = uuidv7();
  const first = store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", proposition: "safe" }, "L1", "key", { operation: "capture", principal: "worker-a", engagement_id: engagement });
  assert.match(String(first.display_id), /^TAR-\d{6}$/);
  assert.throws(() => store.commit({ id: first.id, engagement_id: engagement, kind: "claim", proposition: "unguarded" }), /expected version/i, "existing canonical records require an explicit CAS version");
  assert.equal(store.commit({ id: first.id, engagement_id: engagement, kind: "claim", proposition: "changed" }, "L1", undefined, { expected_version: first.version }).display_id, first.display_id);
  assert.deepEqual(store.commit({ id: first.id, engagement_id: engagement, kind: "claim", proposition: "safe" }, "L1", "key", { operation: "capture", principal: "worker-a", engagement_id: engagement }), first);
  assert.throws(() => store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", proposition: "different" }, "L1", "key", { operation: "capture", principal: "worker-a", engagement_id: engagement }), ContractValidationError);
  assert.throws(() => store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", display_id: "TAR-999999" }, "L1"), ContractValidationError);
  store.close();
});

test("as-of snapshots remain fixed and doctor reports pending outbox", () => {
  const store = new AuthorityStore();
  const engagement = uuidv7();
  const first = store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", proposition: "before" });
  const old = store.snapshot(engagement, { asOf: first.commit_seq, includeCandidates: true });
  assert.equal(typeof old.committed_seq, "number");
  assert.equal(typeof old.projected_seq, "number");
  store.commit({ id: uuidv7(), engagement_id: engagement, kind: "claim", proposition: "after" });
  assert.equal(old.records.length, 1);
  assert.equal(store.snapshot(engagement, { includeCandidates: true }).records.length, 2);
  assert.ok(store.doctor().pending_outbox > 0);
  const exported = store.exportSnapshot(engagement, old.read_seq);
  assert.equal(exported.records.length, 1);
  assert.equal(exported.committed_seq >= exported.read_seq, true);
  assert.equal(exported.projected_seq <= exported.read_seq, true);
  store.close();
});

test("unversioned authority files fail before writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-schema-"));
  const filename = join(directory, "authority.db");
  // A controlled legacy fixture has an authority table but no schema marker.
  const fixture = new DatabaseSync(filename);
  fixture.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE records (id TEXT PRIMARY KEY)");
  fixture.close();
  assert.throws(() => new AuthorityStore(filename), ContractValidationError);
  await rm(directory, { recursive: true, force: true });
});
