import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

test("event commits create operation markers atomically and outbox consumption advances them", async () => {
  const store = new AuthorityStore();
  const record = (await store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "marker" }));
  const event = (await store.events()).find((item) => item.commit_seq === record.commit_seq);
  const marker = (await store.operationMarkers()).find((item) => item.commit_seq === record.commit_seq);

  assert.equal(marker.event_id, event.event_id);
  assert.equal(marker.kind, event.event_type);
  assert.match(marker.input_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(marker.status, "pending");
  assert.equal((await store.doctor()).projected_seq, 0);
  assert.equal((await store.doctor()).authority.valid, true);

  assert.equal((await store.consumeOutbox()).length, 1);
  assert.equal((await store.operationMarkers()).find((item) => item.commit_seq === record.commit_seq).status, "indexed");
  assert.equal((await store.doctor()).projected_seq, record.commit_seq);
  assert.equal((await store.doctor()).valid, true);
  (await store.close());
});

test("audit recovery is operator-only, previews without mutation, and replays failed markers explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-doctor-replay-"));
  const filename = join(directory, "authority.db");
  const firstStore = new AuthorityStore(filename);
  (await firstStore.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "recover" }));
  const originalEvent = (await firstStore.events())[0];
  (await firstStore.markOperationFailed((await firstStore.operationMarkers())[0].operation_id, "projection interrupted", "operator-a"));
  (await firstStore.close());

  const store = new AuthorityStore(filename);
  const service = (await createCoreService(store));
  const model = createPrincipal("model", "model-a");
  const writer = createPrincipal("writer", "writer-a");
  const operator = createPrincipal("operator", "operator-a");
  assert.equal((await service.dispatch("audit.reconcile", model, { action: "preview" })).error.code, "authorization_error");
  assert.equal((await service.dispatch("audit.reconcile", writer, { action: "replay" })).error.code, "authorization_error");

  const beforePreview = (await store.events()).length;
  const preview = (await service.dispatch("audit.reconcile", operator, { action: "preview" }));
  assert.equal(preview.ok, true);
  assert.equal(preview.data.action, "preview");
  assert.equal(preview.data.failed_markers, 1);
  assert.equal((await store.events()).length, beforePreview, "preview does not append recovery history");

  const replay = (await service.dispatch("audit.reconcile", operator, { action: "replay" }));
  assert.equal(replay.ok, true);
  assert.equal(replay.data.action, "replay");
  assert.equal(replay.data.recovered, 1);
  assert.equal((await store.events())[0].hash, originalEvent.hash, "recovery preserves the committed event history");
  assert.equal((await store.operationMarkers())[0].status, "recovered");
  assert.equal((await store.doctor()).audit.valid, true);
  assert.equal((await store.doctor()).pending_outbox, 0);
  (await store.close());
  await rm(directory, { recursive: true, force: true });
});

test("doctor detects missing derived rows and explicit rebuild repairs only those views", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-doctor-rebuild-"));
  const filename = join(directory, "authority.db");
  const initial = new AuthorityStore(filename);
  const record = (await initial.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "rebuild" }));
  const originalEvents = (await initial.events());
  (await initial.close());

  const fixture = new DatabaseSync(filename);
  fixture.prepare("DELETE FROM outbox WHERE commit_seq=?").run(record.commit_seq);
  fixture.prepare("DELETE FROM operation_markers WHERE commit_seq=?").run(record.commit_seq);
  fixture.close();

  const store = new AuthorityStore(filename);
  const before = (await store.doctor());
  assert.equal(before.authority.valid, true);
  assert.equal(before.derived.valid, false);
  assert.match(before.errors.join(" "), /no outbox row/);
  assert.match(before.errors.join(" "), /no operation marker/);

  const rebuilt = (await (await createCoreService(store)).dispatch("audit.reconcile", createPrincipal("operator", "operator-a"), { action: "rebuild" }));
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.data.rebuilt_outbox, 1);
  assert.equal(rebuilt.data.rebuilt_markers, 1);
  assert.deepEqual((await store.events()).slice(0, originalEvents.length).map((event) => event.hash), originalEvents.map((event) => event.hash));
  assert.equal((await store.get(record.id)).proposition, "rebuild");
  assert.equal((await store.doctor()).valid, true);
  (await store.close());
  await rm(directory, { recursive: true, force: true });
});

test("startup doctor blocks writes when authoritative display counter drifts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-doctor-counter-"));
  const filename = join(directory, "authority.db");
  const initial = new AuthorityStore(filename);
  (await initial.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "counter" }));
  (await initial.close());

  const fixture = new DatabaseSync(filename);
  fixture.prepare("UPDATE metadata SET value='1' WHERE key='display_sequence'").run();
  fixture.close();

  const store = new AuthorityStore(filename);
  const report = (await store.doctor());
  assert.equal(report.authority.valid, false);
  assert.match(report.authority.errors.join(" "), /display counter drift/);
  assert.equal((await store.previewRecovery()).authority_valid, false);
  (await assert.rejects(async () => (await store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "blocked" })), /authority drift blocks writes/));
  (await store.close());
  await rm(directory, { recursive: true, force: true });
});
