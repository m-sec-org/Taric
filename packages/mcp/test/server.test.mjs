import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createCoreService, ContractValidationError, uuidv7 } from "@taric/core";
import { modelTools, createMcpServer, resolveMcpStartup } from "../dist/server.js";
import { resolveCliStartup, runCli } from "../../cli/dist/cli.js";
async function modelService() {
    const store = new AuthorityStore();
    const service = (await createCoreService(store));
    return { store, service, principal: { id: "mcp-model", role: "model", engagement_id: "engagement-a", transport_verified: true } };
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
test("CLI and MCP resolve the same backend, authority and content settings", () => {
    const config = { db_path: "/synthetic/authority.sqlite", content_root: "/synthetic/content", principal_id: "host", principal_role: "host" };
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
    const result = (await server.toolsCall({ name: "resource.query", arguments: { engagement_id: "engagement-b" } }));
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
