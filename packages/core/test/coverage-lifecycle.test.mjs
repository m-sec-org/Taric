import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, coverageCloseGate, coverageDimensions, coverageVisibility, createCoverageCell, createNegativeObservation, evaluateCoverageGate, uuidv7 } from "../dist/index.js";

test("coverage cell identity retains resource revision, identity, tenant, path, operation, parameter and conditions", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const resource = (await store.commit({ id: uuidv7(), engagement_id, kind: "resource", asset_type: "endpoint", identity: { route: "/admin" } }, "L1"));
  const identityA = (await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "identity-a" }, "L1"));
  const identityB = (await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "identity-b" }, "L1"));
  const tenantA = (await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "tenant-a" }, "L1"));
  const tenantB = (await store.commit({ id: uuidv7(), engagement_id, kind: "note", statement: "tenant-b" }, "L1"));
  const source = (await store.commit({ id: uuidv7(), engagement_id, kind: "observation", statement: "resource revision source" }, "L1"));
  const revisionA = (await store.createResourceRevision({ engagement_id, resource_id: resource.id, expected_version: resource.version, method: "GET", path: "/admin", content_hash: `sha256:${"a".repeat(64)}`, source_observation_refs: [source.id] })).revision;
  const revisionB = (await store.createResourceRevision({ engagement_id, resource_id: resource.id, expected_version: (await store.get(resource.id)).version, method: "POST", path: "/admin", content_hash: `sha256:${"b".repeat(64)}`, source_observation_refs: [source.id] })).revision;
  try {
    const dimensions = [
      { identity_ref: identityA.id },
      { identity_ref: identityB.id },
      { tenant_ref: tenantA.id },
      { tenant_ref: tenantB.id },
      { path: "/admin" },
      { path: "/admin/export" },
      { operation: "GET" },
      { operation: "POST" },
      { parameter: "id" },
      { parameter: "tenant_id" },
      { conditions: ["role=admin", "tls"] },
      { conditions: ["role=user", "tls"] },
      { network_condition: "vpn" },
      { role: "admin" },
      { role: "user" },
      { resource_revision_ref: revisionA.id },
      { resource_revision_ref: revisionB.id },
    ];
    const cells = (await Promise.all(dimensions.map(async (extra) => (await createCoverageCell(store, {
      engagement_id,
      resource_ref: resource.id,
      test_category: "authorization",
      status: "not_tested",
      limitations: ["not yet run"],
      ...extra,
    })))));
    assert.equal(new Set(cells.map(coverageDimensions)).size, dimensions.length);
    assert.equal(evaluateCoverageGate(cells).gaps.filter((gap) => gap.kind === "untested").length, dimensions.length);
  } finally {
    (await store.close());
  }
});

test("edge control block and bounded negative result never close origin coverage", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const resource = (await store.commit({ id: uuidv7(), engagement_id, kind: "endpoint", name: "/admin" }, "L1"));
  try {
    const edgeBlock = (await createCoverageCell(store, {
      engagement_id,
      resource_ref: resource.id,
      test_category: "authorization",
      path: "/admin",
      operation: "GET",
      conditions: ["role=user"],
      status: "blocked_by_control",
      origin_reached: false,
      limitations: ["edge control blocked before origin"],
    }));
    const negative = (await createNegativeObservation(store, {
      engagement_id,
      statement: "no unauthorized response was observed in this run",
      method: "GET",
      baseline_ref: resource.id,
      tested_resource_refs: [resource.id],
      role: "user",
      path: "/admin",
      operation: "GET",
      conditions: ["role=user"],
      evidence_refs: [],
      limitations: ["single identity and single route"],
    }));
    const origin = (await createCoverageCell(store, {
      engagement_id,
      resource_ref: resource.id,
      test_category: "authorization",
      path: "/admin",
      operation: "GET",
      conditions: ["role=user"],
      status: "not_tested",
      limitations: ["origin was not reached"],
    }));
    assert.equal(edgeBlock.status, "blocked_by_control");
    assert.equal(negative.bounded, true);
    assert.equal(negative.role, "user");
    assert.equal(negative.path, "/admin");
    const gate = (await coverageCloseGate(store, engagement_id));
    assert.equal(gate.can_close, false);
    assert.ok(gate.gaps.some((gap) => gap.kind === "blocked_by_control" && gap.cell_ids.includes(edgeBlock.id)));
    assert.ok(gate.gaps.some((gap) => gap.kind === "untested" && gap.cell_ids.includes(origin.id)));
  } finally {
    (await store.close());
  }
});

test("not-applicable cells require a reason and counter-evidence remains an open gap", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const resource = (await store.commit({ id: uuidv7(), engagement_id, kind: "resource", asset_type: "endpoint", identity: { route: "/admin" } }, "L1"));
  const evidence = (await store.commit({ id: uuidv7(), engagement_id, kind: "evidence", statement: "observed response" }, "L1"));
  try {
    (await assert.rejects(async () => (await createCoverageCell(store, { engagement_id, resource_ref: resource.id, test_category: "tls", status: "not_applicable", limitations: [] })), /explicit reason/));
    (await assert.rejects(async () => (await createCoverageCell(store, { engagement_id, resource_ref: resource.id, test_category: "tls", status: "not_applicable", not_applicable_reason: "  ", limitations: [] })), /explicit reason/));
    const notApplicable = (await createCoverageCell(store, { engagement_id, resource_ref: resource.id, test_category: "tls", status: "not_applicable", not_applicable_reason: "host protocol has no TLS layer", limitations: [] }));
    assert.equal(evaluateCoverageGate([notApplicable]).gaps.some((gap) => gap.kind === "unjustified_not_applicable"), false);
    const contradicted = (await createCoverageCell(store, {
      engagement_id,
      resource_ref: resource.id,
      test_category: "authorization",
      status: "positive",
      evidence_refs: [evidence.id],
      counter_evidence_refs: [evidence.id],
      limitations: ["conflicting observation"],
    }));
    assert.ok(evaluateCoverageGate([contradicted]).gaps.some((gap) => gap.kind === "contradicted"));
  } finally {
    (await store.close());
  }
});

test("contradiction stales current recall, queues revalidation and preserves as-of evidence", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  try {
    const evidence = (await store.commit({ id: uuidv7(), engagement_id, kind: "evidence", statement: "contrary response" }, "L1"));
    const claim = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "admin endpoint is exposed", status: "proposed", evidence_refs: [], limitations: ["one test"] }, "L1"));
    const resource = (await store.commit({ id: uuidv7(), engagement_id, kind: "resource", asset_type: "endpoint", identity: { route: "/admin" } }, "L1"));
    const cell = (await createCoverageCell(store, { engagement_id, resource_ref: resource.id, test_category: "authorization", status: "positive", evidence_refs: [evidence.id], limitations: ["single observation"] }));
    const asOf = (await store.snapshot(engagement_id, { includeCandidates: true })).read_seq;
    const contradicted = (await store.contradict(claim.id, [evidence.id], "new evidence refutes the claim"));
    (await store.contradict(cell.id, [evidence.id], "new evidence refutes the coverage result"));
    assert.equal(contradicted.status, "inconclusive");
    assert.equal((await store.list(engagement_id, { includeCandidates: true })).some((record) => record.id === claim.id), false);
    assert.equal((await store.snapshot(engagement_id, { asOf, includeCandidates: true })).records.some((record) => record.id === claim.id), true);
    const visibility = (await coverageVisibility(store, engagement_id));
    assert.equal(visibility.complete, false);
    assert.ok(visibility.revalidation_queue.some((item) => item.subject_ref === claim.id));
    assert.ok(visibility.conflicted.some((item) => item.id === cell.id));
    assert.ok((await coverageCloseGate(store, engagement_id)).gaps.some((gap) => gap.kind === "conflicting" && gap.cell_ids.includes(cell.id)));
    assert.ok((await store.events()).some((event) => event.event_type === "record.contradicted"));
  } finally {
    (await store.close());
  }
});

test("pending external results and incomplete impact propagation block coverage close", async () => {
  const store = new AuthorityStore();
  const engagement_id = uuidv7();
  const resource = (await store.commit({ id: uuidv7(), engagement_id, kind: "resource", asset_type: "endpoint", identity: { route: "/" } }, "L1"));
  try {
    const dependentA = (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "A", resource_ref: resource.id, status: "proposed", evidence_refs: [], limitations: ["pending"] }, "L1"));
    (await store.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "B", depends_on: [dependentA.id], status: "proposed", evidence_refs: [], limitations: ["pending"] }, "L1"));
    const pending = (await createCoverageCell(store, {
      engagement_id,
      resource_ref: resource.id,
      test_category: "authn",
      status: "in_progress",
      external_result_state: "pending",
      limitations: ["tool result is not ingested"],
    }));
    const impact = (await store.impact(resource.id, { engagement_id, limit: 1 }));
    assert.ok(impact.continuation);
    assert.equal((await coverageVisibility(store, engagement_id)).pending_external_results[0].id, pending.id);
    assert.equal((await coverageVisibility(store, engagement_id)).pending_impact[0].event_id, impact.event_id);
    const gate = (await coverageCloseGate(store, engagement_id));
    assert.equal(gate.can_close, false);
    assert.ok(gate.gaps.some((gap) => gap.kind === "un_ingested_external"));
    assert.ok(gate.gaps.some((gap) => gap.kind === "pending_impact"));
  } finally {
    (await store.close());
  }
});
