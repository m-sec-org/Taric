import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, uuidv7, validateContract } from "../dist/index.js";

const sha = (letter = "a") => `sha256:${letter.repeat(64)}`;

test("resource revisions are immutable, variant-aware, and preserve the source observation", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const observation = store.commit({ id: uuidv7(), engagement_id, kind: "observation", statement: "GET / was observed" }, "L1");
  const first = store.createResourceRevision({ engagement_id, asset_type: "endpoint", identity: { origin: "https://example.test", route: "/users" }, method: "GET", path: "/users", content_hash: sha(), source_observation_refs: [observation.id] });
  const second = store.createResourceRevision({ engagement_id, resource_id: first.resource.id, variant: { method: "GET", path_template: "/users", content_type: "application/json" }, content_hash: sha("b"), source_observation_refs: [observation.id] });
  assert.equal(first.revision.revision, 1);
  assert.equal(second.revision.revision, 2);
  assert.equal(second.revision.supersedes, first.revision.id);
  assert.equal(store.get(first.revision.id).content_hash, sha());
  const { commit_seq, ...revision } = second.revision;
  validateContract("resourceRevision", revision);
  store.close();
});

test("three-way patch merge combines independent fields and queues overlapping conflict evidence", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const record = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "original", title: "Original" }, "L1");
  const evidence = store.commit({ id: uuidv7(), engagement_id, kind: "observation", statement: "patch source" }, "L1");
  const base = store.get(record.id);
  const merged = store.applyPatchSet({ engagement_id, base_generation: record.commit_seq, base_versions: { [record.id]: record.version }, read_set: [record.id], write_set: [record.id], source_observation_refs: [evidence.id], operations: [{ op: "replace", entity_id: record.id, base, changes: { title: "Updated" } }] });
  assert.equal(merged.status, "merged");
  const current = store.get(record.id);
  const conflict = store.applyPatchSet({ engagement_id, base_generation: record.commit_seq, base_versions: { [record.id]: record.version }, read_set: [record.id], write_set: [record.id], source_observation_refs: [evidence.id], operations: [{ op: "replace", entity_id: record.id, base, changes: { title: "Conflicting" } }] });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].subject_ref, record.id);
  assert.equal(store.get(record.id).title, current.title);
  store.close();
});

test("impact traversal returns a continuation and marks only explicit dependents stale", () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const source = store.commit({ id: uuidv7(), engagement_id, kind: "resource", asset_type: "endpoint", identity: { route: "/" }, revision: 1 }, "L1");
  const claim = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "depends", resource_ref: source.id, status: "proposed", evidence_refs: [], limitations: [] }, "L1");
  const unrelated = store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "unrelated", status: "proposed", evidence_refs: [], limitations: [] }, "L1");
  const first = store.impact(source.id, { engagement_id, limit: 1 });
  assert.ok(first.continuation);
  const second = store.impact(source.id, { engagement_id, limit: 10, continuation: first.continuation });
  assert.ok([...first.affected_ids, ...second.affected_ids].includes(claim.id));
  assert.equal(store.get(unrelated.id).status, "proposed");
  store.close();
});

test("snapshot JSON and JSONL round-trip atomically and reject tampering", () => {
  const source = new AuthorityStore();
  const engagement_id = uuidv7();
  const scope_ref = uuidv7();
  source.commit({ id: scope_ref, engagement_id, kind: "scope", allowed_targets: ["https://example.test"], excluded_targets: [], rules_of_engagement_ref: "roe-1" }, "L2");
  source.commit({ id: engagement_id, engagement_id, kind: "engagement", name: "portable", scope_ref, status: "active" }, "L2");
  const record = source.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "portable", status: "proposed", evidence_refs: [], limitations: [] }, "L1");
  const snapshot = source.exportSnapshot(engagement_id);
  const target = new AuthorityStore();
  const result = target.importSnapshot(snapshot);
  assert.equal(result.imported_records, 3);
  assert.equal(target.get(record.id).proposition, "portable");
  const jsonlTarget = new AuthorityStore();
  const jsonlResult = jsonlTarget.importSnapshotJsonl(source.exportSnapshotJsonl(engagement_id));
  assert.equal(jsonlResult.integrity_verified, true);
  const before = target.snapshot(engagement_id, { includeCandidates: true }).records.length;
  assert.throws(() => target.importSnapshot({ ...snapshot, hash: sha("c") }));
  assert.equal(target.snapshot(engagement_id, { includeCandidates: true }).records.length, before);
  source.close(); target.close(); jsonlTarget.close();
});
