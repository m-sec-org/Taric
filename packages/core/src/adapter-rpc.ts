import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CoreService, Principal } from "./service.js";
import { registerTransportPrincipal } from "./service.js";
import { ContractValidationError } from "./validation.js";

export interface AdapterRpcOptions { socket_path: string; token: string; principal: Principal; }
/** Authenticated line-delimited JSON-RPC transport for out-of-process adapters. */
export async function listenAdapterRpc(service: CoreService, options: AdapterRpcOptions): Promise<{ server: Server; close(): Promise<void> }> {
  if (!options.token || options.token.length < 32) throw new ContractValidationError("validation_error", "adapter RPC token must contain at least 32 characters");
  if (options.principal.role !== "host" || !options.principal.engagement_id) throw new ContractValidationError("authorization_error", "adapter RPC requires an engagement-scoped host principal");
  const principal = registerTransportPrincipal({ ...options.principal, transport_verified: true as const });
  await mkdir(dirname(options.socket_path), { recursive: true, mode: 0o700 });
  await unlink(options.socket_path).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); handleSocket(socket, service, principal, options.token); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socket_path, () => { server.off("error", reject); resolve(); }); });
  await chmod(options.socket_path, 0o600);
  return { server, close: async () => { const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy(); await stopped; await unlink(options.socket_path).catch(() => undefined); } };
}
function handleSocket(socket: Socket, service: CoreService, principal: Principal, token: string) {
  socket.setEncoding("utf8"); let buffer = "";
  let draining = false;
  socket.on("error", () => socket.destroy());
  const drain = async () => {
    if (draining) return;
    draining = true;
    socket.pause();
    try {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      if (Buffer.byteLength(line, "utf8") > 1024 * 1024) { socket.destroy(); return; }
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let response: Record<string, unknown>;
      let input: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      try { input = JSON.parse(line) as typeof input; }
      catch { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid request" } })}\n`); continue; }
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } })}\n`); continue; }
        const params = input.params;
        if (input.method !== "taric.dispatch" || !params || params.token !== token || typeof params.operation !== "string" || !params.request || typeof params.request !== "object" || Array.isArray(params.request)) {
          response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error" } };
        } else {
          const result = await service.dispatch(params.operation, principal, params.request as Record<string, unknown>);
          response = { jsonrpc: "2.0", id: input.id ?? null, result };
        }
      } catch {
        response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: false, error: { code: "internal_error", message: "internal error" } } };
      }
      socket.write(`${JSON.stringify(response)}\n`);
    }
    if (Buffer.byteLength(buffer, "utf8") > 1024 * 1024) socket.destroy();
    } finally {
      draining = false;
      if (!socket.destroyed) socket.resume();
    }
  };
  socket.on("data", (chunk) => {
    buffer += chunk;
    void drain().catch(() => socket.destroy());
  });
}
