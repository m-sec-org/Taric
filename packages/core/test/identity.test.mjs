import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisplayIdAllocator, uuidv7 } from "../dist/index.js";
import { AuthorityStore } from "../dist/index.js";

test("uuidv7 is valid and timestamp ordered", () => {
  const a = uuidv7(1700000000000);
  const b = uuidv7(1700000000001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(a < b);
});

test("display IDs are installation-wide monotonic aliases", () => {
  const allocator = new DisplayIdAllocator(41);
  assert.deepEqual([allocator.next(), allocator.next(), allocator.next()], ["TAR-000041", "TAR-000042", "TAR-000043"]);
  assert.equal(allocator.nextSequence, 44);
});

test("separate authority connections atomically allocate one shared display sequence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taric-ids-"));
  const path = join(dir, "authority.sqlite");
  const a = new AuthorityStore(path);
  const b = new AuthorityStore(path);
  try {
    const engagement = uuidv7();
    const records = await Promise.all(Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() => (i % 2 ? a : b).commit({ id: uuidv7(), engagement_id: engagement, kind: "observation" }, "L1"))));
    const aliases = records.map((record) => record.display_id).sort();
    assert.equal(new Set(aliases).size, 40);
    assert.deepEqual(aliases, Array.from({ length: 40 }, (_, i) => `TAR-${String(i + 1).padStart(6, "0")}`));
  } finally {
    a.close(); b.close();
    await rm(dir, { recursive: true, force: true });
  }
});
