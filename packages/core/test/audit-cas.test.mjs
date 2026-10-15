import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, uuidv7 } from "../dist/index.js";

test("audit verification detects tampered event payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-audit-"));
  const filename = join(directory, "authority.db");
  const store = new AuthorityStore(filename);
  const record = (await store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim" }, "L1"));
  (await store.close());
  // Database access is confined to this corruption fixture; AuthorityStore exposes no handle.
  const fixture = new DatabaseSync(filename);
  fixture.prepare("UPDATE events SET payload=? WHERE subject_id=?").run("{\"tampered\":true}", record.id);
  fixture.close();
  const verifier = new AuthorityStore(filename);
  const result = (await verifier.verifyAudit());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("hash mismatch")));
  (await verifier.close());
  await rm(directory, { recursive: true, force: true });
});

test("snapshots pin an authority sequence and CAS rejects stale writes", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const record = (await store.commit({ id: uuidv7(), engagement_id, kind: "resource", name: "before" }, "L1"));
  const snapshot = (await store.snapshot(engagement_id, { includeCandidates: true }));
  (await store.compareAndSet(record.id, record.version, { name: "after" }));
  assert.equal(snapshot.records[0].name, "before");
  assert.ok(snapshot.read_seq < (await store.snapshot(engagement_id, { includeCandidates: true })).read_seq);
  (await assert.rejects(async () => (await store.compareAndSet(record.id, record.version, { name: "conflict" })), /version conflict/));
  (await store.close());
});
