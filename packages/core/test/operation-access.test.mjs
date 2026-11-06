import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreSchema, operationContracts, permanentNonGoals, unsupportedContracts } from "@taric/schemas";
import { AuthorityStore, createCoreService, describeOperationAccess, registerTransportPrincipal, schemaValidator, uuidv7 } from "../dist/index.js";

const roles = ["model", "host", "reviewer", "writer", "operator"];
const capabilities = ["read", "propose", "review", "admit", "work", "checkpoint", "action", "audit", "operator", "writer", "content", "content_read", "history_read"];
const grants = [[], capabilities, ...capabilities.map((capability) => [capability])];

function principal(role, engagement_id, granted = []) {
  // Exact grants avoid createPrincipal's role defaults masking a missing grant.
  return registerTransportPrincipal({ id: `access-${role}`, role, engagement_id, capabilities: granted, transport_verified: true });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "taric-operation-access-"));
  const store = new AuthorityStore();
  const service = await createCoreService(store, join(directory, "content"));
  return { store, service, directory };
}

function assertDeeplyFrozen(value, path = "catalog", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${path} is immutable`);
  for (const [key, child] of Object.entries(value)) assertDeeplyFrozen(child, `${path}.${key}`, seen);
}

test("operation access describes the complete registry with standalone, immutable request schemas", () => {
  const access = describeOperationAccess();
  assert.deepEqual(access.map((entry) => entry.operation), operationContracts.map((entry) => entry.operation));
  assertDeeplyFrozen(access);
  for (const [index, entry] of access.entries()) {
    const contract = operationContracts[index];
    assert.equal(entry.request_contract, contract.request, entry.operation);
    assert.notEqual(entry.request_contract, "apiSuccess", `${entry.operation} has a concrete request contract`);
    assert.deepEqual(entry.roles, contract.roles, entry.operation);
    assert.notEqual(entry.roles, contract.roles, `${entry.operation} does not freeze the registry's mutable role array`);
    assert.equal(entry.engagement_scoped, contract.engagement_scoped, entry.operation);
    assert.equal(entry.idempotent, contract.idempotent, entry.operation);
    assert.equal(entry.mutates_authority, contract.mutates_authority, entry.operation);
    assert.ok(entry.required_capability === undefined || capabilities.includes(entry.required_capability), entry.operation);
    assert.equal(entry.request_schema.type, "object", entry.operation);
    assert.equal(entry.request_schema.additionalProperties, false, entry.operation);
    const { $defs: _referencedDefinitions, ...requestSchema } = entry.request_schema;
    assert.deepEqual(requestSchema, coreSchema.$defs[contract.request], entry.operation);
    assert.doesNotThrow(() => schemaValidator.compile(entry.request_schema), `${entry.operation} resolves all local schema references`);
  }

  const original = structuredClone(access);
  assert.throws(() => access.push(access[0]), TypeError);
  assert.throws(() => { access[0].operation = "taric.dispatch"; }, TypeError);
  assert.throws(() => access[0].roles.push("model"), TypeError);
  const context = access.find((entry) => entry.operation === "context.query");
  assert.throws(() => { context.request_schema.properties.engagement_id.$ref = "canary"; }, TypeError);
  assert.deepEqual(describeOperationAccess(), original, "callers cannot alter subsequent catalogs");
});

test("operation access matches direct Core authorization for every role and exact capability grant", async () => {
  const { store, service, directory } = await fixture();
  const ownEngagement = uuidv7();
  const foreignEngagement = uuidv7();
  const before = await store.events();
  try {
    for (const role of roles) {
      for (const grant of grants) {
        const identity = principal(role, ownEngagement, grant);
        for (const entry of describeOperationAccess()) {
          // Even an authorized unscoped operation rejects a different bound
          // Engagement before a business handler can mutate authority or files.
          const response = await service.dispatch(entry.operation, identity, { engagement_id: foreignEngagement });
          const label = `${role} [${grant.join(",")}] ${entry.operation}`;
          assert.equal(response.ok, false, label);
          assert.equal(response.error.code, "authorization_error", label);
          const expectedMessage = !entry.roles.includes(role)
            ? "principal role is not authorized for this operation"
            : entry.required_capability && !grant.includes(entry.required_capability)
              ? "principal lacks the required engagement capability"
              : "principal is not authorized for this engagement";
          assert.equal(response.error.message, expectedMessage, label);
        }
      }
    }
    assert.deepEqual(await store.events(), before, "the exhaustive authorization probes have no authority side effects");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authorized reads succeed and extra capabilities never bypass role or transport identity", async () => {
  const { store, service, directory } = await fixture();
  const engagement_id = uuidv7();
  const before = await store.events();
  try {
    for (const [operation, identity, request] of [
      ["resource.query", principal("model", engagement_id, ["read"]), { engagement_id }],
      ["adapter.status", principal("host", engagement_id), {}],
      ["audit.verify", principal("operator", engagement_id, ["audit"]), {}],
      ["capability.status", principal("model", engagement_id, ["operator"]), {}],
    ]) {
      const response = await service.dispatch(operation, identity, request);
      assert.equal(response.ok, true, `${operation}: ${JSON.stringify(response)}`);
    }
    for (const [operation, identity, request] of [
      ["resource.query", principal("model", engagement_id, ["propose"]), { engagement_id }],
      ["audit.verify", principal("operator", engagement_id), {}],
      ["capability.status", principal("model", engagement_id), {}],
      ["audit.verify", principal("model", engagement_id, capabilities), {}],
      ["capability.status", principal("writer", engagement_id, capabilities), {}],
      ["resource.query", { id: "unregistered", role: "model", engagement_id, capabilities, transport_verified: true }, { engagement_id }],
    ]) {
      const response = await service.dispatch(operation, identity, request);
      assert.equal(response.ok, false, operation);
      assert.equal(response.error.code, "authorization_error", operation);
    }
    assert.deepEqual(await store.events(), before, "read and denial probes leave authority unchanged");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deferred, unsupported, permanent non-goal and arbitrary names remain outside the access catalog", async () => {
  const { store, service, directory } = await fixture();
  const engagement_id = uuidv7();
  const names = new Set([
    ...unsupportedContracts.map((entry) => entry.capability),
    ...permanentNonGoals.map((entry) => entry.capability),
    "storage.backup", "storage.restore", "target.execute", "taric.dispatch", "dispatch", "not.registered",
  ]);
  const listed = new Set(describeOperationAccess().map((entry) => entry.operation));
  const before = await store.events();
  try {
    for (const operation of names) {
      assert.equal(listed.has(operation), false, operation);
      for (const role of roles) {
        for (const grant of grants) {
          const response = await service.dispatch(operation, principal(role, engagement_id, grant), { engagement_id });
          assert.equal(response.ok, false, `${role} ${operation}`);
          assert.equal(response.error.code, "unsupported_capability", `${role} ${operation}`);
        }
      }
    }
    assert.deepEqual(await store.events(), before, "unsupported dispatch cannot mutate authority");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
