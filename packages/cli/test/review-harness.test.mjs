import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal, policyDigest, uuidv7 } from "@taric/core";
import { runReviewHarness } from "../dist/review.js";

async function seeded(directory) {
  const dbPath = join(directory, "authority.sqlite");
  const contentRoot = join(directory, "content");
  const store = new AuthorityStore(dbPath);
  const service = await createCoreService(store, contentRoot);
  const operator = createPrincipal("operator", "op-a");
  const initialized = await service.dispatch("engagement.init", operator, { name: "review-harness", scope: { allowed_targets: ["https://review.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:harness" } });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  const engagement_id = initialized.data.id;
  const scope = (await store.list(engagement_id)).find((record) => record.kind === "scope");
  const claim = await store.createRecord({ schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "reviewable claim", status: "proposed", evidence_refs: [], limitations: ["fixture"] }, "L1");
  const evidence = await store.createRecord({ schema_version: "1.0.0", engagement_id, kind: "evidence", artifact_ref: { host_ref: "host:review-fixture" }, observed_at: new Date().toISOString(), limitations: ["fixture"] }, "L1");
  const model = createPrincipal("model", "producer-model-x", engagement_id);
  const proposed = await service.dispatch("proposal.submit", model, {
    engagement_id, subject_type: "finding", expected_version: 0,
    content: { schema_version: "1.0.0", engagement_id, kind: "finding", title: "reviewable finding", claim_refs: [claim.id], evidence_refs: [evidence.id], applicable_scope_ref: scope.id, status: "draft", limitations: ["fixture"], reproducibility: "repeat fixture", provenance: { host_id: "pi", producer_id: model.id, source_kind: "worker" } },
  });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const digest = policyDigest();
  const admitted = await service.dispatch("admission.evaluate", operator, { engagement_id, proposal_id: proposed.data.id, expected_version: 0, policy_digest: digest });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ db_path: dbPath, content_root: contentRoot, engagement_id }));
  return { store, service, engagement_id, proposal: proposed.data, configPath };
}

test("review CLI exports the admission-bound pack and forwards an external attested result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-review-h-"));
  const { store, service, engagement_id, proposal, configPath } = await seeded(directory);
  try {
    const env = { TARIC_CONFIG: configPath, TARIC_ENGAGEMENT_ID: engagement_id, TARIC_REVIEWER_ID: "external-reviewer", TARIC_REVIEWER_ATTESTATION: JSON.stringify({ capability: "human" }) };
    const exported = await runReviewHarness(["--proposal", proposal.id, "--export"], env);
    assert.equal(exported.ok, true, JSON.stringify(exported.error));
    assert.equal(exported.mode, "export");
    assert.equal(exported.submitted, false);
    assert.match(exported.pack_markdown, /# Taric Fixed Review Pack/);
    assert.match(exported.pack_markdown, new RegExp(proposal.content_hash));
    const pack = exported.review;
    assert.equal(pack.evidence.length, 3, "the pack contains the fixed claim, evidence, and scope records");
    const resolvedByHash = await runReviewHarness(["--input-hash", proposal.content_hash, "--export"], env);
    assert.equal(resolvedByHash.ok, true, JSON.stringify(resolvedByHash.error));
    assert.equal(resolvedByHash.review.pack_hash, pack.pack_hash);

    const resultPath = join(directory, "external-review.json");
    await writeFile(resultPath, JSON.stringify({
      reviewer_id: "external-reviewer",
      verdict: "needs_evidence",
      input_hash: pack.proposal_hash,
      evidence_snapshot_hash: pack.evidence_snapshot_hash,
      policy_digest: pack.policy_digest,
      limitations: ["entered outside Taric"],
    }));
    const submitted = await runReviewHarness(["--proposal", proposal.id, "--submit-result", resultPath], env);
    assert.equal(submitted.ok, true, JSON.stringify(submitted.error));
    assert.equal(submitted.submitted, true);
    assert.equal(submitted.review.accepted, true);
    assert.equal(Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count), 1);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("provider/model options are unsupported and do not change authority state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-review-h-"));
  const { store, service, engagement_id, proposal, configPath } = await seeded(directory);
  try {
    const beforeEvents = await store.events();
    const beforeReviews = Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count);
    const result = await runReviewHarness(["--proposal", proposal.id, "--model", "review-model", "--provider-url", "http://127.0.0.1:1/review", "--auto"], { TARIC_CONFIG: configPath, TARIC_ENGAGEMENT_ID: engagement_id });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "unsupported_capability");
    assert.deepEqual(await store.events(), beforeEvents);
    assert.equal(Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count), beforeReviews);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("review CLI rejects a result bound to another policy before submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-review-h-"));
  const { store, service, engagement_id, proposal, configPath } = await seeded(directory);
  try {
    const env = { TARIC_CONFIG: configPath, TARIC_ENGAGEMENT_ID: engagement_id, TARIC_REVIEWER_ID: "external-reviewer", TARIC_REVIEWER_ATTESTATION: JSON.stringify({ capability: "human" }) };
    const exported = await runReviewHarness(["--proposal", proposal.id, "--export"], env);
    const pack = exported.review;
    const resultPath = join(directory, "stale-review.json");
    await writeFile(resultPath, JSON.stringify({
      reviewer_id: "external-reviewer",
      verdict: "pass",
      input_hash: pack.proposal_hash,
      evidence_snapshot_hash: pack.evidence_snapshot_hash,
      policy_digest: `sha256:${"0".repeat(64)}`,
    }));
    const beforeEvents = await store.events();
    const result = await runReviewHarness(["--proposal", proposal.id, "--submit-result", resultPath], env);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "stale_version");
    assert.deepEqual(await store.events(), beforeEvents);
    assert.equal(Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count), 0);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("review result cannot choose a reviewer identity outside trusted host configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-review-h-"));
  const { store, service, engagement_id, proposal, configPath } = await seeded(directory);
  try {
    const env = { TARIC_CONFIG: configPath, TARIC_ENGAGEMENT_ID: engagement_id, TARIC_REVIEWER_ID: "trusted-reviewer", TARIC_REVIEWER_ATTESTATION: JSON.stringify({ capability: "human" }) };
    const exported = await runReviewHarness(["--proposal", proposal.id, "--export"], env);
    const pack = exported.review;
    const resultPath = join(directory, "wrong-reviewer.json");
    await writeFile(resultPath, JSON.stringify({ reviewer_id: "self-selected", verdict: "pass", input_hash: pack.proposal_hash, evidence_snapshot_hash: pack.evidence_snapshot_hash, policy_digest: pack.policy_digest }));
    const beforeEvents = await store.events();
    const result = await runReviewHarness(["--proposal", proposal.id, "--submit-result", resultPath], env);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "authorization_error");
    assert.deepEqual(await store.events(), beforeEvents);
    assert.equal(Number((await store.sql.get("SELECT COUNT(*) AS count FROM reviews")).count), 0);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
