import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";
import { operationContract } from "@taric/schemas";

const digest = `sha256:${"a".repeat(64)}`;
const scopeInput = { allowed_targets: ["https://example.test"], excluded_targets: [], rules_of_engagement_ref: "roe:fixture" };
const candidate = (engagement_id, overrides = {}) => ({ schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "candidate", status: "proposed", evidence_refs: [], limitations: [], ...overrides });
const envelope = (engagement_id, content = candidate(engagement_id), overrides = {}) => ({ engagement_id, subject_type: content.kind, expected_version: 0, content, ...overrides });
const state = async (store, engagement_id) => ({ proposals: (await store.proposals(engagement_id)), records: (await store.list(engagement_id, { includeCandidates: true })), events: (await store.events()) });

test("proposal boundary rejects malformed domain and privileged identity without state changes", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = (await service.init({ name: "hardening", scope: scopeInput })).data.id;
  const model = createPrincipal("model", "model-a", engagement_id);
  const before = (await state(store, engagement_id));
  const invalid = [
    envelope(engagement_id, candidate(engagement_id, { kind: undefined }), { subject_type: "claim" }),
    envelope(engagement_id, candidate(engagement_id, { proposition: undefined })),
    envelope(engagement_id, candidate(engagement_id), { subject_type: "finding" }),
    envelope(engagement_id, candidate(engagement_id, { id: uuidv7() })),
    envelope(engagement_id, candidate(engagement_id, { trust_level: "L2" })),
    envelope(engagement_id, candidate(engagement_id, { accept: true })),
    envelope(engagement_id, candidate(engagement_id, { unexpected: true })),
    envelope(engagement_id, candidate(engagement_id, { evidence_refs: [uuidv7()] })),
    envelope(engagement_id, candidate(uuidv7())),
    envelope(engagement_id, candidate(engagement_id, { provenance: { host_id: "pi", producer_id: "model", source_kind: "reviewer" } })),
  ];
  for (const request of invalid) {
    const result = (await service.dispatch("proposal.submit", model, request));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "validation_error");
    assert.deepEqual((await state(store, engagement_id)), before);
  }
  const incompatible = (await service.dispatch("proposal.submit", model, envelope(engagement_id, candidate(engagement_id, { schema_version: "99.0.0" }))));
  assert.equal(incompatible.error.code, "unsupported_schema_version");
  assert.deepEqual((await state(store, engagement_id)), before);
  (await store.close());
});

test("writer-owned creates, explicit updates, identity reuse and target conflicts preserve ownership", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const requestId = uuidv7();
  const proposal = (await store.submitProposal(envelope(engagement_id, candidate(engagement_id), { proposal_id: requestId, client_request_id: "scan-1" })));
  assert.equal(proposal.proposal_id, requestId);
  assert.equal("id" in proposal.content, false);
  assert.equal(proposal.canonical_id, undefined);
  const admitted = (await store.admitProposal(proposal.id, digest, { expectedBaseVersion: 0 }));
  assert.equal(admitted.ok, true);
  assert.notEqual(admitted.record.id, requestId);
  assert.match(admitted.record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
  const update = (await store.submitProposal(envelope(engagement_id, candidate(engagement_id, { proposition: "updated" }), { target_id: admitted.record.id, expected_version: 1 })));
  const committed = (await store.admitProposal(update.id, digest, { expectedBaseVersion: 1 }));
  assert.equal(committed.record.id, admitted.record.id);
  assert.equal(committed.record.version, 2);
  const before = (await state(store, engagement_id));
  const cases = [
    [envelope(engagement_id, candidate(engagement_id), { expected_version: 1 }), "validation_error"],
    [envelope(engagement_id, candidate(engagement_id), { target_id: uuidv7(), expected_version: 1 }), "validation_error"],
    [envelope(engagement_id, candidate(engagement_id), { target_id: admitted.record.id, expected_version: 1 }), "stale_version"],
    [envelope(uuidv7(), candidate(uuidv7()), { target_id: admitted.record.id, expected_version: 2 }), "validation_error"],
    [envelope(engagement_id, { schema_version: "1.0.0", engagement_id, kind: "work_item", title: "work", status: "queued", acceptance_criteria: ["done"] }, { target_id: admitted.record.id, expected_version: 2 }), "conflict"],
    [envelope(engagement_id, candidate(engagement_id), { proposal_id: admitted.record.id }), "conflict"],
  ];
  for (const [request, code] of cases) {
    (await assert.rejects(async () => (await store.submitProposal(request)), (error) => error.code === code));
    assert.deepEqual((await state(store, engagement_id)), before);
  }
  const otherEngagement = uuidv7();
  (await assert.rejects(async () => (await store.submitProposal(envelope(otherEngagement, candidate(otherEngagement), { target_id: admitted.record.id, expected_version: 2 }))), (error) => error.code === "conflict"));
  (await assert.rejects(async () => (await store.commit({ ...committed.record, engagement_id: otherEngagement, trust_level: undefined, display_id: undefined }, "L1", undefined, undefined, true, 2)), (error) => error.code === "conflict"));
  (await assert.rejects(async () => (await store.commit({ id: "legacy-1", engagement_id, kind: "note" })), (error) => error.code === "validation_error"));
  assert.deepEqual((await state(store, engagement_id)), before);
  (await store.close());
});

test("Core writer create retries retain one allocated identity and reject rebinding", async () => {
  const store = new AuthorityStore();
  const content = candidate(uuidv7());
  const first = (await store.createRecord(content, "L1", "create-1", { principal: "writer" }));
  assert.deepEqual((await store.createRecord(content, "L1", "create-1", { principal: "writer" })), first);
  (await assert.rejects(async () => (await store.createRecord({ ...content, proposition: "different" }, "L1", "create-1", { principal: "writer" })), (error) => error.code === "idempotency_conflict"));
  (await assert.rejects(async () => (await store.createRecord(content, "L2", "create-1", { principal: "writer" })), (error) => error.code === "idempotency_conflict"));
  assert.equal((await store.events()).filter((event) => event.event_type === "record.commit").length, 1);
  (await store.close());
});

test("public resource creation and patch upserts allocate IDs and reject caller identity reuse", async () => {
  const store = new AuthorityStore();
  const service = (await createCoreService(store));
  const engagement_id = (await service.init({ name: "evolution", scope: scopeInput })).data.id;
  const host = createPrincipal("host", "host", engagement_id);
  const observation = (await store.commit({ id: uuidv7(), engagement_id, kind: "observation", statement: "source" }, "L1"));
  const before = (await state(store, engagement_id));
  const revisionInput = { engagement_id, asset_type: "endpoint", identity: { route: "/resource" }, method: "GET", path: "/resource", content_hash: digest, source_observation_refs: [observation.id] };
  const invalidRevision = (await service.dispatch("resource.revise", host, { ...revisionInput, resource_id: uuidv7() }));
  assert.equal(invalidRevision.error.code, "validation_error");
  assert.deepEqual((await state(store, engagement_id)), before);
  const created = (await service.dispatch("resource.revise", host, revisionInput));
  assert.equal(created.ok, true);
  const resource = created.data.resource;
  const current = (await state(store, engagement_id));
  assert.equal((await service.dispatch("resource.revise", host, { ...revisionInput, resource_id: resource.id })).error.code, "stale_version");
  assert.equal((await service.dispatch("resource.revise", host, { ...revisionInput, resource_id: resource.id, expected_version: resource.version, identity: { route: "/different" } })).error.code, "conflict");
  assert.deepEqual((await state(store, engagement_id)), current);
  const other = (await store.createRecord({ schema_version: "1.0.0", engagement_id, kind: "resource", asset_type: "endpoint", identity: { route: "/other" }, revision: 1 }, "L1"));
  const relation = { engagement_id, from_ref: resource.id, to_ref: other.id, predicate: "calls", source_observation_refs: [observation.id] };
  const relationBefore = (await state(store, engagement_id));
  assert.equal((await service.dispatch("resource.relation", host, { ...relation, id: uuidv7() })).error.code, "validation_error");
  assert.deepEqual((await state(store, engagement_id)), relationBefore);
  const edge = (await service.dispatch("resource.relation", host, relation));
  assert.equal(edge.ok, true);
  assert.match(edge.data.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  const base_generation = (await store.snapshot(engagement_id, { includeCandidates: true })).read_seq;
  const upsert = { engagement_id, base_generation, read_set: [], write_set: [], source_observation_refs: [observation.id], operations: [{ op: "upsert", expected_version: 0, record: candidate(engagement_id) }] };
  const patchBefore = (await state(store, engagement_id));
  assert.equal((await service.dispatch("resource.patch", host, { ...upsert, operations: [{ ...upsert.operations[0], record: { ...upsert.operations[0].record, id: uuidv7() } }] })).error.code, "validation_error");
  assert.equal((await service.dispatch("resource.patch", host, { ...upsert, id: uuidv7() })).error.code, "validation_error");
  assert.deepEqual((await state(store, engagement_id)), patchBefore);
  const patched = (await service.dispatch("resource.patch", host, upsert));
  assert.equal(patched.ok, true);
  assert.match(patched.data.records[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.deepEqual((await store.get(patched.data.patch_id)).write_set, [{ entity_ref: patched.data.records[0].id, base_version: 0 }]);
  (await store.close());
});

async function findingCase(filename = ":memory:", findingOverrides = {}) {
  const store = new AuthorityStore(filename);
  const service = (await createCoreService(store));
  const engagement_id = (await service.init({ name: "finding", scope: scopeInput })).data.id;
  const scope = (await store.list(engagement_id)).find((record) => record.kind === "scope");
  const claim = (await store.createRecord(candidate(engagement_id), "L1"));
  const evidence = (await store.createRecord({ schema_version: "1.0.0", engagement_id, kind: "evidence", artifact_ref: { host_ref: "host:sample" }, observed_at: new Date().toISOString(), limitations: ["synthetic"] }, "L1"));
  const model = createPrincipal("model", "author", engagement_id);
  const operator = createPrincipal("operator", "operator", engagement_id);
  const submitted = (await service.dispatch("proposal.submit", model, envelope(engagement_id, { schema_version: "1.0.0", engagement_id, kind: "finding", title: "finding", claim_refs: [claim.id], evidence_refs: [evidence.id], applicable_scope_ref: scope.id, status: "draft", limitations: ["synthetic"], reproducibility: "repeat", ...findingOverrides })));
  assert.equal(submitted.ok, true);
  const proposal = submitted.data;
  const admission = (await service.dispatch("admission.evaluate", operator, { engagement_id, proposal_id: proposal.id, expected_version: 0, policy_digest: digest }));
  assert.equal(admission.ok, true);
  assert.equal(admission.data.trust_phase, "machine_approved");
  assert.ok(admission.data.remaining_l2_requirements.includes("independent_review"));
  assert.equal("gates" in admission.data, false);
  const reviewer = createPrincipal("reviewer", "independent-reviewer", engagement_id);
  const reviewPack = (await service.dispatch("review.pack", operator, { engagement_id, proposal_id: proposal.id }));
  assert.equal(reviewPack.ok, true);
  const review = (await service.dispatch("review.submit", reviewer, { engagement_id, proposal_id: proposal.id, reviewer_id: reviewer.id, reviewer_kind: "reviewer", input_hash: proposal.content_hash, evidence_snapshot_hash: reviewPack.data.evidence_snapshot_hash, policy_digest: digest, verdict: "pass" }));
  assert.equal(review.ok, true);
  const request = { engagement_id, proposal_id: proposal.id, target_id: admission.data.record.id, expected_version: admission.data.record.version, input_hash: proposal.content_hash, evidence_snapshot_hash: review.data.evidence_snapshot_hash, policy_digest: digest, review_refs: [review.data.id] };
  return { store, service, engagement_id, proposal, model, operator, reviewer, evidence, admission, request };
}

test("L1 admits incomplete evidence honestly and ordinary recall omits machine candidates", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const claim = (await store.createRecord(candidate(engagement_id), "L1"));
  const proposal = (await store.submitProposal(envelope(engagement_id, { schema_version: "1.0.0", engagement_id, kind: "finding", title: "awaiting evidence", status: "draft", claim_refs: [claim.id], evidence_refs: [], limitations: ["awaiting evidence"] })));
  assert.equal(proposal.status, "pending");
  const result = (await store.admitProposal(proposal.id, digest));
  assert.equal(result.ok, true);
  assert.equal(result.trust_phase, "machine_approved");
  assert.equal(result.record.provenance.source_kind, "host");
  assert.ok(result.policy_version);
  assert.ok(result.remaining_l2_requirements.includes("evidence"));
  assert.equal((await store.list(engagement_id)).length, 0);
  assert.equal((await store.list(engagement_id, { includeCandidates: true })).length, 2);
  (await store.close());
});

test("explicit L2 promotion denies model, host and reviewer; binds inputs and atomically promotes", async () => {
  const f = (await findingCase());
  assert.deepEqual(operationContract("admission.promote_l2").roles, ["writer", "operator"]);
  const before = (await state(f.store, f.engagement_id));
  for (const principal of [f.model, createPrincipal("host", "host", f.engagement_id), f.reviewer]) {
    assert.equal((await f.service.dispatch("admission.promote_l2", principal, f.request)).error.code, "authorization_error");
    assert.deepEqual((await state(f.store, f.engagement_id)), before);
  }
  for (const [patch, code] of [[{ expected_version: 2 }, "stale_version"], [{ input_hash: `sha256:${"b".repeat(64)}` }, "conflict"], [{ evidence_snapshot_hash: `sha256:${"c".repeat(64)}` }, "stale_version"]]) {
    assert.equal((await f.service.dispatch("admission.promote_l2", f.operator, { ...f.request, ...patch })).error.code, code);
    assert.deepEqual((await state(f.store, f.engagement_id)), before);
  }
  const writer = createPrincipal("writer", "writer", f.engagement_id);
  const promoted = (await f.service.dispatch("admission.promote_l2", writer, { ...f.request, idempotency_key: "promote-1" }));
  assert.equal(promoted.ok, true);
  assert.equal(promoted.data.trust_phase, "independently_verified");
  assert.equal(promoted.data.record.id, f.request.target_id);
  assert.equal(promoted.data.record.trust_level, "L2");
  assert.deepEqual((await f.service.dispatch("admission.promote_l2", writer, { ...f.request, idempotency_key: "promote-1" })), promoted);
  assert.equal((await f.store.events()).filter((event) => event.event_type === "proposal.promote_l2").length, 1);
  (await f.store.close());
});

test("changed evidence and superseded L1 target cannot reuse a fixed review", async () => {
  const f = (await findingCase());
  (await f.store.compareAndSet(f.evidence.id, f.evidence.version, { statement: "changed evidence" }));
  const before = (await state(f.store, f.engagement_id));
  assert.equal((await f.service.dispatch("admission.promote_l2", f.operator, f.request)).error.code, "stale_version");
  assert.deepEqual((await state(f.store, f.engagement_id)), before);
  (await f.store.compareAndSet(f.request.target_id, f.request.expected_version, { title: "updated finding" }));
  const latest = (await state(f.store, f.engagement_id));
  assert.equal((await f.service.dispatch("admission.promote_l2", f.operator, { ...f.request, expected_version: 2 })).error.code, "stale_version");
  assert.deepEqual((await state(f.store, f.engagement_id)), latest);
  (await f.store.close());
});

test("high-risk review independence uses immutable transport attestation and rejects caller claims", async () => {
  const f = (await findingCase(":memory:", { risk_class: "high" }));
  const reviewInput = { engagement_id: f.engagement_id, proposal_id: f.proposal.id, reviewer_id: f.reviewer.id, reviewer_kind: "reviewer", input_hash: f.proposal.content_hash, evidence_snapshot_hash: f.request.evidence_snapshot_hash, policy_digest: digest, verdict: "pass" };
  const before = (await state(f.store, f.engagement_id));
  for (const fields of [{ reviewer_capability: "human" }, { reviewer_model: "different-model" }, { prompt_digest: digest }, { ruleset_digest: digest }]) {
    assert.equal((await f.service.dispatch("review.submit", f.reviewer, { ...reviewInput, ...fields })).error.code, "authorization_error");
    assert.deepEqual((await state(f.store, f.engagement_id)), before);
  }
  const attestation = { capability: "model", model: "same-model", prompt_digest: digest, ruleset_digest: digest };
  const reviewerB = createPrincipal("reviewer", "reviewer-b", f.engagement_id, [], attestation);
  const reviewerC = createPrincipal("reviewer", "reviewer-c", f.engagement_id, [], attestation);
  attestation.capability = "human";
  reviewerB.reviewer_attestation.capability = "human";
  const submit = async (principal) => (await f.service.dispatch("review.submit", principal, { ...reviewInput, reviewer_id: principal.id }));
  const b = (await submit(reviewerB)); const c = (await submit(reviewerC));
  assert.equal(b.ok, true); assert.equal(c.ok, true);
  const correlated = (await f.service.dispatch("admission.promote_l2", f.operator, { ...f.request, review_refs: [b.data.id, c.data.id] }));
  assert.equal(correlated.error.code, "validation_error");
  assert.match(correlated.error.message, /heterogeneous|identical/);
  assert.equal((await f.store.get(f.request.target_id)).trust_level, "L1");
  const reviewerD = createPrincipal("reviewer", "reviewer-d", f.engagement_id, [], { capability: "model", model: "different-model", prompt_digest: `sha256:${"b".repeat(64)}`, ruleset_digest: digest });
  const d = (await submit(reviewerD));
  const independent = (await f.service.dispatch("admission.promote_l2", f.operator, { ...f.request, review_refs: [b.data.id, d.data.id] }));
  assert.equal(independent.ok, true);
  assert.equal(independent.data.record.trust_level, "L2");
  (await f.store.close());
});

test("host patches cannot forge review fields or retain L2 after changing a verified finding", async () => {
  const f = (await findingCase());
  const promoted = (await f.service.dispatch("admission.promote_l2", f.operator, f.request));
  assert.equal(promoted.ok, true);
  const source = (await f.store.commit({ id: uuidv7(), engagement_id: f.engagement_id, kind: "observation", statement: "correction source" }, "L1"));
  const host = createPrincipal("host", "host", f.engagement_id);
  const record = (await f.store.get(f.request.target_id));
  const patch = { engagement_id: f.engagement_id, base_generation: (await f.store.snapshot(f.engagement_id, { includeCandidates: true })).read_seq, base_versions: { [record.id]: record.version }, read_set: [record.id], write_set: [record.id], source_observation_refs: [source.id], operations: [{ op: "replace", entity_id: record.id, changes: { title: "corrected finding" } }] };
  const before = (await state(f.store, f.engagement_id));
  assert.equal((await f.service.dispatch("resource.patch", host, { ...patch, operations: [{ ...patch.operations[0], changes: { review_ref: uuidv7(), policy_digest: digest, status: "verified" } }] })).error.code, "validation_error");
  assert.deepEqual((await state(f.store, f.engagement_id)), before);
  const updated = (await f.service.dispatch("resource.patch", host, patch));
  assert.equal(updated.ok, true);
  assert.equal(updated.data.records[0].trust_level, "L1");
  assert.equal(updated.data.records[0].status, "draft");
  assert.equal(updated.data.records[0].review_ref, undefined);
  assert.equal((await f.store.list(f.engagement_id)).some((item) => item.id === record.id), false);
  (await f.store.close());
});

test("L2 audit failure rolls back the canonical version, proposal, outbox and idempotency result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-l2-atomic-"));
  const filename = join(directory, "authority.sqlite");
  const f = (await findingCase(filename));
  const db = new DatabaseSync(filename);
  try {
    const before = (await state(f.store, f.engagement_id));
    const pending = (await f.store.doctor()).pending_outbox;
    db.exec("CREATE TRIGGER fail_l2_audit BEFORE INSERT ON events WHEN NEW.event_type='proposal.promote_l2' BEGIN SELECT RAISE(ABORT, 'injected L2 audit failure'); END");
    const result = (await f.service.dispatch("admission.promote_l2", f.operator, { ...f.request, idempotency_key: "atomic-l2" }));
    assert.equal(result.error.code, "internal_error");
    assert.equal(result.error.message, "internal error");
    assert.deepEqual((await state(f.store, f.engagement_id)), before);
    assert.equal((await f.store.doctor()).pending_outbox, pending);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM idempotency WHERE key='atomic-l2'").get().count, 0);
  } finally {
    db.close();
    (await f.store.close());
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new engagement and snapshot identity contract use only Core assigned UUIDv7", async () => {
  const source = new AuthorityStore();
  const service = (await createCoreService(source));
  assert.equal((await service.init({ id: uuidv7() })).error.code, "validation_error");
  const init = (await service.init({ name: "snapshot", scope: scopeInput }));
  assert.equal(init.ok, true);
  const snapshot = (await source.exportSnapshot(init.data.id));
  assert.equal(snapshot.records.length, 2);
  const destination = new AuthorityStore();
  assert.equal((await destination.importSnapshot(snapshot)).imported_records, 2);
  const malformed = structuredClone(snapshot);
  malformed.records[0].id = "018f47a1-7c00-4000-8000-000000000001";
  (await assert.rejects(async () => (await destination.importSnapshot(malformed)), (error) => error.code === "validation_error"));
  (await destination.close());
  (await source.close());
});
