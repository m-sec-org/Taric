import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CoreService, Principal } from "./service.js";
import { registerTransportPrincipal } from "./service.js";

export interface AdapterRpcOptions { socket_path: string; token: string; principal: Principal; }
/** Authenticated line-delimited JSON-RPC transport for out-of-process adapters. */
export async function listenAdapterRpc(service: CoreService, options: AdapterRpcOptions): Promise<{ server: Server; close(): Promise<void> }> {
  if (!options.token || options.token.length < 32) throw new Error("adapter RPC token must contain at least 32 characters");
  if (options.principal.role !== "host" || !options.principal.engagement_id) throw new Error("adapter RPC requires an engagement-scoped host principal");
  const principal = registerTransportPrincipal({ ...options.principal, transport_verified: true as const });
  await mkdir(dirname(options.socket_path), { recursive: true, mode: 0o700 });
  await unlink(options.socket_path).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
  const server = createServer((socket) => handleSocket(socket, service, principal, options.token));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socket_path, () => { server.off("error", reject); resolve(); }); });
  await chmod(options.socket_path, 0o600);
  return { server, close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await unlink(options.socket_path).catch(() => undefined); } };
}
function handleSocket(socket: Socket, service: CoreService, principal: Principal, token: string) {
  socket.setEncoding("utf8"); let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
    const newline = buffer.indexOf("\n"); if (newline < 0) return;
    const line = buffer.slice(0, newline); buffer = "";
    let response: Record<string, unknown>;
    try {
      const input = JSON.parse(line) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      const params = input.params;
      if (input.method !== "taric.dispatch" || !params || params.token !== token || typeof params.operation !== "string" || !params.request || typeof params.request !== "object" || Array.isArray(params.request)) {
        response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error" } };
      } else {
        const result = service.dispatch(params.operation, principal, params.request as Record<string, unknown>);
        response = { jsonrpc: "2.0", id: input.id ?? null, result };
      }
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid request" } };
    }
    socket.end(`${JSON.stringify(response)}\n`);
  });
}
