import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { ArtifactContentStore, AuthorityStore, createCoreService, createPrincipal, uuidv7 } from "../dist/index.js";

function candidate(engagement_id, index = 0, evidence_refs = []) {
  return { schema_version: "1.0.0", engagement_id, kind: "claim", created_at: new Date().toISOString(), provenance: { host_id: "scale", producer_id: "scale", source_kind: "model" }, proposition: `claim ${index}`, status: "proposed", evidence_refs, limitations: [] };
}
async function claim(store, engagement_id, index, trust = "L1") {
  return (await store.createRecord({ engagement_id, kind: "claim", proposition: `claim ${index}`, status: "proposed", evidence_refs: [], limitations: [] }, trust));
}

test("large reference sets use one indexed lookup per batch and preserve Engagement isolation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-reference-scale-"));
  const filename = join(directory, "authority.sqlite");
  const store = new AuthorityStore(filename);
  const engagement_id = uuidv7();
  const references = (await Promise.all(Array.from({ length: 601 }, async (_, index) => (await store.createRecord({ engagement_id, kind: "evidence", artifact_ref: { host_ref: `evidence-${index}` }, observed_at: new Date().toISOString(), limitations: [] })))));
  const originalPrepare = DatabaseSync.prototype.prepare;
  let lookups = 0;
  try {
    DatabaseSync.prototype.prepare = function(sql) {
      if (sql.includes("FROM object_refs refs LEFT JOIN records")) lookups++;
      return originalPrepare.call(this, sql);
    };
    const proposal = (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: candidate(engagement_id, 0, references.map((record) => record.id)) }));
    assert.equal(proposal.status, "pending");
    assert.equal(lookups, 2);
    const eventCount = (await store.events()).length;
    (await assert.rejects(async () => (await store.submitProposal({ engagement_id: uuidv7(), subject_type: "claim", expected_version: 0, content: candidate(uuidv7(), 0, references.map((record) => record.id)) })), (cause) => cause.code === "validation_error"));
    assert.equal((await store.events()).length, eventCount);
    const foreign = uuidv7();
    (await assert.rejects(async () => (await store.submitProposal({ engagement_id: foreign, subject_type: "claim", expected_version: 0, content: candidate(foreign, 0, references.map((record) => record.id)) })), (cause) => cause.code === "validation_error"));
    assert.equal((await store.events()).length, eventCount);
    const inspection = new DatabaseSync(filename);
    try {
      const plan = (sql, ...values) => inspection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((row) => row.detail).join(" ");
      assert.match(plan("SELECT id FROM records WHERE engagement_id=? AND kind=? AND version>? ORDER BY version,id", engagement_id, "evidence", 0), /records_engagement_kind_version/);
      const refPlan = plan("SELECT refs.id,refs.engagement_id,refs.kind,json_extract(records.body,'$.status') AS status FROM object_refs refs LEFT JOIN records ON records.id=refs.id WHERE refs.id IN (?,?)", references[0].id, references[1].id);
      assert.match(refPlan, /SEARCH refs/);
      assert.match(refPlan, /SEARCH records/);
      assert.doesNotMatch(refPlan, /SCAN refs|SCAN records/);
      const pagePlan = plan("SELECT rv.body FROM record_versions rv WHERE rv.engagement_id=? AND rv.id>? AND rv.commit_seq<=? ORDER BY rv.id LIMIT ?", engagement_id, "", (await store.events()).at(-1).commit_seq, 101);
      assert.match(pagePlan, /record_versions_engagement_id_sequence/);
      assert.doesNotMatch(pagePlan, /SCAN record_versions|USE TEMP B-TREE/);
      const auditPlan = plan("SELECT e.commit_seq,v.body FROM events e LEFT JOIN record_versions v ON v.commit_seq=e.commit_seq WHERE e.event_type=?", "record.commit");
      assert.match(auditPlan, /record_versions_commit_sequence/);
      assert.doesNotMatch(auditPlan, /SCAN v/);
    } finally { inspection.close(); }
  } finally { DatabaseSync.prototype.prepare = originalPrepare; (await store.close()); rmSync(directory, { recursive: true, force: true }); }
});

test("runbook maintenance commands match registry capability and operator roles", async () => {
  const { operationContract } = await import("@taric/schemas");
  for (const name of ["query", "proposal.list", "audit.doctor", "audit.verify", "audit.reconcile", "snapshot.export"]) assert.equal(operationContract(name)?.operation, name);
  for (const name of ["audit.doctor", "audit.verify", "audit.reconcile", "snapshot.export"]) assert.deepEqual(operationContract(name).roles, ["operator"]);
  const store = new AuthorityStore();
  try {
    const capability = (await (await createCoreService(store)).capabilityStatus());
    for (const name of ["query", "proposal.list", "audit.doctor", "audit.verify", "audit.reconcile", "snapshot.export"]) assert.ok(capability.data.supported_operations.includes(name));
  } finally { (await store.close()); }
});

test("record keyset pages pin versions, filters and read time through later writes and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-record-pages-"));
  const filename = join(directory, "authority.sqlite");
  let store = new AuthorityStore(filename);
  const engagement_id = uuidv7();
  const records = (await Promise.all(Array.from({ length: 241 }, async (_, index) => (await claim(store, engagement_id, index)))));
  try {
    const input = { engagement_id, principal_id: "operator", include_candidates: true, kind: "claim", page_size: 37 };
    const first = (await store.recordsPage(input));
    assert.equal(first.records.length, 37);
    assert.ok(first.next_cursor);
    const sequence = first.read_seq;
    const changed = (await records.at(-1));
    (await store.commit({ ...changed, proposition: "later" }, changed.trust_level, undefined, undefined, true, changed.version));
    (await claim(store, engagement_id, "new"));
    (await store.close());
    store = new AuthorityStore(filename);
    const ids = first.records.map((record) => record.id);
    let cursor = first.next_cursor;
    while (cursor) {
      const page = (await store.recordsPage({ ...input, cursor }));
      assert.equal(page.read_seq, sequence);
      assert.ok(page.records.length <= input.page_size);
      assert.ok(page.records.every((record) => record.version === 1));
      ids.push(...page.records.map((record) => record.id));
      cursor = page.next_cursor;
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, records.map((record) => record.id).sort());
    for (const changes of [{ principal_id: "other" }, { engagement_id: uuidv7() }, { include_candidates: false }, { kind: "evidence" }, { page_size: 38 }, { as_of: sequence - 1 }]) {
      (await assert.rejects(async () => (await store.recordsPage({ ...input, cursor: first.next_cursor, ...changes })), (cause) => cause.code === "invalid_cursor"));
    }
    for (const page_size of [0, -1, 1001, NaN, 1.5]) (await assert.rejects(async () => (await store.recordsPage({ ...input, page_size })), (cause) => cause.code === "validation_error"));
  } finally { (await store.close()); rmSync(directory, { recursive: true, force: true }); }
});

test("proposal pages preserve pending state at the pinned sequence after admission and new submission", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  try {
    const proposals = (await Promise.all(Array.from({ length: 11 }, async (_, index) => (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: candidate(engagement_id, index) })))));
    const input = { engagement_id, principal_id: "reader", page_size: 3 };
    const first = (await store.proposalsPage(input));
    const admitted = (await proposals.at(-1));
    assert.equal((await store.admitProposal(admitted.id, "sha256:" + "0".repeat(64))).ok, true);
    (await store.submitProposal({ engagement_id, subject_type: "claim", expected_version: 0, content: candidate(engagement_id, "new") }));
    const seen = [...first.proposals];
    let cursor = first.next_cursor;
    while (cursor) {
      const page = (await store.proposalsPage({ ...input, cursor }));
      assert.equal(page.read_seq, first.read_seq);
      seen.push(...page.proposals);
      cursor = page.next_cursor;
    }
    assert.deepEqual(seen.map((proposal) => proposal.id), proposals.map((proposal) => proposal.id).sort());
    assert.ok(seen.every((proposal) => proposal.status === "pending" && !proposal.canonical_id));
    (await assert.rejects(async () => (await store.proposalsPage({ ...input, principal_id: "other", cursor: first.next_cursor })), (cause) => cause.code === "invalid_cursor"));
    const service = (await createCoreService(store));
    const principal = createPrincipal("model", "reader", engagement_id);
    const response = (await service.listProposals(principal, { engagement_id, page_size: 3 }));
    assert.equal(response.ok, true);
    assert.equal(response.data.proposals.length, 3);
    assert.ok(response.data.next_cursor);
  } finally { (await store.close()); }
});

test("maintenance is operator-only, remains pinned during another connection's commit, and preserves history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-maintenance-pinned-"));
  const filename = join(directory, "authority.sqlite");
  const reader = new AuthorityStore(filename);
  const engagement_id = uuidv7();
  (await claim(reader, engagement_id, "before"));
  const service = (await createCoreService(reader, join(directory, "content")));
  try {
    const before = (await reader.events());
    const operator = createPrincipal("operator", "operator");
    for (const role of ["model", "host", "writer", "reviewer"]) {
      const principal = createPrincipal(role, role, engagement_id);
      for (const operation of ["audit.doctor", "audit.verify", "audit.reconcile", "snapshot.export"]) {
        assert.equal((await service.dispatch(operation, principal, { engagement_id, action: operation === "audit.reconcile" ? "preview" : undefined })).error.code, "authorization_error");
      }
    }
    const originalDoctor = reader.doctor;
    let wrote = false;
    reader.doctor = async function() {
      if (!wrote) {
        wrote = true;
        // A separate runtime owns its own writer queue; awaiting a same-process
        // writer behind the active read transaction would queue it after itself.
        const worker = new Worker(`
          const { workerData, parentPort } = require("node:worker_threads");
          (async () => {
            const { AuthorityStore } = await import(workerData.module);
            const writer = new AuthorityStore(workerData.filename);
            try { await writer.createRecord({ engagement_id: workerData.engagement_id, kind: "claim", proposition: "during read", status: "proposed", evidence_refs: [], limitations: [] }); }
            finally { await writer.close(); }
            parentPort.postMessage({ committed: true });
          })().catch((error) => { parentPort.postMessage({ error: error.message }); });
        `, { eval: true, workerData: { module: new URL("../dist/index.js", import.meta.url).href, filename, engagement_id } });
        await new Promise((resolve, reject) => {
          worker.once("message", (result) => result.error ? reject(new Error(result.error)) : resolve());
          worker.once("error", reject);
        });
        await worker.terminate();
      }
      return originalDoctor.call(this);
    };
    const report = (await service.auditDoctor(operator));
    reader.doctor = originalDoctor;
    assert.equal(report.ok, true);
    assert.equal(report.data.read_seq, before.at(-1).commit_seq);
    assert.equal(report.data.audit.read_seq, report.data.read_seq);
    assert.equal(report.data.watermarks.committed_seq, report.data.read_seq);
    assert.equal(report.data.audit.valid, true);
    const current = (await reader.events());
    assert.equal(current.length, before.length + 1);
    assert.equal(current.at(-1).event_type, "record.commit");
    assert.equal(current[0].hash, before[0].hash);
    const preview = (await service.auditReconcile(operator, { action: "preview" }));
    const verified = (await service.auditVerify(operator));
    const exported = (await service.snapshotExport(operator, { engagement_id }));
    assert.equal(preview.data.read_seq, current.at(-1).commit_seq);
    assert.equal(verified.data.read_seq, current.at(-1).commit_seq);
    assert.equal(exported.data.read_seq, current.at(-1).commit_seq);
    assert.equal(exported.data.records.length, 2);
    assert.deepEqual((await reader.events()), current);
  } finally { (await reader.close()); rmSync(directory, { recursive: true, force: true }); }
});

test("external authority drift is detected after a previously validated write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-scale-drift-"));
  const filename = join(directory, "authority.sqlite");
  const store = new AuthorityStore(filename);
  const engagement_id = uuidv7();
  const record = (await claim(store, engagement_id, "original"));
  const external = new DatabaseSync(filename);
  try {
    external.prepare("UPDATE records SET kind='evidence' WHERE id=?").run(record.id);
    (await assert.rejects(async () => (await claim(store, engagement_id, "after corruption")), (cause) => cause.code === "conflict"));
    assert.equal((await store.events()).length, 1);
  } finally { external.close(); (await store.close()); rmSync(directory, { recursive: true, force: true }); }
});

test("page continuation does not revive records that had already expired at the first page", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  try {
    const records = (await Promise.all(Array.from({ length: 6 }, async (_, index) => (await claim(store, engagement_id, index)))));
    const expired = (await store.createRecord({ engagement_id, kind: "claim", proposition: "short-lived", status: "proposed", evidence_refs: [], limitations: [], expires_at: new Date(Date.now() + 50).toISOString() }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const input = { engagement_id, include_candidates: true, kind: "claim", page_size: 2 };
    const first = (await store.recordsPage(input));
    const seen = first.records.map((record) => record.id);
    let cursor = first.next_cursor;
    while (cursor) {
      const page = (await store.recordsPage({ ...input, cursor }));
      seen.push(...page.records.map((record) => record.id));
      cursor = page.next_cursor;
    }
    assert.equal(seen.includes(expired.id), false);
    assert.deepEqual(seen, records.map((record) => record.id).sort());
  } finally { (await store.close()); }
});

test("doctor and preview detect corrupt Artifact files without changing the catalog or audit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taric-doctor-read-only-"));
  const root = join(directory, "content");
  const store = new AuthorityStore(join(directory, "authority.sqlite"));
  try {
    const artifacts = new ArtifactContentStore(root, store); await artifacts.initialize();
    const engagement_id = uuidv7();
    const session_id = "session";
    (await artifacts.bind({ engagement_id, session_id, root: join(root, session_id) }));
    const bytes = Buffer.from("verified");
    const content_hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const upload = (await artifacts.begin({ engagement_id, session_id, payload_kind: "text", media_type: "text/plain" }));
    (await artifacts.append({ engagement_id, session_id, upload_id: upload.upload_id, ordinal: 0, chunk_hash: content_hash, data: bytes.toString("base64") }));
    const row = (await artifacts.commit({ engagement_id, session_id, upload_id: upload.upload_id, total_bytes: bytes.length, content_hash }));
    const service = (await createCoreService(store, root));
    writeFileSync(join(root, session_id, row.relative_dir, "payload-000001.part"), "tampered");
    const before = (await store.events());
    const operator = createPrincipal("operator", "operator");
    const doctor = (await service.auditDoctor(operator));
    const preview = (await service.auditReconcile(operator, { action: "preview" }));
    assert.equal(doctor.ok, true);
    assert.equal(preview.ok, true);
    assert.deepEqual(doctor.data.artifacts.integrity_failed, [row.content_ref]);
    assert.deepEqual(preview.data.artifacts.integrity_failed, [row.content_ref]);
    assert.equal((await store.artifactCatalogRow(engagement_id, session_id, row.content_ref)).content_status, "available");
    assert.deepEqual((await store.events()), before);
    const repaired = (await service.auditReconcile(operator, { action: "reconcile" }));
    assert.equal(repaired.ok, true);
    assert.equal((await store.artifactCatalogRow(engagement_id, session_id, row.content_ref)).content_status, "integrity_failed");
    assert.equal(repaired.data.watermarks.committed_seq, repaired.data.read_seq);
    assert.deepEqual((await store.events()).slice(0, before.length), before);
  } finally { (await store.close()); rmSync(directory, { recursive: true, force: true }); }
});
