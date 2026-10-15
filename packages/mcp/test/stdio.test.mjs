import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const serverPath = join(import.meta.dirname, "..", "dist", "bin.js");

/** stdio server 是长驻服务：写入请求后关闭 stdin，让 for-await 正常结束。 */
function runServer(input, { closeStdin = true, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const directory = mkdtempSync(join(tmpdir(), "taric-mcp-stdio-"));
    const child = spawn(process.execPath, [serverPath], { env: { ...process.env, TARIC_DB: join(directory, "authority.sqlite"), TARIC_CONTENT_ROOT: join(directory, "content"), ...env } });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP stdio timeout")); }, 15_000);
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
