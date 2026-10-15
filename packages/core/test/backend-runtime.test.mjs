import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, PostgresAuthorityStore, createCoreService, createPrincipal, createSharedAuthorityRuntime, runAuthorityRuntimeConformance, sqliteAuthorityBackend, AUTHORITY_RUNTIME_SCENARIOS, AUTHORITY_RUNTIME_CONFORMANCE_VERSION, uuidv7 } from "../dist/index.js";

const passingEvidence = () => ({ version: AUTHORITY_RUNTIME_CONFORMANCE_VERSION, passed: true, missing_methods: [], failures: [], scenarios: AUTHORITY_RUNTIME_SCENARIOS.map((id) => ({ id, passed: true, evidence: [`unit-gate-mechanism:${id}`] })) });

test("SQLite facade preserves async calls and complete backend method coverage", async () => {
  const store = new AuthorityStore();
  try {
    const backend = sqliteAuthorityBackend(store);
    assert.equal(backend, store);
    const engagement_id = uuidv7();
    const record = await backend.commit({ id: uuidv7(), engagement_id, kind: "claim", proposition: "facade" });
    assert.equal((await backend.get(record.id)).id, record.id);
    assert.equal((await backend.snapshot(engagement_id, { asOf: record.commit_seq, includeCandidates: true })).records.length, 1);
    assert.equal((await backend.verifyAudit()).valid, true);
    const incomplete = await runAuthorityRuntimeConformance(backend, {});
    assert.deepEqual(incomplete.missing_methods, []);
    assert.equal(incomplete.passed, false);
    assert.equal(incomplete.scenarios.length, AUTHORITY_RUNTIME_SCENARIOS.length);
  } finally { (await store.close()); }
});

test("PostgreSQL without runtime evidence cannot enable the shared runtime or trigger construction", async () => {
  let queries = 0; let construction = 0; let probes = 0;
  const postgres = new PostgresAuthorityStore({ query: async () => { queries++; throw new Error("should not migrate"); } }, { profile: "multi_host_authority" });
  const result = await createSharedAuthorityRuntime({ backend: postgres, scenarios: {}, health: async () => { probes++; return { available: true, fencing: true, schema_version: "1.0.0" }; }, createService: async () => { construction++; throw new Error("should not construct"); } });
  assert.equal(result.code, "backend_conformance_failed"); assert.equal(result.runtime_state, "disabled"); assert.equal(result.implementation_state, "available");
  assert.deepEqual(result.conformance.missing_methods, []);
  assert.equal(result.conformance.scenarios.every((scenario) => !scenario.passed), true);
  assert.equal(queries, 0); assert.equal(probes, 0); assert.equal(construction, 0);
  assert.equal(postgres.manifest().runtime_state, "disabled");
});

test("scenario mismatch produces sanitized failed evidence and prevents activation", async () => {
  const store = new AuthorityStore(); let constructed = false;
  try {
    const checks = Object.fromEntries(AUTHORITY_RUNTIME_SCENARIOS.map((id) => [id, () => [`test:${id}`]]));
    checks.checkpoint = () => { throw new Error("internal SQL and private path"); };
    const result = await createSharedAuthorityRuntime({ backend: store, scenarios: checks, health: () => ({ available: true, fencing: true, schema_version: "1" }), createService: async () => { constructed = true; return (await createCoreService(store)); } });
    assert.equal(result.runtime_state, "disabled"); assert.equal(constructed, false);
    assert.ok(result.conformance.failures.some((failure) => /checkpoint/.test(failure)));
    assert.doesNotMatch(JSON.stringify(result), /internal SQL|private path/);
  } finally { (await store.close()); }
});

test("factory checks health before construction and blocks later health/fencing loss", async () => {
  const store = new AuthorityStore(); let available = true; let constructed = 0;
  try {
    const scenarios = Object.fromEntries(AUTHORITY_RUNTIME_SCENARIOS.map((id) => [id, () => [`test:${id}`]]));
    const result = await createSharedAuthorityRuntime({ backend: store, scenarios, health: () => ({ available, fencing: available, schema_version: "1.0.0" }), createService: async () => { constructed++; return (await createCoreService(store)); } });
    assert.equal(result.runtime_state, "enabled"); assert.equal(constructed, 1);
    assert.equal((await result.service.dispatch("capability.status", createPrincipal("operator", "test"), {})).ok, true);
    const before = (await store.events()).length; available = false;
    const denied = await result.service.dispatch("engagement.init", createPrincipal("operator", "test"), { name: "offline" });
    assert.equal(denied.error.code, "unavailable_host"); assert.equal((await store.events()).length, before);
  } finally { (await store.close()); }
});

test("saved conformance evidence is checked without executing scenarios or manufacturing authority data", async () => {
  const store = new AuthorityStore(); let scenarioExecutions = 0; let constructions = 0;
  try {
    const before = await store.events();
    const result = await createSharedAuthorityRuntime({ backend: store, conformance: passingEvidence(),
      scenarios: Object.fromEntries(AUTHORITY_RUNTIME_SCENARIOS.map((id) => [id, () => { scenarioExecutions++; throw new Error("startup must not execute fixtures"); }])),
      health: () => ({ available: true, fencing: true, schema_version: "1.0.0" }),
      createService: async () => { constructions++; return createCoreService(store); },
    });
    assert.equal(result.runtime_state, "enabled"); assert.equal(scenarioExecutions, 0); assert.equal(constructions, 1);
    assert.deepEqual(await store.events(), before);
  } finally { await store.close(); }
});

test("saved failed evidence and missing backend methods block before health and construction", async () => {
  const store = new AuthorityStore(); let healthCalls = 0; let constructionCalls = 0;
  const attempt = (backend, conformance) => createSharedAuthorityRuntime({ backend, conformance,
    health: () => { healthCalls++; return { available: true, fencing: true, schema_version: "1.0.0" }; },
    createService: async () => { constructionCalls++; return createCoreService(store); },
  });
  try {
    assert.equal((await attempt(store, { ...passingEvidence(), passed: false, failures: ["real checkpoint mismatch"] })).runtime_state, "disabled");
    const missing = Object.create(store); Object.defineProperty(missing, "commitCheckpoint", { value: undefined });
    const result = await attempt(missing, passingEvidence());
    assert.equal(result.runtime_state, "disabled"); assert.ok(result.conformance.missing_methods.includes("commitCheckpoint"));
    assert.equal(healthCalls, 0); assert.equal(constructionCalls, 0);
  } finally { await store.close(); }
});
