import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, policyDigest, uuidv7 } from "@taric/core";
import { createMcpServer } from "../dist/server.js";
import { ensureApprovedScope } from "../../core/test/scope-fixture.mjs";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "taric-mcp-conformance-"));
  const store = new AuthorityStore();
  const contentRoot = join(directory, "content");
  const service = await createCoreService(store, contentRoot);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, contentRoot, store, service, engagement_id: uuidv7() };
}

function profile(f, role, overrides = {}) {
  return { id: `mcp-${role}`, role, engagement_id: f.engagement_id, transport_verified: true, ...overrides };
}

async function invoke(server, name, arguments_) {
  const result = await server.toolsCall({ name, arguments: arguments_ });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(result.isError, !envelope.ok, `${name} preserves the outer Core envelope`);
  return envelope;
}

async function assertParity(f, server, identity, name, arguments_) {
  const mcp = await server.toolsCall({ name, arguments: arguments_ });
  const direct = await f.service.dispatch(name, identity, arguments_);
  assert.equal(mcp.content[0].text, JSON.stringify(direct), `${name} preserves the serialized Core envelope`);
  assert.equal(mcp.isError, !direct.ok);
  return JSON.parse(mcp.content[0].text);
}

function errorCode(envelope, expected) {
  assert.equal(envelope.ok, false, JSON.stringify(envelope));
  assert.equal(envelope.error.code, expected, JSON.stringify(envelope));
}

async function bindSession(f, server, session_id) {
  const result = await invoke(server, "artifact.session.bind", {
    engagement_id: f.engagement_id, session_id, root: join(f.contentRoot, session_id), mode: "host-session",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal("root" in result.data, false);
}

async function publish(f, server, session_id, bytes) {
  const content_hash = digest(bytes);
  const begun = await invoke(server, "artifact.store.begin", {
    engagement_id: f.engagement_id, session_id, payload_kind: "text", media_type: "text/plain",
    category: "task_credential", expected_bytes: bytes.length, expected_hash: content_hash,
  });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const upload = { engagement_id: f.engagement_id, session_id, upload_id: begun.data.upload_id };
  const appended = await invoke(server, "artifact.store.append", {
    ...upload, ordinal: 0, data: bytes.toString("base64"), encoding: "base64", chunk_hash: content_hash,
  });
  assert.equal(appended.ok, true, JSON.stringify(appended));
  const committed = await invoke(server, "artifact.store.commit", { ...upload, total_bytes: bytes.length, chunk_count: 1, content_hash });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  return committed.data;
}

test("real model MCP reads match direct Core results and Engagement denials", async (t) => {
  const f = await fixture(t);
  const model = profile(f, "model");
  const server = createMcpServer(f.service, model);
  const direct = createPrincipal(model.role, model.id, model.engagement_id);
  const resource = await f.store.commit({ id: uuidv7(), engagement_id: f.engagement_id, kind: "resource", asset_type: "service", identity: { origin: "example.test" }, revision: 1 }, "L2");
  const foreignEngagement = uuidv7();
  await f.store.commit({ id: uuidv7(), engagement_id: foreignEngagement, kind: "resource", asset_type: "service", identity: { origin: "foreign.invalid" }, revision: 1 }, "L2");
  const before = await f.store.events();
  const result = await assertParity(f, server, direct, "resource.query", { engagement_id: f.engagement_id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.records.map((record) => record.id), [resource.id]);
  const denied = await assertParity(f, server, direct, "resource.query", { engagement_id: foreignEngagement });
  errorCode(denied, "authorization_error");
  assert.doesNotMatch(JSON.stringify(denied), /foreign\.invalid/);
  errorCode(await invoke(server, "resource.query", { engagement_id: f.engagement_id, role: "operator", capabilities: ["audit"] }), "validation_error");
  assert.deepEqual(await f.store.events(), before);
});

test("operator MCP coverage writes preserve Core idempotency, audit attribution and conflicts", async (t) => {
  const f = await fixture(t);
  const operator = profile(f, "operator");
  const server = createMcpServer(f.service, operator);
  const direct = createPrincipal(operator.role, operator.id, operator.engagement_id);
  const resource = await f.store.commit({ id: uuidv7(), engagement_id: f.engagement_id, kind: "resource", asset_type: "service", identity: { origin: "coverage.example.test" }, revision: 1 }, "L2");
  const request = { engagement_id: f.engagement_id, resource_ref: resource.id, test_category: "authorization", status: "not_tested", limitations: [], expected_version: 0, idempotency_key: "mcp-coverage-create" };
  const before = await f.store.events();
  const created = await assertParity(f, server, direct, "coverage.record", request);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.trust_level, "L1");
  assert.equal(created.data.version, 1);
  const after = await f.store.events();
  const events = after.slice(before.length);
  assert.equal(events.filter((event) => event.event_type === "record.commit" && event.subject_id === created.data.id).length, 1);
  assert.equal(events.find((event) => event.subject_id === created.data.id).payload.actor_id, operator.id);
  assert.deepEqual(await invoke(server, "coverage.record", request), created);
  assert.deepEqual(await f.store.events(), after, "MCP and direct retries append no duplicate audit events");
  errorCode(await assertParity(f, server, direct, "coverage.record", { ...request, status: "queued" }), "idempotency_conflict");
  for (const role of ["model", "writer", "reviewer"]) {
    const attributes = role === "reviewer" ? { reviewer_attestation: { capability: "human" } } : {};
    errorCode(await invoke(createMcpServer(f.service, profile(f, role, attributes)), "coverage.record", request), "authorization_error");
  }
  assert.deepEqual(await f.store.events(), after);
});

test("writer admission and reviewer MCP calls retain trusted identity and attestation", async (t) => {
  const f = await fixture(t);
  const model = createMcpServer(f.service, profile(f, "model"));
  const submitted = await invoke(model, "proposal.submit", {
    engagement_id: f.engagement_id, subject_type: "claim", expected_version: 0,
    content: { schema_version: "1.0.0", engagement_id: f.engagement_id, kind: "claim", proposition: "MCP review fixture", status: "proposed", evidence_refs: [], limitations: [] },
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const attestation = { capability: "model", model: "review-model", prompt_digest: digest("prompt"), ruleset_digest: digest("rules") };
  const trustedAttestation = { ...attestation };
  const reviewer = profile(f, "reviewer", { reviewer_attestation: attestation });
  const reviewerServer = createMcpServer(f.service, reviewer);
  attestation.capability = "human";
  attestation.model = "request-side-canary";
  const reviewRequest = { engagement_id: f.engagement_id, proposal_id: submitted.data.id, reviewer_id: reviewer.id, reviewer_kind: "reviewer", input_hash: submitted.data.content_hash, verdict: "pass", policy_digest: policyDigest(), idempotency_key: "mcp-review" };
  const accepted = await assertParity(f, reviewerServer, createPrincipal("reviewer", reviewer.id, f.engagement_id, [], trustedAttestation), "review.submit", reviewRequest);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.data.accepted, true);
  const body = JSON.parse((await f.store.sql.get("SELECT body FROM reviews WHERE id=?", accepted.data.id)).body);
  assert.equal(body.reviewer_id, reviewer.id);
  assert.equal(body.reviewer_capability, trustedAttestation.capability);
  assert.equal(body.reviewer_model, trustedAttestation.model);
  assert.equal(body.prompt_digest, trustedAttestation.prompt_digest);
  assert.equal(body.ruleset_digest, trustedAttestation.ruleset_digest);
  const beforeDenials = await f.store.events();
  errorCode(await invoke(reviewerServer, "review.submit", { ...reviewRequest, reviewer_id: "forged-reviewer" }), "authorization_error");
  for (const override of [{ reviewer_capability: "human" }, { reviewer_model: "forged-model" }, { prompt_digest: digest("forged") }, { ruleset_digest: digest("forged") }]) {
    errorCode(await invoke(reviewerServer, "review.submit", { ...reviewRequest, ...override }), "validation_error");
  }
  errorCode(await invoke(model, "review.submit", reviewRequest), "authorization_error");
  assert.deepEqual(await f.store.events(), beforeDenials);

  const writer = profile(f, "writer");
  const writerServer = createMcpServer(f.service, writer);
  const admissionRequest = { engagement_id: f.engagement_id, proposal_id: submitted.data.id, policy_digest: policyDigest(), expected_version: 0, idempotency_key: "mcp-admission" };
  errorCode(await invoke(reviewerServer, "admission.commit", admissionRequest), "authorization_error");
  errorCode(await invoke(createMcpServer(f.service, profile(f, "host")), "admission.commit", admissionRequest), "authorization_error");
  const admitted = await assertParity(f, writerServer, createPrincipal("writer", writer.id, f.engagement_id), "admission.commit", admissionRequest);
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(admitted.data.ok, true, JSON.stringify(admitted));
  assert.equal(admitted.data.record.trust_level, "L1");
  assert.equal((await f.store.get(admitted.data.record.id)).proposition, "MCP review fixture");
  const after = await f.store.events();
  assert.deepEqual(await invoke(writerServer, "admission.commit", admissionRequest), admitted);
  assert.deepEqual(await f.store.events(), after, "writer admission retries retain one audited mutation");
});

test("host MCP binds Work claims and fences checkpoint, Action and Artifact calls by fixed session and generation", async (t) => {
  const f = await fixture(t);
  await ensureApprovedScope(f.store, f.engagement_id);
  const host = profile(f, "host", { transport_session_id: "session-a" });
  const own = createMcpServer(f.service, host);
  const other = createMcpServer(f.service, { ...host, transport_session_id: "session-b" });
  await bindSession(f, own, "session-a");
  await bindSession(f, other, "session-b");
  const item = await f.store.commit({ id: uuidv7(), engagement_id: f.engagement_id, kind: "work_item", title: "MCP session fixture", status: "queued", acceptance_criteria: ["complete"] }, "L2");
  const claim = { engagement_id: f.engagement_id, work_item_id: item.id, agent_id: "worker", ttl_ms: 60_000 };
  const beforeClaim = await f.store.events();
  for (const override of [{ host_id: "forged-host" }, { task_session_ref: "session-b" }, { transport_session_id: "session-b" }]) {
    errorCode(await invoke(own, "work.claim", { ...claim, ...override }), "validation_error");
  }
  assert.deepEqual(await f.store.events(), beforeClaim);
  const claimed = await invoke(own, "work.claim", claim);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(claimed.data.owner.host_id, host.id);
  assert.equal(claimed.data.task_session_ref, "session-a");
  const run = { engagement_id: f.engagement_id, work_run_id: claimed.data.run_id, generation: claimed.data.generation };
  const checkpoint = {
    source_read_seq: claimed.data.read_seq,
    completed_steps: [], next_steps: ["verify"], observation_refs: [], evidence_refs: [], negative_results: [],
    unresolved_work: [], host_decision_refs: [], external_action_state: "none", budget: { actions: 0 },
    draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [],
    context_manifest: { context_snapshot_id: uuidv7(), read_seq: claimed.data.read_seq, builder_version: "mcp-conformance" },
  };
  const recommendation = { ...run, target: "https://example.test/", method: "GET", rationale: "bounded MCP fixture" };
  const recommended = await invoke(own, "action.recommend", recommendation);
  assert.equal(recommended.ok, true, JSON.stringify(recommended));
  const decision = { ...run, action_id: recommended.data.recommendation_id, mode: "host_hitl", status: "authorized", host_decision_ref: "host:approval" };
  const beforeDenials = await f.store.events();
  for (const [name, request] of [
    ["checkpoint.propose", { ...run, checkpoint }],
    ["action.recommend", recommendation],
    ["action.host-decision", decision],
    ["action.host-result", { ...run, action_id: decision.action_id, mode: "host_hitl", status: "unknown" }],
    ["artifact.store.begin", { engagement_id: f.engagement_id, session_id: "session-a", payload_kind: "text", media_type: "text/plain" }],
  ]) errorCode(await invoke(other, name, request), "authorization_error");
  errorCode(await invoke(own, "artifact.session.bind", { engagement_id: f.engagement_id, session_id: "session-b", root: join(f.contentRoot, "session-b"), mode: "host-session" }), "authorization_error");
  errorCode(await invoke(own, "action.recommend", { ...recommendation, generation: run.generation + 1 }), "stale_version");
  errorCode(await invoke(own, "action.host-decision", { ...decision, generation: run.generation + 1 }), "stale_version");
  errorCode(await invoke(own, "work.transition", { ...run, generation: run.generation + 1, status: "running" }), "stale_version");
  assert.deepEqual(await f.store.events(), beforeDenials, "session and generation denials do not mutate authority");
  const authorized = await invoke(own, "action.host-decision", decision);
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  assert.equal(authorized.data.host_id, host.id);
  const result = await invoke(own, "action.host-result", { ...run, action_id: decision.action_id, mode: "host_hitl", status: "unknown" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.status, "unknown");
  assert.equal((await f.store.events()).some((event) => event.event_type === "action_intent.unknown" && event.payload.actor_id === host.id), true);
});

test("host and operator raw Artifact MCP reads require content_read and preserve fixed host sessions", async (t) => {
  const f = await fixture(t);
  const host = profile(f, "host", { transport_session_id: "artifact-session" });
  const own = createMcpServer(f.service, host);
  await bindSession(f, own, "artifact-session");
  const bytes = Buffer.from("opaque task credential=TARGET-CREDENTIAL-CANARY\n", "utf8");
  const artifact = await publish(f, own, "artifact-session", bytes);
  const request = { engagement_id: f.engagement_id, session_id: "artifact-session", content_ref: artifact.content_ref };
  const operator = createMcpServer(f.service, profile(f, "operator"));
  const model = createMcpServer(f.service, profile(f, "model", { capabilities: ["history_read"] }));
  const beforeDenials = await f.store.events();
  for (const server of [own, operator, model]) errorCode(await invoke(server, "artifact.content.read", request), "authorization_error");
  errorCode(await invoke(own, "artifact.content.list", { engagement_id: f.engagement_id, session_id: request.session_id, include_content: true }), "authorization_error");
  errorCode(await invoke(model, "artifact.history.read", request), "authorization_error");
  const wrongSession = createMcpServer(f.service, { ...host, capabilities: ["content_read"], transport_session_id: "another-session" });
  errorCode(await invoke(wrongSession, "artifact.content.read", request), "authorization_error");
  assert.deepEqual(await f.store.events(), beforeDenials);
  const metadata = await invoke(own, "artifact.content.list", { engagement_id: f.engagement_id, session_id: request.session_id });
  assert.equal(metadata.ok, true);
  assert.equal(metadata.data.items.length, 1);
  assert.equal("data" in metadata.data.items[0], false);
  for (const server of [
    createMcpServer(f.service, { ...host, capabilities: ["content_read"] }),
    createMcpServer(f.service, profile(f, "operator", { capabilities: ["content_read"] })),
  ]) {
    const read = await invoke(server, "artifact.content.read", request);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(Buffer.from(read.data.data, "base64"), bytes);
    assert.equal(read.data.chunk_verified, true);
  }
  const events = await f.store.events();
  assert.equal(events.filter((event) => event.event_type === "artifact.content.read" && event.payload.content_ref === artifact.content_ref).length, 2);
  assert.doesNotMatch(JSON.stringify(events), /TARGET-CREDENTIAL-CANARY/);
});

test("host Work renew and resume enforce the fixed Engagement binding", async (t) => {
  const f = await fixture(t);
  const foreignEngagement = uuidv7();
  await ensureApprovedScope(f.store, foreignEngagement);
  const item = await f.store.commit({ id: uuidv7(), engagement_id: foreignEngagement, kind: "work_item", title: "foreign run", status: "queued", acceptance_criteria: ["complete"] }, "L2");
  const run = await f.store.claimWorkRun({ work_item_id: item.id, engagement_id: foreignEngagement, host_id: "shared-host-id", agent_id: "worker" });
  const host = createMcpServer(f.service, { id: "shared-host-id", role: "host", engagement_id: f.engagement_id, transport_verified: true });
  const before = await f.store.getWorkRun(run.run_id);
  errorCode(await invoke(host, "work.renew", { engagement_id: f.engagement_id, work_run_id: run.run_id, generation: run.generation }), "conflict");
  errorCode(await invoke(host, "work.resume", { engagement_id: f.engagement_id, work_run_id: run.run_id }), "conflict");
  assert.deepEqual(await f.store.getWorkRun(run.run_id), before);
});
