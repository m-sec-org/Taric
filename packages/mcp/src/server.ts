import { API_CONTRACT_VERSION, createCoreServiceForPath, createPrincipal, type CoreService, type Principal } from "@taric/core";

export const modelTools = ["context.query", "resource.query", "evidence.query", "proposal.submit", "checkpoint.propose", "action.recommend"] as const;

const toolSchemas: Record<(typeof modelTools)[number], { required: string[]; properties: Record<string, unknown> }> = {
  "context.query": { required: ["engagement_id"], properties: { engagement_id: { type: "string" }, work_run_id: { type: "string" }, budget: { type: "integer", minimum: 1 } } },
  "resource.query": { required: ["engagement_id"], properties: { engagement_id: { type: "string" }, as_of: { type: "integer", minimum: 0 } } },
  "evidence.query": { required: ["engagement_id"], properties: { engagement_id: { type: "string" }, as_of: { type: "integer", minimum: 0 } } },
  "proposal.submit": { required: ["engagement_id", "subject_type", "content"], properties: { engagement_id: { type: "string" }, subject_type: { type: "string" }, base_version: { type: "integer", minimum: 0 }, content: { type: "object" } } },
  "checkpoint.propose": { required: ["engagement_id", "work_run_id", "generation", "checkpoint"], properties: { engagement_id: { type: "string" }, work_run_id: { type: "string" }, generation: { type: "integer", minimum: 1 }, checkpoint: { type: "object" } } },
  "action.recommend": { required: ["engagement_id", "target", "method", "rationale"], properties: { engagement_id: { type: "string" }, work_run_id: { type: "string" }, target: { type: "string" }, method: { type: "string" }, rationale: { type: "string" } } },
};

export function createMcpServer(service: CoreService, principal: Principal = { id: "mcp-model", role: "model", transport_verified: true }) {
  const authenticatedPrincipal = createPrincipal(principal.role, principal.id, principal.engagement_id);
  return {
    initialize(params: Record<string, unknown>) {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      return { protocolVersion: "2024-11-05", serverInfo: { name: "taric-mcp", version: API_CONTRACT_VERSION }, capabilities: { tools: {} }, instructions: "Taric 只提供受限的模型能力；授权与目标执行由宿主负责。" };
    },
    toolsList() { return { tools: modelTools.map((name) => ({ name, description: `Taric Phase 1 模型工具 ${name}`, inputSchema: { type: "object", additionalProperties: false, properties: toolSchemas[name].properties, required: toolSchemas[name].required } })) }; },
    toolsCall(params: { name: string; arguments?: Record<string, unknown> }) {
      if (!(modelTools as readonly string[]).includes(params.name)) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "authorization_error", message: "tool is not available to model clients" } }) }], isError: true };
      const schema = toolSchemas[params.name as (typeof modelTools)[number]];
      const arguments_ = params.arguments ?? {};
      const missing = schema.required.filter((key) => arguments_[key] === undefined);
      if (missing.length) return toolError("validation_error", `missing required arguments: ${missing.join(", ")}`);
      const unexpected = Object.keys(arguments_).filter((key) => !(key in schema.properties));
      if (unexpected.length) return toolError("validation_error", `unexpected arguments: ${unexpected.join(", ")}`);
      const response = service.dispatch(params.name, authenticatedPrincipal, params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(response) }], isError: !response.ok };
    }
  };
}

function toolError(code: string, message: string) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message } }) }], isError: true }; }

export function createMcpService() { return createCoreServiceForPath(process.env.TARIC_DB ?? ":memory:"); }

/** MCP stdio 仅在 stdout 写协议响应，诊断一律写 stderr。 */
export async function runMcpStdio(service = createMcpService()): Promise<void> {
  const server = createMcpServer(service, { id: process.env.TARIC_PRINCIPAL_ID ?? "mcp-model", role: "model", engagement_id: process.env.TARIC_ENGAGEMENT_ID, transport_verified: true });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request: { id?: string | number; method?: string; params?: Record<string, unknown> };
      try { request = JSON.parse(line) as typeof request; } catch {
        // JSON-RPC parse errors are protocol responses and must stay on stdout;
        // diagnostics are separate so a client can parse every stdout line.
        const parseError = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
        process.stdout.write(`${JSON.stringify(parseError)}\n`);
        process.stderr.write("taric-mcp: invalid JSON\n");
        continue;
      }
      let result: unknown;
      if (request.method === "initialize") result = server.initialize(request.params ?? {});
      else if (request.method === "tools/list") result = server.toolsList();
      else if (request.method === "tools/call") {
        const call = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!call || typeof call.name !== "string") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "Invalid params" } })}\n`); continue; }
        result = server.toolsCall({ name: call.name, arguments: call.arguments });
      }
      else {
        process.stderr.write(`taric-mcp: unsupported method ${JSON.stringify(String(request.method))}\n`);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: "Method not found" } })}\n`);
        continue;
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result })}\n`);
    }
  }
}

