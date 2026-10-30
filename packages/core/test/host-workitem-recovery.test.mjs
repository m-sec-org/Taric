import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

test("active WorkRuns are discovered at a pinned sequence and resumed after local-authority restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-host-work-recovery-"));
  const filename = join(directory, "authority.sqlite");
  const contentRoot = join(directory, "content");
  const engagement_id = uuidv7();
  const owner = createPrincipal("host", "recovering-host", engagement_id);
  const workItems = Array.from({ length: 3 }, (_, index) => ({
    id: uuidv7(), engagement_id, kind: "work_item", title: `recovery item ${index}`,
    status: "queued", acceptance_criteria: ["resume from authority state"],
  }));
  let store;
  let service;
  try {
    store = new AuthorityStore(filename);
    service = await createCoreService(store, contentRoot);
    for (const item of workItems) await store.commit(item, "L2");
    const claims = [];
    for (const item of workItems) {
      const claim = await service.dispatch("work.claim", owner, { engagement_id, work_item_id: item.id, agent_id: "worker" });
      assert.equal(claim.ok, true, JSON.stringify(claim));
      claims.push(claim.data);
    }

    const first = await service.dispatch("work.query", owner, { engagement_id, page_size: 1, include_active_runs: true });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.has_more, true);
    const read_seq = first.data.read_seq;
    const firstCursor = first.data.next_cursor;
    await service.close();
    service = undefined;
    await store.close();
    store = undefined;

    // Persisted cursor keys and authority rows survive a fresh local Core instance.
    store = new AuthorityStore(filename);
    service = await createCoreService(store, contentRoot);
    const pages = [first.data];
    let cursor = firstCursor;
    for (let count = 0; cursor; count += 1) {
      assert.ok(count < workItems.length, "active-run query pagination must terminate");
      const page = await service.dispatch("work.query", owner, { engagement_id, page_size: 1, include_active_runs: true, cursor });
      assert.equal(page.ok, true, JSON.stringify(page));
      assert.equal(page.data.read_seq, read_seq, "continuation after restart retains the original pinned read sequence");
      pages.push(page.data);
      cursor = page.data.next_cursor;
    }
    assert.equal(pages.at(-1).has_more, false);
    const discovered = pages.flatMap((page) => page.items.map((item) => ({ item, run: item.active_run })));
    assert.equal(discovered.length, workItems.length);
    assert.equal(new Set(discovered.map(({ run }) => run.run_id)).size, workItems.length);
    for (const { item, run } of discovered) {
      assert.equal(item.kind, "work_item");
      assert.equal(typeof run.attempt_id, "string");
      assert.equal(run.owner_host, owner.id);
      assert.equal(Number.isSafeInteger(run.generation), true);
      assert.equal(claims.some((claim) => claim.run_id === run.run_id && claim.generation === run.generation && claim.attempt_ref === run.attempt_id), true);
    }

    for (const { run } of discovered) {
      const resumed = await service.dispatch("work.resume", owner, { engagement_id, work_run_id: run.run_id, host_id: "forged-body-host" });
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      assert.equal(resumed.data.run.run_id, run.run_id);
      assert.equal(resumed.data.run.generation, run.generation);
      assert.equal(resumed.data.run.attempt_ref, run.attempt_id);
      assert.equal(resumed.data.premise_checks.engagement, true);
      assert.equal(resumed.data.premise_checks.work_item, true);
      assert.equal(resumed.data.premise_checks.lease, true);
      assert.equal(resumed.data.blocked, true, "no checkpoint means Core conservatively requires replan");
      assert.equal(resumed.data.replan_required, true);
    }

    const stale = discovered[0].run;
    await store.sql.run("UPDATE work_runs SET lease_expires_at=? WHERE run_id=?", "2000-01-01T00:00:00.000Z", stale.run_id);
    await store.sql.run("UPDATE attempts SET lease_expires_at=? WHERE attempt_id=?", "2000-01-01T00:00:00.000Z", stale.attempt_id);
    const blocked = await service.dispatch("work.resume", owner, { engagement_id, work_run_id: stale.run_id });
    assert.equal(blocked.ok, true, JSON.stringify(blocked));
    assert.equal(blocked.data.premise_checks.lease, false);
    assert.equal(blocked.data.blocked, true);
    assert.equal(blocked.data.replan_required, true);
  } finally {
    await service?.close();
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
