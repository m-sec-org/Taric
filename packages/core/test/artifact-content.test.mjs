import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, publishProjection, uuidv7 } from "../dist/index.js";
const { ArtifactContentStore } = await import("../dist/artifact-content-store.js");

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifacts-"));
  const store = new AuthorityStore();
  const service = (await createCoreService(store, join(dir, "content")));
  const engagement_id = uuidv7();
  return { dir, store, service, engagement_id, host: createPrincipal("host", "host-a", engagement_id), contentReader: createPrincipal("host", "reader-a", engagement_id, ["content_read"]), model: createPrincipal("model", "model-a", engagement_id) };
}

test("Core stores and retrieves exact binary bytes while list remains metadata-only", async () => {
  const ctx = (await setup());
  try {
    const session_id = "task-session"; const root = join(ctx.dir, "content", "session-a");
    const bind = (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root, mode: "host-session" }));
    assert.equal(bind.ok, true); assert.equal("root" in bind.data, false);
    const bytes = Buffer.from([0, 255, 1, 13, 10, 128]); const content_hash = sha256(bytes);
    const begun = (await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", expected_bytes: bytes.length, expected_hash: content_hash }));
    const upload_id = begun.data.upload_id;
    const appended = (await ctx.service.dispatch("artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id, ordinal: 0, data: bytes.toString("base64"), encoding: "base64", chunk_hash: content_hash }));
    assert.equal(appended.data.next_ordinal, 1);
    assert.equal((await ctx.service.dispatch("artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id, ordinal: 0, data: bytes.toString("base64"), encoding: "base64", chunk_hash: content_hash })).data.idempotent, true);
    const committed = (await ctx.service.dispatch("artifact.store.commit", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id, total_bytes: bytes.length, chunk_count: 1, content_hash }));
    assert.equal(committed.ok, true); assert.equal("relative_dir" in committed.data, false);
    const listed = (await ctx.service.dispatch("artifact.content.list", ctx.host, { engagement_id: ctx.engagement_id, session_id, page_size: 10 }));
    assert.equal(listed.data.items.length, 1); assert.equal("data" in listed.data.items[0], false);
    assert.equal((await ctx.service.dispatch("artifact.content.read", ctx.host, { engagement_id: ctx.engagement_id, session_id, content_ref: committed.data.content_ref })).error.code, "authorization_error");
    const read = (await ctx.service.dispatch("artifact.content.read", ctx.contentReader, { engagement_id: ctx.engagement_id, session_id, content_ref: committed.data.content_ref }));
    assert.deepEqual(Buffer.from(read.data.data, "base64"), bytes);
    assert.equal(read.data.chunk_verified, true);
    const bounded = (await ctx.service.dispatch("artifact.content.read", ctx.contentReader, { engagement_id: ctx.engagement_id, session_id, content_ref: committed.data.content_ref, length: bytes.length, max_response_bytes: 1 }));
    assert.equal(bounded.ok, true);
    assert.equal(bounded.data.byte_length, 1);
    assert.ok((await ctx.store.events()).some((event) => event.event_type === "artifact.content.read" && event.payload.content_ref === committed.data.content_ref));
    assert.equal((await ctx.service.dispatch("artifact.content.read", ctx.model, { engagement_id: ctx.engagement_id, session_id, content_ref: committed.data.content_ref })).error.code, "authorization_error");
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("transport rejects oversized or non-canonical base64 before decoding", async () => {
  const ctx = (await setup());
  try {
    const session_id = "transport-session";
    (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root: join(ctx.dir, "content", session_id), mode: "host-session" }));
    const begun = (await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream" }));
    assert.equal((await ctx.service.dispatch("artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begun.data.upload_id, ordinal: 0, data: "YQ", chunk_hash: sha256(Buffer.from("a")) })).error.code, "validation_error");
    const direct = new ArtifactContentStore(join(ctx.dir, "direct-content")); await direct.initialize();
    const directSession = "direct-session";
    (await direct.bind({ engagement_id: ctx.engagement_id, session_id: directSession, root: join(ctx.dir, "direct-content", directSession), mode: "host-session" }, ctx.host.id));
    const directUpload = (await direct.begin({ engagement_id: ctx.engagement_id, session_id: directSession, payload_kind: "binary", media_type: "application/octet-stream" }));
    (await assert.rejects(async () => (await direct.append({ engagement_id: ctx.engagement_id, session_id: directSession, upload_id: directUpload.upload_id, ordinal: 0, data: { length: 90_000_000 }, chunk_hash: sha256(Buffer.alloc(0)) })), (error) => error.code === "validation_error"));
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("incomplete and mismatched uploads stay invisible and session roots reject symlink escapes", async () => {
  const ctx = (await setup());
  try {
    const root = join(ctx.dir, "content", "session-a"); const session_id = "task-session";
    (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root, mode: "host-session" }));
    const begin = (await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "text", media_type: "text/plain" }));
    assert.equal((await ctx.service.dispatch("artifact.content.list", ctx.host, { engagement_id: ctx.engagement_id, session_id })).data.items.length, 0);
    const bytes = Buffer.from("original body"); const digest = sha256(bytes);
    assert.equal((await ctx.service.dispatch("artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.data.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: sha256(Buffer.from("wrong")) })).error.code, "conflict");
    assert.equal((await ctx.service.dispatch("artifact.store.commit", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.data.upload_id, total_bytes: bytes.length, content_hash: digest })).error.code, "conflict");
    const outside = mkdtempSync(join(tmpdir(), "taric-outside-")); symlinkSync(outside, join(ctx.dir, "content", "escape"));
    assert.equal((await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id: "escape-session", root: join(ctx.dir, "content", "escape", "sub"), mode: "host-session" })).error.code, "authorization_error");
    rmSync(outside, { recursive: true, force: true });
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("artifact catalog survives Core recreation and corrupt/missing payloads fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taric-artifacts-restart-")); const db = join(dir, "authority.sqlite"); const root = join(dir, "content");
  let store = new AuthorityStore(db); let service = (await createCoreService(store, root)); const engagement_id = uuidv7(); const host = createPrincipal("host", "host-a", engagement_id); const reader = createPrincipal("host", "reader-a", engagement_id, ["content_read"]); const session_id = "task-session";
  try {
    (await service.dispatch("artifact.session.bind", host, { engagement_id, session_id, root: join(root, "session-a"), mode: "host-session" }));
    const bytes = Buffer.from("persisted"); const digest = sha256(bytes); const begun = (await service.dispatch("artifact.store.begin", host, { engagement_id, session_id, payload_kind: "text", media_type: "text/plain" }));
    (await service.dispatch("artifact.store.append", host, { engagement_id, session_id, upload_id: begun.data.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: digest }));
    const committed = (await service.dispatch("artifact.store.commit", host, { engagement_id, session_id, upload_id: begun.data.upload_id, total_bytes: bytes.length, content_hash: digest })); (await store.close());
    store = new AuthorityStore(db); service = (await createCoreService(store, root));
    assert.equal((await service.dispatch("artifact.metadata", host, { engagement_id, session_id, content_ref: committed.data.content_ref })).data.content_hash, digest);
    const metadata = (await store.artifactCatalogRows()).find((row) => row.content_ref === committed.data.content_ref);
    const payloadPath = join(root, "session-a", String(metadata.relative_dir), "payload-000001.part"); writeFileSync(payloadPath, "tampered");
    assert.equal((await service.dispatch("artifact.content.read", reader, { engagement_id, session_id, content_ref: committed.data.content_ref })).error.code, "conflict");
    rmSync(payloadPath);
    assert.equal((await service.dispatch("artifact.content.read", reader, { engagement_id, session_id, content_ref: committed.data.content_ref })).error.code, "unavailable_host");
  } finally { (await store.close()); rmSync(dir, { recursive: true, force: true }); }
});

test("external references stay external and begin/commit retries are request-bound", async () => {
  const ctx = (await setup());
  try {
    const session_id = "task-session"; const root = join(ctx.dir, "content", "session-a");
    (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root, mode: "host-session" }));
    const external = (await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", storage_mode: "external", host_ref: "opaque-host-ref", idempotency_key: "external-1" }));
    assert.equal(external.data.content_status, "external"); assert.equal(external.data.upload_id, undefined);
    assert.equal((await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", storage_mode: "external", host_ref: "opaque-host-ref", idempotency_key: "external-1" })).data.content_ref, external.data.content_ref);
    assert.equal((await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream", storage_mode: "external", host_ref: "changed-ref", idempotency_key: "external-1" })).error.code, "idempotency_conflict");
    assert.equal((await ctx.service.dispatch("artifact.content.read", ctx.contentReader, { engagement_id: ctx.engagement_id, session_id, content_ref: external.data.content_ref })).error.code, "unavailable_host");
    const bytes = Buffer.from("idempotent content"); const digest = sha256(bytes);
    const begun = (await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "text", media_type: "text/plain", idempotency_key: "stored-1" }));
    (await ctx.service.dispatch("artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begun.data.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: digest }));
    const commitRequest = { engagement_id: ctx.engagement_id, session_id, upload_id: begun.data.upload_id, total_bytes: bytes.length, content_hash: digest, idempotency_key: "commit-1" };
    const committed = (await ctx.service.dispatch("artifact.store.commit", ctx.host, commitRequest)); const retried = (await ctx.service.dispatch("artifact.store.commit", ctx.host, commitRequest));
    assert.equal(retried.data.content_ref, committed.data.content_ref);
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("derived Artifact versions retain opaque identity and publish bounded manifest segments", async () => {
  const ctx = (await setup());
  try {
    const session_id = "version-session";
    const sessionRoot = join(ctx.dir, "content", session_id);
    (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root: sessionRoot, mode: "host-session" }));
    const put = async (body) => {
      const digest = sha256(body);
      const begin = (await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "text", media_type: "text/plain", expected_bytes: body.length, expected_hash: digest }));
      (await ctx.service.dispatch("artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.data.upload_id, ordinal: 0, data: body.toString("base64"), chunk_hash: digest }));
      return (await ctx.service.dispatch("artifact.store.commit", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.data.upload_id, total_bytes: body.length, content_hash: digest })).data;
    };
    const first = (await put(Buffer.from("first")));
    const secondBegin = (await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, base_content_ref: first.content_ref, derived_from: first.content_ref, payload_kind: "text", media_type: "text/plain" }));
    const body = Buffer.from("second"); const digest = sha256(body);
    (await ctx.service.dispatch("artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: secondBegin.data.upload_id, ordinal: 0, data: body.toString("base64"), chunk_hash: digest }));
    const second = (await ctx.service.dispatch("artifact.store.commit", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: secondBegin.data.upload_id, total_bytes: body.length, content_hash: digest })).data;
    assert.equal(second.artifact_id, first.artifact_id);
    assert.equal(second.version, 2);
    assert.equal(second.parent_ref, first.content_ref);
    assert.ok(readdirSync(join(sessionRoot, "manifest", "segments"), { recursive: true }).some((name) => String(name).endsWith(".ndjson")));
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("run-scoped Artifact writes are bound to the active session Attempt and generation", async () => {
  const ctx = (await setup());
  try {
    const session_id = "run-session"; const root = join(ctx.dir, "content", "run-session");
    (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root, mode: "host-session" }));
    const runHost = createPrincipal("host", ctx.host.id, ctx.engagement_id, [], undefined, session_id);
    const work_item_id = uuidv7();
    (await ctx.store.commit({ id: work_item_id, engagement_id: ctx.engagement_id, kind: "work_item", title: "inspect", status: "queued", acceptance_criteria: ["done"] }, "L2"));
    const claimed = (await ctx.service.dispatch("work.claim", runHost, { engagement_id: ctx.engagement_id, work_item_id, agent_id: "worker", ttl_ms: 1_000 }));
    assert.equal(claimed.ok, true);
    const bytes = Buffer.from("attempt body"); const digest = sha256(bytes);
    const begin = (await ctx.service.dispatch("artifact.store.begin", runHost, { engagement_id: ctx.engagement_id, session_id, payload_kind: "text", media_type: "text/plain", work_run_id: claimed.data.run_id, attempt_id: claimed.data.attempt_ref, generation: claimed.data.generation }));
    assert.equal(begin.ok, true);
    (await ctx.service.dispatch("artifact.store.append", runHost, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.data.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: digest }));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const reclaimed = (await ctx.service.dispatch("work.reclaim", runHost, { engagement_id: ctx.engagement_id, work_run_id: claimed.data.run_id, agent_id: "worker-2" }));
    assert.equal(reclaimed.ok, true);
    const staleCommit = (await ctx.service.dispatch("artifact.store.commit", runHost, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.data.upload_id, total_bytes: bytes.length, content_hash: digest }));
    assert.equal(staleCommit.error.code, "stale_version");
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("run-bound sessions establish the run link atomically and inherit attribution", async () => {
  const ctx = (await setup());
  try {
    const session_id = "bound-session";
    const work_item_id = uuidv7();
    (await ctx.store.commit({ id: work_item_id, engagement_id: ctx.engagement_id, kind: "work_item", title: "bound", status: "queued", acceptance_criteria: ["done"] }, "L2"));
    const claimed = (await ctx.service.dispatch("work.claim", ctx.host, { engagement_id: ctx.engagement_id, work_item_id, agent_id: "worker", ttl_ms: 10_000 }));
    assert.equal(claimed.ok, true);
    const bound = (await ctx.service.dispatch("artifact.session.bind", ctx.host, {
      engagement_id: ctx.engagement_id,
      session_id,
      root: join(ctx.dir, "content", session_id),
      mode: "run-bound",
      work_run_id: claimed.data.run_id,
      attempt_id: claimed.data.attempt_ref,
      generation: claimed.data.generation,
      owner_host: ctx.host.id,
    }));
    assert.equal(bound.ok, true);
    const bytes = Buffer.from("bound body"); const digest = sha256(bytes);
    const begin = (await ctx.service.dispatch("artifact.store.begin", ctx.host, { engagement_id: ctx.engagement_id, session_id, payload_kind: "text", media_type: "text/plain" }));
    assert.equal(begin.ok, true);
    (await ctx.service.dispatch("artifact.store.append", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.data.upload_id, ordinal: 0, data: bytes.toString("base64"), chunk_hash: digest }));
    const committed = (await ctx.service.dispatch("artifact.store.commit", ctx.host, { engagement_id: ctx.engagement_id, session_id, upload_id: begin.data.upload_id, total_bytes: bytes.length, content_hash: digest }));
    assert.equal(committed.ok, true);
    assert.equal(committed.data.work_run_id, claimed.data.run_id);
    assert.equal(committed.data.attempt_id, claimed.data.attempt_ref);
    assert.equal(committed.data.generation, claimed.data.generation);
    assert.equal((await ctx.store.artifactSessions({ engagement_id: ctx.engagement_id, session_id }))[0].mode, "run-bound");
    assert.equal((await ctx.service.dispatch("artifact.session.bind", ctx.model, { engagement_id: ctx.engagement_id, session_id: "model-session", root: join(ctx.dir, "content", "model-session"), mode: "host-session" })).error.code, "authorization_error");
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("session binding mode is mandatory and cannot be downgraded or created by a model", async () => {
  const ctx = (await setup());
  try {
    const session_id = "strict-session";
    const root = join(ctx.dir, "content", session_id);
    const missingMode = (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root }));
    assert.equal(missingMode.ok, false);
    assert.equal(missingMode.error.code, "validation_error");
    const denied = (await ctx.service.dispatch("artifact.session.bind", ctx.model, { engagement_id: ctx.engagement_id, session_id, root, mode: "host-session" }));
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "authorization_error");
    const crossEngagement = (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: uuidv7(), session_id, root, mode: "host-session" }));
    assert.equal(crossEngagement.ok, false);
    assert.equal(crossEngagement.error.code, "authorization_error");
    const bound = (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root, mode: "host-session" }));
    assert.equal(bound.ok, true);
    const work_item_id = uuidv7();
    (await ctx.store.commit({ id: work_item_id, engagement_id: ctx.engagement_id, kind: "work_item", title: "strict", status: "queued", acceptance_criteria: ["done"] }, "L2"));
    const claimed = (await ctx.service.dispatch("work.claim", ctx.host, { engagement_id: ctx.engagement_id, work_item_id, agent_id: "worker" }));
    const changed = (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root, mode: "run-bound", work_run_id: claimed.data.run_id, attempt_id: claimed.data.attempt_ref, generation: claimed.data.generation, owner_host: ctx.host.id }));
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, "conflict");
    const stored = (await ctx.store.artifactSessions({ engagement_id: ctx.engagement_id, session_id }))[0];
    assert.equal(stored.mode, "host-session");
    assert.equal(stored.work_run_id ?? undefined, undefined);
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("execution sidecars expose metadata and correlated Artifact references without bodies", async () => {
  const ctx = (await setup());
  try {
    const session_id = "execution-session"; const root = join(ctx.dir, "content", "execution-session");
    (await ctx.service.dispatch("artifact.session.bind", ctx.host, { engagement_id: ctx.engagement_id, session_id, root, mode: "host-session" }));
    const runHost = createPrincipal("host", ctx.host.id, ctx.engagement_id, [], undefined, session_id);
    const work_item_id = uuidv7(); (await ctx.store.commit({ id: work_item_id, engagement_id: ctx.engagement_id, kind: "work_item", title: "execute", status: "queued", acceptance_criteria: ["done"] }, "L2"));
    const run = (await ctx.service.dispatch("work.claim", runHost, { engagement_id: ctx.engagement_id, work_item_id, agent_id: "worker" }));
    assert.equal(run.ok, true);
    const checkpoint = { work_item_ref: work_item_id, work_run_ref: run.data.run_id, attempt_ref: run.data.attempt_ref, generation: run.data.generation, target_version: run.data.target_version, work_item_version: run.data.work_item_version, scope_version: run.data.scope_version, owner: run.data.owner, lease_expires_at: run.data.lease_expires_at, source_read_seq: run.data.read_seq, completed_steps: [], next_steps: [], observation_refs: [], evidence_refs: [], negative_results: [], unresolved_work: [], host_decision_refs: [], external_action_state: "none", budget: {}, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [], context_manifest: { context_snapshot_id: uuidv7(), read_seq: run.data.read_seq, builder_version: "test" } };
    const committed = (await ctx.service.dispatch("checkpoint.commit", runHost, { engagement_id: ctx.engagement_id, work_run_id: run.data.run_id, host_id: ctx.host.id, generation: run.data.generation, checkpoint }));
    assert.equal(committed.ok, true);
    const output = (await ctx.service.dispatch("artifact.session.output", runHost, { engagement_id: ctx.engagement_id, session_id, work_run_id: run.data.run_id, page_size: 10 }));
    assert.equal(output.ok, true); assert.ok(output.data.execution.some((item) => item.kind === "checkpoint"));
    assert.doesNotMatch(JSON.stringify(output.data.execution), /hidden_reasoning|cookie|token|raw body/i);
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("model query and context strip host Artifact locators and summaries", async () => {
  const ctx = (await setup());
  try {
    const observation = { id: uuidv7(), engagement_id: ctx.engagement_id, kind: "claim", proposition: "safe", status: "proposed", limitations: [], artifact_refs: [{ host_ref: "HOST-CANARY", location: "/private/canary", summary: "cookie=COOKIE-CANARY" }] };
    (await ctx.store.commit({ ...observation, provenance: { host_id: "host-a", producer_id: "host-a", source_kind: "host" } }, "L2"));
    const query = (await ctx.service.dispatch("query", ctx.model, { engagement_id: ctx.engagement_id }));
    assert.equal(query.ok, true); assert.doesNotMatch(JSON.stringify(query.data), /HOST-CANARY|COOKIE-CANARY|private\/canary/);
    const context = (await ctx.service.dispatch("context.build", ctx.model, { engagement_id: ctx.engagement_id, budget: 4000 }));
    assert.equal(context.ok, true); assert.doesNotMatch(JSON.stringify(context.data), /HOST-CANARY|COOKIE-CANARY|private\/canary/);
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("snapshot and Markdown projection preserve opaque references without host canaries", async () => {
  const ctx = (await setup());
  try {
    const content_ref = `${uuidv7()}@v1`;
    const record = {
      id: uuidv7(), engagement_id: ctx.engagement_id, kind: "claim", proposition: "safe claim", status: "proposed", limitations: [],
      artifact_refs: [{ content_ref, artifact_id: content_ref.slice(0, 36), version: 1, payload_kind: "text", media_type: "text/plain", byte_length: 8, content_hash: sha256(Buffer.from("canary")), host_ref: "HOST-LOCATOR-CANARY", location: "/private/ARTIFACT-CANARY", summary: "cookie=COOKIE-CANARY", header: "authorization: BEARER-CANARY", url: "https://secret.invalid/TOKEN-CANARY" }],
    };
    (await ctx.store.commit(record, "L2"));
    const snapshot = (await ctx.store.exportSnapshot(ctx.engagement_id));
    const snapshotText = JSON.stringify(snapshot);
    assert.match(snapshotText, new RegExp(content_ref));
    assert.doesNotMatch(snapshotText, /HOST-LOCATOR-CANARY|ARTIFACT-CANARY|COOKIE-CANARY|BEARER-CANARY|TOKEN-CANARY/);

    await publishProjection(ctx.store, { engagementId: ctx.engagement_id, outputDir: join(ctx.dir, "projection"), localGit: false });
    const projection = readFileSync(join(ctx.dir, "projection", "current", "STATE.md"), "utf8") + readFileSync(join(ctx.dir, "projection", "current", "index.md"), "utf8");
    assert.match(projection, /safe claim/);
    assert.doesNotMatch(projection, /HOST-LOCATOR-CANARY|ARTIFACT-CANARY|COOKIE-CANARY|BEARER-CANARY|TOKEN-CANARY/);
  } finally { (await ctx.store.close()); rmSync(ctx.dir, { recursive: true, force: true }); }
});
