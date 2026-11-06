import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPrincipal, describeOperationAccess, uuidv7 } from "@taric/core";
import { createMcpFrameDecoder, modelTools } from "../dist/server.js";

const serverPath = join(import.meta.dirname, "..", "dist", "bin.js");
const engagementId = uuidv7();

/** stdio server 是长驻服务：写入请求后关闭 stdin，让 for-await 正常结束。 */
function runServer(input, { closeStdin = true, env = {}, config } = {}) {
  return new Promise((resolve, reject) => {
    const directory = mkdtempSync(join(tmpdir(), "taric-mcp-stdio-"));
    const configPath = join(directory, "runtime.json");
    writeFileSync(configPath, JSON.stringify(config ?? {}));
    const child = spawn(process.execPath, [serverPath], { env: {
      ...process.env,
      TARIC_CONFIG: configPath,
      TARIC_DB: join(directory, "authority.sqlite"),
      TARIC_CONTENT_ROOT: join(directory, "content"),
      TARIC_PRINCIPAL_ROLE: undefined,
      TARIC_ENGAGEMENT_ID: engagementId,
      TARIC_HISTORY_READ_ENABLED: "false",
      TARIC_CONTENT_READ_ENABLED: "false",
      ...env,
    } });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`MCP stdio timeout for ${env.TARIC_PRINCIPAL_ROLE ?? config?.principal_role ?? "model"}`)); }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); resolve({ code, stdout, stderr }); });
    child.stdin.write(input);
    if (closeStdin) child.stdin.end();
  });
}

test("MCP stdio returns protocol JSON on stdout only", async () => {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    "",
  ].join("\n");
  const { stdout, stderr } = await runServer(input);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) JSON.parse(line);
  assert.equal(JSON.parse(lines[1]).result.tools.length > 0, true);
  assert.doesNotMatch(stdout, /SQLite|experimental/i);
  assert.match(stderr, /^$|Taric/);
});

test("MCP stdio advertises history tools only with the model history-read grant", async () => {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`;
  const denied = await runServer(request);
  assert.deepEqual(JSON.parse(denied.stdout.trim()).result.tools.map((tool) => tool.name), [...modelTools]);
  const granted = await runServer(request, { env: { TARIC_PRINCIPAL_ROLE: "model", TARIC_HISTORY_READ_ENABLED: "true" } });
  const tools = JSON.parse(granted.stdout.trim()).result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, [...modelTools, "history.query", "artifact.search", "artifact.history.read"]);
});

test("MCP stdio omits scoped tools for an unbound model", async () => {
  const result = await runServer('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', { env: { TARIC_ENGAGEMENT_ID: undefined } });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()).result.tools, []);
  assert.equal(result.stderr, "");
});

test("MCP stdio profiles expose the Core catalog and reject tool identity overrides", async () => {
  const reviewer_attestation = { capability: "model", model: "stdio-reviewer", prompt_digest: `sha256:${"a".repeat(64)}` };
  const profiles = [
    { role: "model" },
    { role: "host", config: { principal_role: "host", principal_capabilities: ["content_read"], transport_session_id: "stdio-host-session" } },
    { role: "reviewer", config: { principal_role: "reviewer", reviewer_attestation } },
    { role: "writer", env: { TARIC_PRINCIPAL_ROLE: "writer" } },
    { role: "operator", config: { principal_role: "operator", principal_capabilities: ["content_read"] }, env: { TARIC_ENGAGEMENT_ID: undefined } },
  ];
  for (const profile of profiles) {
    const engagement_id = profile.role === "operator" ? undefined : engagementId;
    const principal = createPrincipal(profile.role, `stdio-${profile.role}`, engagement_id, profile.config?.principal_capabilities, profile.config?.reviewer_attestation, profile.config?.transport_session_id);
    const expected = describeOperationAccess().filter((entry) => entry.roles.includes(principal.role)
      && (!entry.required_capability || principal.capabilities.includes(entry.required_capability))
      && (!entry.engagement_scoped || principal.engagement_id !== undefined || principal.role === "operator"));
    assert.ok(expected.length > 0, profile.role);
    const input = [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "core.dispatch", arguments: { operation: "engagement.init" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: expected[0].operation, arguments: { engagement_id: engagementId, principal_role: "operator", principal_id: "override-canary", principal_capabilities: ["operator"], transport_session_id: "override-session", reviewer_attestation: { capability: "human" } } } },
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
    ].map((request) => JSON.stringify(request)).join("\n") + "\n";
    const { code, stdout, stderr } = await runServer(input, profile);
    assert.equal(code, 0, profile.role);
    assert.equal(stderr, "", profile.role);
    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses.length, 4, profile.role);
    const tools = responses[0].result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), expected.map((entry) => entry.operation), profile.role);
    for (const [index, entry] of expected.entries()) {
      assert.deepEqual(tools[index].inputSchema, entry.request_schema, `${profile.role} ${entry.operation}`);
    }
    for (const [index, errorCode] of [[1, "authorization_error"], [2, "validation_error"]]) {
      assert.equal(responses[index].result.isError, true, profile.role);
      assert.equal(JSON.parse(responses[index].result.content[0].text).error.code, errorCode, profile.role);
    }
    assert.deepEqual(responses[3].result, responses[0].result, `${profile.role} identity is fixed for the process`);
    assert.doesNotMatch(stdout, /SQLite|experimental|taric-mcp-stdio|authority\.sqlite/i);
  }
});

test("MCP stdio rejects invalid trusted profiles before emitting protocol output", async () => {
  const invalidProfiles = [
    { env: { TARIC_PRINCIPAL_ROLE: "invalid-role-canary" } },
    { env: { TARIC_PRINCIPAL_ROLE: "host", TARIC_ENGAGEMENT_ID: undefined } },
    { env: { TARIC_ENGAGEMENT_ID: "invalid-engagement-canary" } },
    { config: { principal_role: "reviewer" } },
    { config: { principal_role: "reviewer", reviewer_attestation: { capability: "invalid-capability-canary" } } },
    { config: { principal_role: "reviewer", reviewer_attestation: { capability: "model", prompt_digest: "sha256:invalid-digest-canary" } } },
    { config: { principal_role: "model", reviewer_attestation: { capability: "human" } } },
    { config: { principal_role: "host", transport_session_id: " \t" } },
    { config: { principal_role: "host", transport_session_id: "s".repeat(257) } },
    { config: { principal_role: "writer", transport_session_id: "invalid-session-canary" } },
    { config: { principal_role: "operator", principal_capabilities: ["invalid-grant-canary"] } },
  ];
  for (const profile of invalidProfiles) {
    const result = await runServer('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', profile);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr.trim()), { ok: false, error: { code: "configuration_invalid", message: "invalid authority configuration" } });
    assert.doesNotMatch(result.stderr, /canary|runtime\.json|authority\.sqlite|taric-mcp-stdio|SQLite|experimental/i);
  }
});

test("MCP startup failure reports a stable diagnostic with no local paths on stdout or stderr", async () => {
  const result = await runServer("", { env: { TARIC_AUTHORITY_PROFILE: "multi_host_authority", TARIC_DATABASE_URL: "postgres://private-user:credential-canary@localhost/db", TARIC_HOST_ID: "host", TARIC_LEASE_MODE: "server_side" } });
  assert.equal(result.stdout, ""); const failure = JSON.parse(result.stderr.trim());
  assert.equal(failure.error.code, "postgresql_unavailable");
  assert.doesNotMatch(result.stderr, /credential-canary|authority.sqlite|taric-mcp-stdio|postgres:\/\//);
});

test("MCP stdio reports invalid JSON as a parse error on protocol channel", async () => {
  const { stdout } = await runServer("{oops\n");
  const envelope = JSON.parse(stdout.trim());
  assert.equal(envelope.error.code, -32700);
});

test("MCP stdio rejects non-object JSON and continues without leaking an exception", async () => {
  const { code, stdout, stderr } = await runServer('null\nfalse\n[]\n1\n{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
  assert.equal(code, 0);
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 5);
  for (const response of responses.slice(0, 4)) assert.deepEqual(response, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  assert.equal(responses[4].id, 7);
  assert.ok(responses[4].result.tools.length > 0);
  assert.doesNotMatch(stderr, /TypeError|\.ts:|\/Users\//);
});

test("MCP stdio rejects unsupported methods deterministically", async () => {
  const { stdout, stderr } = await runServer(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "admin/commit" })}\n`);
  const envelope = JSON.parse(stdout.trim());
  assert.equal(envelope.error.code, -32601);
  assert.match(stderr, /unsupported method/);
});

test("MCP stdio frame decoder bounds unterminated frames and resumes after draining", async () => {
  const frames = [];
  let oversized = 0;
  const decode = createMcpFrameDecoder(9, (line) => { frames.push(line); }, () => { oversized += 1; });
  await decode("1234567890");
  assert.equal(oversized, 1);
  assert.deepEqual(frames, []);
  await decode('\n{"ok":1}\n');
  assert.deepEqual(frames, ['{"ok":1}']);
});
