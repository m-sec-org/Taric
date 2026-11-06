import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, createPrincipal, describeOperationAccess, ContractValidationError, uuidv7 } from "@taric/core";
import { modelTools, createMcpServer, resolveMcpStartup } from "../dist/server.js";
import { resolveCliStartup, runCli } from "../../cli/dist/cli.js";
async function modelService() {
    const store = new AuthorityStore();
    const service = (await createCoreService(store));
    return { store, service, principal: { id: "mcp-model", role: "model", engagement_id: uuidv7(), transport_verified: true } };
}
test("initialize and tools/list expose only model-facing tools", async () => {
    const { store, service, principal } = (await modelService());
    const server = createMcpServer(service, principal);
    const init = server.initialize({ protocolVersion: "2024-11-05" });
    assert.equal(init.serverInfo.name, "taric-mcp");
    const listed = server.toolsList();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [...modelTools]);
    for (const tool of listed.tools) {
        assert.ok(tool.inputSchema.required.length > 0, `${tool.name} requires arguments`);
        assert.equal(tool.inputSchema.additionalProperties, false);
    }
    (await store.close());
});
test("history tools are separately granted, bounded, and dispatched only for model identities", async () => {
    const calls = [];
    const service = { dispatch: async (...args) => { calls.push(args); return { ok: true, data: { entries: [] } }; } };
    const engagement_id = uuidv7();
    const basePrincipal = { id: "mcp-model", role: "model", engagement_id, transport_verified: true };
    const denied = createMcpServer(service, basePrincipal);
    assert.deepEqual(denied.toolsList().tools.map((tool) => tool.name), [...modelTools]);
    const noGrant = await denied.toolsCall({ name: "history.query", arguments: { engagement_id, session_id: "session-a" } });
    assert.equal(JSON.parse(noGrant.content[0].text).error.code, "authorization_error");
    assert.equal(calls.length, 0);

    const granted = createMcpServer(service, { ...basePrincipal, capabilities: ["history_read"] });
    const names = granted.toolsList().tools.map((tool) => tool.name);
    assert.deepEqual(names, [...modelTools, "history.query", "artifact.search", "artifact.history.read"]);
    for (const name of names.slice(-3)) {
        const schema = granted.toolsList().tools.find((tool) => tool.name === name).inputSchema;
        assert.equal(schema.additionalProperties, false);
        assert.ok(schema.required.length > 0);
    }
    const valid = await granted.toolsCall({ name: "history.query", arguments: { engagement_id, session_id: "session-a", page_size: 100 } });
    assert.equal(JSON.parse(valid.content[0].text).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "history.query");
    assert.deepEqual(calls[0][1].capabilities.includes("history_read"), true);
    assert.deepEqual(calls[0][2], { engagement_id, session_id: "session-a", page_size: 100 });

    for (const [name, args] of [
        ["history.query", { engagement_id, session_id: "session-a", page_size: 101 }],
        ["history.query", { engagement_id, session_id: "session-a", kind: "proposal" }],
        ["artifact.search", { engagement_id, session_id: "session-a", query: "x".repeat(257) }],
        ["artifact.history.read", { engagement_id, session_id: "session-a", content_ref: "ref", length: 16385 }],
        ["artifact.history.read", { engagement_id, session_id: "session-a", content_ref: "ref", offset: "0" }],
        ["artifact.search", { engagement_id, session_id: "session-a", query: "token", credential: "canary" }],
    ]) {
        const result = await granted.toolsCall({ name, arguments: args });
        assert.equal(result.isError, true, name);
        assert.equal(JSON.parse(result.content[0].text).error.code, "validation_error");
    }
    assert.equal(calls.length, 1, "invalid requests must not reach Core");

    assert.throws(() => createMcpServer(service, { id: "host", role: "host", engagement_id, capabilities: ["history_read"], transport_verified: true }), /history_read/);
});
test("CLI and MCP resolve the same backend, authority and content settings", () => {
    const config = { db_path: "/synthetic/authority.sqlite", content_root: "/synthetic/content", principal_id: "host", principal_role: "host", engagement_id: uuidv7() };
    const env = { TARIC_DB: "/synthetic/override.sqlite" };
    const cli = resolveCliStartup(config, env, "/synthetic/home");
    const mcp = resolveMcpStartup({ config, env, home: "/synthetic/home" });
    assert.equal(cli.dbPath, mcp.dbPath);
    assert.equal(cli.contentRoot, mcp.contentRoot);
    assert.deepEqual(cli.diagnostics, mcp.diagnostics);
});
test("CLI and MCP preserve typed codes and hide untyped internal exception text", async () => {
    const { store, service, principal } = (await modelService());
    const server = createMcpServer(service, principal);
    const request = { engagement_id: principal.engagement_id };
    try {
        store.recordsPage = () => { throw new Error("stale lease SQL /private/token-canary"); };
        const cli = await runCli(["query", JSON.stringify(request)], service, principal);
        assert.equal(cli.stdout, "");
        assert.equal(JSON.parse(cli.stderr).error.code, "internal_error");
        assert.doesNotMatch(cli.stderr, /canary|SQL|private/);
        const mcp = (await server.toolsCall({ name: "resource.query", arguments: request }));
        assert.deepEqual(JSON.parse(mcp.content[0].text).error, { code: "internal_error", message: "internal error" });
        store.recordsPage = () => { throw new ContractValidationError("stale_version", "pinned version is stale"); };
        assert.equal(JSON.parse((await server.toolsCall({ name: "resource.query", arguments: request })).content[0].text).error.code, "stale_version");
    }
    finally {
        (await store.close());
    }
});
test("tools/call rejects host and operator operations", async () => {
    const { store, service, principal } = (await modelService());
    const server = createMcpServer(service, principal);
    const eventCount = (await store.events()).length;
    for (const name of ["checkpoint.commit", "admission.evaluate", "admission.promote_l2", "snapshot.export", "engagement.init", "action.host-decision", "target.execute", "writer.commit"]) {
        const result = (await server.toolsCall({ name, arguments: { engagement_id: "engagement-a" } }));
        assert.equal(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).error.code, "authorization_error");
    }
    const extraPath = (await server.toolsCall({ name: "resource.query", arguments: { engagement_id: "engagement-a", path: "/etc/passwd" } }));
    assert.equal(extraPath.isError, true);
    assert.equal(JSON.parse(extraPath.content[0].text).error.code, "validation_error");
    assert.equal((await store.events()).length, eventCount);
    (await store.close());
});
test("tools/call validates required and unexpected arguments", async () => {
    const { store, service, principal } = (await modelService());
    const server = createMcpServer(service, principal);
    const missing = (await server.toolsCall({ name: "action.recommend", arguments: { engagement_id: "engagement-a" } }));
    assert.equal(JSON.parse(missing.content[0].text).error.code, "validation_error");
    const extra = (await server.toolsCall({ name: "resource.query", arguments: { engagement_id: "engagement-a", display_id: "TAR-1" } }));
    assert.equal(JSON.parse(extra.content[0].text).error.code, "validation_error");
    (await store.close());
});
test("model principal cannot read another engagement", async () => {
    const { store, service, principal } = (await modelService());
    const server = createMcpServer(service, principal);
    const result = (await server.toolsCall({ name: "resource.query", arguments: { engagement_id: uuidv7() } }));
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, "authorization_error");
    (await store.close());
});
test("MCP protocol layer never returns credentials or db paths", async () => {
    const { store, service, principal } = (await modelService());
    const server = createMcpServer(service, principal);
    const result = (await server.toolsCall({ name: "resource.query", arguments: { engagement_id: "engagement-a" } }));
    assert.doesNotMatch(result.content[0].text, /AuthorityStore|\.sqlite|credential|SecretRef/i);
    (await store.close());
});

const capabilities = ["read", "propose", "review", "admit", "work", "checkpoint", "action", "audit", "operator", "writer", "content", "content_read", "history_read"];
const parsed = (response) => JSON.parse(response.content[0].text);

test("catalogs contain exactly the Core-authorized operations for each fixed role and grant", async () => {
    const engagement_id = uuidv7();
    const calls = [];
    const service = { dispatch: async (...args) => { calls.push(args); return { ok: true, data: {} }; } };
    const metadata = describeOperationAccess();
    for (const role of ["model", "host", "reviewer", "writer", "operator"]) {
        const grants = capabilities.filter((grant) => (grant !== "history_read" || role === "model") && (grant !== "content_read" || ["host", "operator"].includes(role)));
        for (const grant of [[], grants]) {
            const input = { id: `mcp-${role}`, role, engagement_id, capabilities: grant, transport_verified: true, ...(role === "reviewer" ? { reviewer_attestation: { capability: "human" } } : {}) };
            const expectedPrincipal = createPrincipal(role, input.id, engagement_id, grant);
            const expected = metadata.filter((entry) => entry.roles.includes(role) && (!entry.required_capability || expectedPrincipal.capabilities.includes(entry.required_capability))).map((entry) => entry.operation);
            const server = createMcpServer(service, input);
            const listed = server.toolsList();
            assert.deepEqual(listed.tools.map((tool) => tool.name), expected, `${role} grants ${grant}`);
            for (const tool of listed.tools) {
                assert.deepEqual(tool.inputSchema, metadata.find((entry) => entry.operation === tool.name).request_schema);
                assert.ok(tool.inputSchema.additionalProperties === false || tool.inputSchema.unevaluatedProperties === false);
            }
            for (const entry of metadata.filter((entry) => !expected.includes(entry.operation))) {
                assert.equal(parsed(await server.toolsCall({ name: entry.operation, arguments: {} })).error.code, "authorization_error");
            }
        }
    }
    assert.equal(calls.length, 0, "unadvertised tools never dispatch");
});

test("MCP startup defaults to model and validates trusted profile configuration", () => {
    const startup = resolveMcpStartup({ config: {}, env: {}, home: "/synthetic/home" });
    assert.equal(startup.principal.role, "model");
    assert.equal(startup.principal.id, "mcp-model");
    assert.deepEqual(createMcpServer({}, { ...startup.principal, transport_verified: true }).toolsList().tools, [], "unbound model has no scoped tools");
    for (const config of [
        { principal_role: "unknown" },
        { principal_role: "host" },
        { principal_role: "host", engagement_id: "invalid" },
        { principal_role: "reviewer", engagement_id: uuidv7() },
        { principal_role: "operator", transport_session_id: "session" },
        { principal_role: "model", principal_capabilities: ["unknown"] },
        { principal_role: "model", content_read_enabled: true },
    ]) assert.throws(() => resolveMcpStartup({ config, env: {}, home: "/synthetic/home" }));
});

test("generated schemas reject nested violations, types, enums, bounds and oversized calls before dispatch", async () => {
    const calls = [];
    const service = { dispatch: async (...args) => { calls.push(args); return { ok: true, data: {} }; } };
    const engagement_id = uuidv7();
    const operator = createMcpServer(service, { id: "operator", role: "operator", engagement_id, transport_verified: true });
    const invalid = [
        ["adapter.status", []],
        ["adapter.status", null],
        ["query", { engagement_id, page_size: "1" }],
        ["query", { engagement_id, page_size: 1001 }],
        ["coverage.query", { engagement_id, status: "unknown" }],
        ["proposal.submit", { engagement_id, subject_type: "claim", expected_version: 0, content: { schema_version: "1.0.0", engagement_id, kind: "claim", proposition: "p", status: "proposed", evidence_refs: [], limitations: [], role: "operator" } }],
        ["engagement.init", { scope: { allowed_targets: "https://example.test", excluded_targets: [], rules_of_engagement_ref: "roe" } }],
        ["query", { engagement_id, cursor: "x".repeat(1024 * 1024) }],
    ];
    for (const [name, arguments_] of invalid) {
        const result = await operator.toolsCall({ name, arguments: arguments_ });
        assert.equal(parsed(result).error.code, "validation_error", name);
        assert.ok(result.content[0].text.length < 7000);
        assert.doesNotMatch(result.content[0].text, /https:\/\/example/);
    }
    assert.equal(calls.length, 0);
});

test("principal snapshots and schemas cannot be changed by tool callers", async () => {
    const engagement_id = uuidv7();
    const principal = { id: "host", role: "host", engagement_id, capabilities: [], transport_session_id: "fixed-session", transport_verified: true };
    let received;
    const server = createMcpServer({ dispatch: async (...args) => { received = args; return { ok: true, data: {} }; } }, principal);
    principal.id = "forged";
    principal.role = "operator";
    principal.capabilities.push("admit");
    const listing = server.toolsList();
    listing.tools.find((tool) => tool.name === "query").inputSchema.properties.role = {};
    for (const override of [{ role: "operator" }, { principal: "forged" }, { principal_id: "forged" }, { tenant: "other" }, { capabilities: ["admit"] }, { reviewer_attestation: {} }, { transport_session_id: "forged" }]) {
        assert.equal(parsed(await server.toolsCall({ name: "query", arguments: { engagement_id, ...override } })).error.code, "validation_error");
    }
    await server.toolsCall({ name: "query", arguments: { engagement_id } });
    assert.equal(received[1].id, "host");
    assert.equal(received[1].role, "host");
    assert.equal(received[1].transport_session_id, "fixed-session");
    assert.equal(received[1].capabilities.includes("admit"), false);
    assert.equal(Object.isFrozen(received[1]), true);
    assert.equal(Object.isFrozen(received[1].capabilities), true);
});
