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
  const record = store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim" }, "L1");
  store.close();
  // Database access is confined to this corruption fixture; AuthorityStore exposes no handle.
  const fixture = new DatabaseSync(filename);
  fixture.prepare("UPDATE events SET payload=? WHERE subject_id=?").run("{\"tampered\":true}", record.id);
  fixture.close();
  const verifier = new AuthorityStore(filename);
  const result = verifier.verifyAudit();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("hash mismatch")));
  verifier.close();
  await rm(directory, { recursive: true, force: true });
});

test("snapshots pin an authority sequence and CAS rejects stale writes", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const record = store.commit({ id: uuidv7(), engagement_id, kind: "resource", name: "before" }, "L1");
  const snapshot = store.snapshot(engagement_id, { includeCandidates: true });
  store.compareAndSet(record.id, record.version, { name: "after" });
  assert.equal(snapshot.records[0].name, "before");
  assert.ok(snapshot.read_seq < store.snapshot(engagement_id, { includeCandidates: true }).read_seq);
  assert.throws(() => store.compareAndSet(record.id, record.version, { name: "conflict" }), /version conflict/);
  store.close();
});
