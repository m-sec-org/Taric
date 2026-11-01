import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, normalizeScopePolicy, uuidv7 } from "../dist/index.js";
import { ensureApprovedScope } from "./scope-fixture.mjs";

const digest = (value) => `sha256:${value.repeat(64)}`;

function policy(overrides = {}) {
  return {
    allowed_targets: ["ExAmPle.com.", "192.0.2.0/24", "2001:db8::/32"],
    excluded_targets: ["admin.example.com"],
    protocols: ["https", "http"],
    ports: [{ from: 443, to: 443 }, { from: 80, to: 80 }],
    methods: ["post", "get"],
    dns: { require_pinned_addresses: true, reject_private_addresses: true, max_addresses: 8 },
    redirects: { max_hops: 3, same_scope_only: true },
    valid_from: new Date(Date.now() - 60_000).toISOString(),
    valid_until: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

async function saveRoe(store, engagementId, body = "approved ROE") {
  const artifactId = uuidv7();
  const contentRef = `${artifactId}@v1`;
  const contentHash = digest("a");
  const bytes = Buffer.from(body);
  await store.saveArtifactCatalogRow({
    content_ref: contentRef,
    engagement_id: engagementId,
    session_id: "roe",
    artifact_id: artifactId,
    version: 1,
    payload_kind: "text",
    media_type: "text/plain",
    storage_mode: "taric_stored",
    byte_length: bytes.length,
    chunk_count: 1,
    content_hash: contentHash,
    content_status: "available",
    integrity_status: "verified",
    stored_at: new Date().toISOString(),
    relative_dir: "",
    manifest_path: "",
  }, [{ ordinal: 0, offset: 0, bytes: bytes.length, hash: contentHash, path: "roe/chunk" }]);
  return { content_ref: contentRef, content_hash: contentHash };
}

test("scope revisions bind normalized policy to committed ROE and preserve fixed historical pages", async () => {
  const store = new AuthorityStore();
  try {
    const engagement = await store.initializeEngagement({ name: "scope revision", scope: { allowed_targets: ["legacy.example"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" } });
    const scope = (await store.get(String(engagement.scope_ref)));
    const roe = await saveRoe(store, engagement.id);
    const firstInput = { engagement_id: engagement.id, scope_id: scope.id, expected_version: scope.version, policy: policy(), roe_artifact_ref: roe.content_ref, roe_artifact_version: 1, idempotency_key: "scope-revision-1", principal: "operator-1" };
    const first = await store.reviseScope(firstInput);
    const replay = await store.reviseScope(firstInput);
    assert.equal(replay.revision.id, first.revision.id);
    assert.equal(first.revision.kind, "scope_revision");
    assert.equal(first.revision.approval_status, "approved");
    assert.equal(first.revision.approved_by, "operator-1");
    assert.equal(first.revision.roe_content_hash, roe.content_hash);
    assert.match(first.revision.policy_digest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.revision.policy.allowed_targets, ["192.0.2.0/24", "2001:db8::/32", "example.com"]);
    assert.deepEqual(first.revision.policy.protocols, ["http", "https"]);
    assert.deepEqual(first.revision.policy.ports, [{ from: 80, to: 80 }, { from: 443, to: 443 }]);
    assert.deepEqual(first.revision.policy.methods, ["GET", "POST"]);
    assert.equal(first.scope.current_revision_ref, first.revision.id);
    assert.equal(first.scope.policy_digest, first.revision.policy_digest);
    await assert.rejects(() => store.commit({
      ...first.scope,
      allowed_targets: ["attacker.example"],
    }, "L2", undefined, { operation: "scope.revise", principal: "operator-1", engagement_id: engagement.id }, true, first.scope.version), /projection does not match/);

    const second = await store.reviseScope({ ...firstInput, expected_version: first.scope.version, idempotency_key: "scope-revision-2" });
    const page = await store.scopeQuery({ engagement_id: engagement.id, scope_id: scope.id, page_size: 1, principal_id: "operator-1" });
    assert.equal(page.records.length, 1);
    assert.ok(page.next_cursor);
    const third = await store.reviseScope({ ...firstInput, expected_version: second.scope.version, idempotency_key: "scope-revision-3" });
    const historical = await store.scopeQuery({ engagement_id: engagement.id, scope_id: scope.id, page_size: 1, principal_id: "operator-1", cursor: page.next_cursor });
    assert.equal(historical.read_seq, page.read_seq);
    assert.equal(historical.records.length, 1);
    assert.ok([first.revision.id, second.revision.id].includes(historical.records[0].id));
    assert.notEqual(historical.records[0].id, third.revision.id);
    await assert.rejects(() => store.scopeQuery({ engagement_id: engagement.id, scope_id: scope.id, page_size: 1, principal_id: "operator-1", cursor: page.next_cursor, as_of: historical.committed_seq }), /cursor binding mismatch/);
  } finally {
    await store.close();
  }
});

test("ambiguous targets and unverified or mismatched ROE metadata fail closed", async () => {
  const store = new AuthorityStore();
  try {
    const engagement = await store.initializeEngagement({ name: "invalid scope policy", scope: { allowed_targets: ["legacy.example"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" } });
    const scope = await store.get(String(engagement.scope_ref));
    const roe = await saveRoe(store, engagement.id);
    const base = { engagement_id: engagement.id, scope_id: scope.id, expected_version: scope.version, policy: policy(), roe_artifact_ref: roe.content_ref, roe_artifact_version: 1, idempotency_key: "bad-scope-policy" };
    for (const target of ["https://example.com", "*.example.com", "192.0.2.7/24", "999.0.0.1"]) {
      await assert.rejects(() => store.reviseScope({ ...base, policy: policy({ allowed_targets: [target] }) }), /scope target|CIDR|DNS/);
    }
    await assert.rejects(() => store.reviseScope({ ...base, policy: policy({ allowed_targets: ["example.com"], excluded_targets: ["example.com"] }) }), /excluded target/);
    await assert.rejects(() => store.reviseScope({ ...base, roe_artifact_version: 2 }), /committed Artifact metadata/);
    const canonicalPolicy = normalizeScopePolicy(policy());
    await assert.rejects(() => store.commit({
      id: uuidv7(), schema_version: "1.0.0", engagement_id: engagement.id, kind: "scope_revision",
      scope_ref: scope.id, revision: 1, policy: canonicalPolicy, roe_artifact_ref: roe.content_ref,
      roe_artifact_version: 1, roe_content_hash: roe.content_hash, policy_digest: digest("b"),
      approval_status: "approved", approved_by: "operator", approved_at: new Date().toISOString(),
    }, "L2"), /issued by scope.revise/);
    assert.equal((await store.get(scope.id)).version, scope.version, "rejected input must not update Scope");
  } finally {
    await store.close();
  }
});

test("scope revision operations are operator-only and return canonical queryable records", async () => {
  const store = new AuthorityStore();
  const service = await createCoreService(store);
  try {
    const initialized = await service.init({ name: "scope operation", scope: { allowed_targets: ["legacy.example"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" } });
    const engagement = initialized.data;
    const scope = await store.get(String(engagement.scope_ref));
    const roe = await saveRoe(store, engagement.id);
    const request = {
      engagement_id: engagement.id,
      scope_id: scope.id,
      expected_version: scope.version,
      policy: policy(),
      roe_artifact_ref: roe.content_ref,
      roe_artifact_version: 1,
      idempotency_key: "scope-operation-1",
    };
    const host = createPrincipal("host", "scope-host", engagement.id);
    const operator = createPrincipal("operator", "scope-operator", engagement.id);
    assert.equal((await service.dispatch("scope.revise", host, request)).error.code, "authorization_error");
    const revised = await service.dispatch("scope.revise", operator, request);
    assert.equal(revised.ok, true, JSON.stringify(revised));
    const history = await service.dispatch("scope.query", host, { engagement_id: engagement.id, scope_id: scope.id, page_size: 10 });
    assert.equal(history.ok, true, JSON.stringify(history));
    assert.equal(history.data.records[0].id, revised.data.revision.id);
    assert.equal(history.data.read_seq, history.data.committed_seq);
  } finally {
    await service.close();
  }
});

test("scope policy rejects impossible calendar dates before issuing a revision", async () => {
  const store = new AuthorityStore();
  try {
    const engagement = await store.initializeEngagement({ name: "invalid scope dates", scope: { allowed_targets: ["legacy.example"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" } });
    const scope = await store.get(String(engagement.scope_ref));
    const roe = await saveRoe(store, engagement.id);
    for (const [valid_from, message] of [["2026-02-29T00:00:00.000Z", /calendar date/], ["2026-02-28T24:00:00.000Z", /clock time/], ["2026-02-28T00:00:00+14:30", /timezone offset/]]) {
      await assert.rejects(() => store.reviseScope({
        engagement_id: engagement.id,
        scope_id: scope.id,
        expected_version: scope.version,
        policy: policy({ valid_from, valid_until: "2026-03-01T00:00:00.000Z" }),
        roe_artifact_ref: roe.content_ref,
        roe_artifact_version: 1,
        idempotency_key: `scope-invalid-date-${valid_from}`,
      }), message);
    }
    assert.equal((await store.get(scope.id)).version, scope.version);
  } finally {
    await store.close();
  }
});

test("invalidating a revision appends a fact and fences WorkRun lifecycle until a new revision", async () => {
  const store = new AuthorityStore();
  try {
    const engagement = await store.initializeEngagement({ name: "invalidate scope", scope: { allowed_targets: ["legacy.example"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" } });
    const scope = await store.get(String(engagement.scope_ref));
    const roe = await saveRoe(store, engagement.id);
    const revised = await store.reviseScope({ engagement_id: engagement.id, scope_id: scope.id, expected_version: scope.version, policy: policy(), roe_artifact_ref: roe.content_ref, roe_artifact_version: 1, idempotency_key: "scope-approve", principal: "operator-2" });
    const work = await store.commit({ id: uuidv7(), engagement_id: engagement.id, kind: "work_item", title: "bounded task", status: "queued", scope_ref: scope.id, acceptance_criteria: ["record evidence"] }, "L1");
    const run = await store.claimWorkRun({ engagement_id: engagement.id, work_item_id: work.id, host_id: "host-1", agent_id: "agent-1" });
    assert.equal(run.scope_revision_ref, revised.revision.id);
    assert.equal(run.policy_digest, revised.revision.policy_digest);
    const invalidated = await store.invalidateScope({ engagement_id: engagement.id, scope_id: scope.id, scope_revision_ref: revised.revision.id, expected_version: revised.scope.version, reason: "ROE withdrawn by project owner", idempotency_key: "scope-invalidation-1", principal: "operator-2" });
    assert.equal(invalidated.scope.revision_state, "invalidated");
    assert.equal(invalidated.invalidation.kind, "scope_invalidation");
    assert.equal(invalidated.invalidation.actor_id, "operator-2");
    assert.equal((await store.invalidateScope({ engagement_id: engagement.id, scope_id: scope.id, scope_revision_ref: revised.revision.id, expected_version: revised.scope.version, reason: "ROE withdrawn by project owner", idempotency_key: "scope-invalidation-1", principal: "operator-2" })).invalidation.id, invalidated.invalidation.id);
    await assert.rejects(() => store.transitionWorkRun(run.run_id, run.generation, "host-1", "running", { engagement_id: engagement.id }), /ScopeRevision binding is stale/);
    const history = await store.scopeQuery({ engagement_id: engagement.id, scope_id: scope.id, page_size: 20 });
    assert.ok(history.records.some((record) => record.id === revised.revision.id));
    assert.ok(history.records.some((record) => record.id === invalidated.invalidation.id));
  } finally {
    await store.close();
  }
});

test("unapproved Scopes cannot claim WorkRuns and legacy unbound WorkRuns cannot record Actions", async () => {
  const store = new AuthorityStore();
  try {
    const engagement = await store.initializeEngagement({ name: "pending scope", scope: { allowed_targets: ["example.test"], excluded_targets: [], rules_of_engagement_ref: "legacy-unverified" } });
    const work = await store.commit({ id: uuidv7(), engagement_id: engagement.id, kind: "work_item", title: "blocked task", status: "queued" }, "L2");
    await assert.rejects(
      store.claimWorkRun({ engagement_id: engagement.id, work_item_id: work.id, host_id: "host", agent_id: "worker" }),
      (error) => error.code === "conflict" && /current approved ScopeRevision/.test(error.message),
    );

    const governed = await ensureApprovedScope(store, engagement.id);
    const run = await store.claimWorkRun({ engagement_id: engagement.id, work_item_id: work.id, host_id: "host", agent_id: "worker" });
    assert.equal(run.scope_revision_ref, governed.revision.id);
    const legacyBody = { ...run };
    delete legacyBody.scope_revision_ref;
    delete legacyBody.policy_digest;
    await store.sql.run("UPDATE work_runs SET body=? WHERE run_id=?", JSON.stringify(legacyBody), run.run_id);
    await assert.rejects(
      store.recordActionIntent({ run_id: run.run_id, generation: run.generation, mode: "host_hitl", status: "recommended", host_id: "host" }),
      (error) => error.code === "stale_version" && /no binding to the current ScopeRevision/.test(error.message),
    );
  } finally {
    await store.close();
  }
});
