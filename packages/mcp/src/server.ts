import { API_CONTRACT_VERSION, ContractValidationError, RuntimeStartupError, createPrincipal, describeOperationAccess, discoverRuntimeConfig, openRuntimeService, resolveRuntimeAuthority, validateOperationRequest, type CoreService, type ContractDiagnosticDetails, type Principal, type RuntimeStartupOptions } from "@taric/core";

const operationAccess = describeOperationAccess();
export const historyTools = ["history.query", "artifact.search", "artifact.history.read"] as const;
export const modelTools = Object.freeze(operationAccess.filter((entry) => entry.roles.includes("model") && (!entry.required_capability || ["read", "propose"].includes(entry.required_capability))).map((entry) => entry.operation));
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_APPEND_ARGUMENT_BYTES = 89478488 + MAX_ARGUMENT_BYTES;
const MAX_RPC_FRAME_BYTES = MAX_APPEND_ARGUMENT_BYTES + 64 * 1024;

function fixedPrincipal(principal: Principal): Principal {
  if (!["model", "host", "reviewer", "writer", "operator"].includes(principal.role) || typeof principal.id !== "string" || !principal.id.trim() || principal.id.length > 256) throw new ContractValidationError("validation_error", "invalid MCP principal configuration");
  if (principal.engagement_id !== undefined && (typeof principal.engagement_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(principal.engagement_id))) throw new ContractValidationError("validation_error", "invalid MCP Engagement binding");
  if (principal.role !== "model" && principal.role !== "operator" && !principal.engagement_id) throw new ContractValidationError("validation_error", "MCP profile requires an Engagement binding");
  if (principal.role === "reviewer" && !principal.reviewer_attestation) throw new ContractValidationError("validation_error", "MCP reviewer profile requires trusted attestation");
  const allowedGrants = ["read", "propose", "review", "admit", "work", "checkpoint", "action", "audit", "operator", "writer", "content", "content_read", "history_read"];
  if (principal.capabilities !== undefined && (!Array.isArray(principal.capabilities) || principal.capabilities.some((grant) => !allowedGrants.includes(grant)))) throw new ContractValidationError("validation_error", "invalid MCP capability grant");
  if (principal.capabilities?.includes("history_read") && principal.role !== "model") throw new ContractValidationError("validation_error", "history_read requires a model MCP principal");
  if (principal.capabilities?.includes("content_read") && !["host", "operator"].includes(principal.role)) throw new ContractValidationError("validation_error", "content_read requires a host or operator MCP principal");
  const bound = createPrincipal(principal.role, principal.id, principal.engagement_id, principal.capabilities, principal.reviewer_attestation, principal.transport_session_id);
  Object.freeze(bound.capabilities);
  if (bound.reviewer_attestation) Object.freeze(bound.reviewer_attestation);
  return Object.freeze(bound);
}

export function createMcpServer(service: CoreService, principal: Principal = { id: "mcp-model", role: "model", transport_verified: true }) {
  const authenticatedPrincipal = fixedPrincipal(principal);
  const granted = operationAccess.filter((entry) => entry.roles.includes(authenticatedPrincipal.role)
    && (!entry.required_capability || authenticatedPrincipal.capabilities?.includes(entry.required_capability))
    && (!entry.engagement_scoped || authenticatedPrincipal.engagement_id !== undefined || authenticatedPrincipal.role === "operator"));
  const grantedNames = new Set(granted.map((entry) => entry.operation));
  return {
    initialize(_params: Record<string, unknown>) {
      return { protocolVersion: "2024-11-05", serverInfo: { name: "taric-mcp", version: API_CONTRACT_VERSION }, capabilities: { tools: {} }, instructions: "Taric tools use one fixed principal and Core authorization. The host owns target execution and action approval." };
    },
    toolsList() { return { tools: granted.map((entry) => ({ name: entry.operation, description: `Taric Core operation ${entry.operation}`, inputSchema: structuredClone(entry.request_schema) })) }; },
    async toolsCall(params: { name: string; arguments?: unknown }) {
      if (!grantedNames.has(params.name)) return toolError("authorization_error", "tool is not available to this principal");
      const arguments_ = params.arguments === undefined ? {} : params.arguments;
      let serialized: string;
      try { serialized = JSON.stringify(arguments_); } catch { return toolError("validation_error", "arguments must be JSON"); }
      if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > (params.name === "artifact.store.append" ? MAX_APPEND_ARGUMENT_BYTES : MAX_ARGUMENT_BYTES)) return toolError("validation_error", "arguments exceed the request limit");
      const invalid = validateOperationRequest(params.name, arguments_);
      if (invalid) return { content: [{ type: "text", text: JSON.stringify(invalid) }], isError: true };
      const response = await service.dispatch(params.name, authenticatedPrincipal, arguments_ as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(response) }], isError: !response.ok };
    }
  };
}

function toolError(code: string, message: string, details?: ContractDiagnosticDetails) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) }], isError: true }; }

/** MCP defaults to model; explicit trusted configuration selects other roles. */
function mcpStartupOptions(options: RuntimeStartupOptions): RuntimeStartupOptions {
  const env = { ...(options.env ?? process.env) };
  const discovered = options.config === undefined ? discoverRuntimeConfig(env, options.cwd, options.home, options.runtimeConfigPath) : undefined;
  return { ...options, env, config: structuredClone(options.config ?? discovered!.config), runtimeConfigProvenance: options.runtimeConfigProvenance ?? discovered?.provenance, defaultPrincipalRole: "model" };
}
export function resolveMcpStartup(options: RuntimeStartupOptions = {}) {
  const startup = resolveRuntimeAuthority(mcpStartupOptions(options));
  fixedPrincipal({ ...startup.principal, transport_verified: true });
  return startup;
}
export function createMcpService(options: RuntimeStartupOptions = {}) {
  const startupOptions = mcpStartupOptions(options);
  resolveMcpStartup(startupOptions);
  return openRuntimeService(startupOptions);
}

export function createMcpFrameDecoder(maxFrameBytes: number, onFrame: (line: string) => void | Promise<void>, onOversizedFrame: () => void): (chunk: string) => Promise<void> {
  let buffer = "";
  let bufferBytes = 0;
  let discardingOversizedFrame = false;
  return async (chunk) => {
    let offset = 0;
    while (offset <= chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.slice(offset, end);
      if (discardingOversizedFrame) {
        if (newline !== -1) {
          discardingOversizedFrame = false;
          buffer = "";
          bufferBytes = 0;
        }
      } else {
        const segmentBytes = Buffer.byteLength(segment, "utf8");
        const frameBytes = bufferBytes + segmentBytes + (newline === -1 ? 0 : 1);
        if (frameBytes > maxFrameBytes) {
          onOversizedFrame();
          buffer = "";
          bufferBytes = 0;
          discardingOversizedFrame = newline === -1;
        } else {
          buffer += segment;
          bufferBytes += segmentBytes;
          if (newline !== -1) {
            await onFrame(buffer);
            buffer = "";
            bufferBytes = 0;
          }
        }
      }
      if (newline === -1) break;
      offset = newline + 1;
    }
  };
}

/** MCP stdio 仅在 stdout 写协议响应，诊断一律写 stderr。 */
export async function runMcpStdio(service?: CoreService): Promise<void> {
  let actualService = service;
  let server: ReturnType<typeof createMcpServer>;
  try {
      const startupOptions = mcpStartupOptions({});
      const startup = resolveMcpStartup(startupOptions);
      if (!actualService) actualService = await openRuntimeService(startupOptions);
      server = createMcpServer(actualService, { ...startup.principal, transport_verified: true });
  } catch (cause) {
      const error = cause instanceof RuntimeStartupError
        ? { code: cause.code, message: cause.diagnostics.message, follow_up: cause.diagnostics.follow_up }
        : { code: "configuration_invalid", message: "invalid authority configuration" };
      process.stderr.write(`${JSON.stringify({ ok: false, error })}\n`);
      process.exitCode = 1;
      return;
  }
  if (!actualService) return;
  const decodeFrame = createMcpFrameDecoder(MAX_RPC_FRAME_BYTES,
    (line) => processMcpLine(line, server),
    () => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request frame too large" } })}\n`));
  process.stdin.setEncoding("utf8");
  try {
  for await (const chunk of process.stdin) {
    await decodeFrame(String(chunk));
  }
  } finally { if (!service) await actualService.close(); }
}

async function processMcpLine(line: string, server: ReturnType<typeof createMcpServer>): Promise<void> {
      if (!line.trim()) return;
      let request: { id?: string | number; method?: string; params?: Record<string, unknown> };
      try { request = JSON.parse(line) as typeof request; } catch {
        // JSON-RPC parse errors are protocol responses and must stay on stdout;
        // diagnostics are separate so a client can parse every stdout line.
        const parseError = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
        process.stdout.write(`${JSON.stringify(parseError)}\n`);
        process.stderr.write("taric-mcp: invalid JSON\n");
        return;
      }
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } })}\n`);
        return;
      }
      let result: unknown;
      if (request.method === "initialize") result = server.initialize(request.params ?? {});
      else if (request.method === "tools/list") result = server.toolsList();
      else if (request.method === "tools/call") {
        const call = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!call || typeof call.name !== "string") { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: "Invalid params" } })}\n`); return; }
        result = await server.toolsCall({ name: call.name, arguments: call.arguments });
      }
      else {
        process.stderr.write(`taric-mcp: unsupported method ${JSON.stringify(String(request.method))}\n`);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: "Method not found" } })}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result })}\n`);
}

