import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

test("event commits create operation markers atomically and outbox consumption advances them", () => {
  const store = new AuthorityStore();
  const record = store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "marker" });
  const event = store.events().find((item) => item.commit_seq === record.commit_seq);
  const marker = store.operationMarkers().find((item) => item.commit_seq === record.commit_seq);

  assert.equal(marker.event_id, event.event_id);
  assert.equal(marker.kind, event.event_type);
  assert.match(marker.input_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(marker.status, "pending");
  assert.equal(store.doctor().projected_seq, 0);
  assert.equal(store.doctor().authority.valid, true);

  assert.equal(store.consumeOutbox().length, 1);
  assert.equal(store.operationMarkers().find((item) => item.commit_seq === record.commit_seq).status, "indexed");
  assert.equal(store.doctor().projected_seq, record.commit_seq);
  assert.equal(store.doctor().valid, true);
  store.close();
});

test("audit recovery is operator-only, previews without mutation, and replays failed markers explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-doctor-replay-"));
  const filename = join(directory, "authority.db");
  const firstStore = new AuthorityStore(filename);
  firstStore.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "recover" });
  const originalEvent = firstStore.events()[0];
  firstStore.markOperationFailed(firstStore.operationMarkers()[0].operation_id, "projection interrupted", "operator-a");
  firstStore.close();

  const store = new AuthorityStore(filename);
  const service = createCoreService(store);
  const model = createPrincipal("model", "model-a");
  const writer = createPrincipal("writer", "writer-a");
  const operator = createPrincipal("operator", "operator-a");
  assert.equal(service.dispatch("audit.reconcile", model, { action: "preview" }).error.code, "authorization_error");
  assert.equal(service.dispatch("audit.reconcile", writer, { action: "replay" }).error.code, "authorization_error");

  const beforePreview = store.events().length;
  const preview = service.dispatch("audit.reconcile", operator, { action: "preview" });
  assert.equal(preview.ok, true);
  assert.equal(preview.data.action, "preview");
  assert.equal(preview.data.failed_markers, 1);
  assert.equal(store.events().length, beforePreview, "preview does not append recovery history");

  const replay = service.dispatch("audit.reconcile", operator, { action: "replay" });
  assert.equal(replay.ok, true);
  assert.equal(replay.data.action, "replay");
  assert.equal(replay.data.recovered, 1);
  assert.equal(store.events()[0].hash, originalEvent.hash, "recovery preserves the committed event history");
  assert.equal(store.operationMarkers()[0].status, "recovered");
  assert.equal(store.doctor().audit.valid, true);
  assert.equal(store.doctor().pending_outbox, 0);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("doctor detects missing derived rows and explicit rebuild repairs only those views", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-doctor-rebuild-"));
  const filename = join(directory, "authority.db");
  const initial = new AuthorityStore(filename);
  const record = initial.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "rebuild" });
  const originalEvents = initial.events();
  initial.close();

  const fixture = new DatabaseSync(filename);
  fixture.prepare("DELETE FROM outbox WHERE commit_seq=?").run(record.commit_seq);
  fixture.prepare("DELETE FROM operation_markers WHERE commit_seq=?").run(record.commit_seq);
  fixture.close();

  const store = new AuthorityStore(filename);
  const before = store.doctor();
  assert.equal(before.authority.valid, true);
  assert.equal(before.derived.valid, false);
  assert.match(before.errors.join(" "), /no outbox row/);
  assert.match(before.errors.join(" "), /no operation marker/);

  const rebuilt = createCoreService(store).dispatch("audit.reconcile", createPrincipal("operator", "operator-a"), { action: "rebuild" });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.data.rebuilt_outbox, 1);
  assert.equal(rebuilt.data.rebuilt_markers, 1);
  assert.deepEqual(store.events().slice(0, originalEvents.length).map((event) => event.hash), originalEvents.map((event) => event.hash));
  assert.equal(store.get(record.id).proposition, "rebuild");
  assert.equal(store.doctor().valid, true);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("startup doctor blocks writes when authoritative display counter drifts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-doctor-counter-"));
  const filename = join(directory, "authority.db");
  const initial = new AuthorityStore(filename);
  initial.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "counter" });
  initial.close();

  const fixture = new DatabaseSync(filename);
  fixture.prepare("UPDATE metadata SET value='1' WHERE key='display_sequence'").run();
  fixture.close();

  const store = new AuthorityStore(filename);
  const report = store.doctor();
  assert.equal(report.authority.valid, false);
  assert.match(report.authority.errors.join(" "), /display counter drift/);
  assert.equal(store.previewRecovery().authority_valid, false);
  assert.throws(() => store.commit({ id: uuidv7(), engagement_id: uuidv7(), kind: "claim", proposition: "blocked" }), /authority drift blocks writes/);
  store.close();
  await rm(directory, { recursive: true, force: true });
});
