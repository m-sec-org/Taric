import { createServer, type Server, type Socket } from "node:net";
import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CoreService, Principal } from "./service.js";
import { registerTransportPrincipal } from "./service.js";
import { ContractValidationError } from "./validation.js";
import { ARTIFACT_CHUNK_BYTES, ARTIFACT_DEPLOYMENT_PROFILE, type ArtifactBinaryAppendStreamInput } from "./artifact-content-store.js";

export interface AdapterRpcOptions { socket_path: string; token: string; principal: Principal; }
export interface ArtifactBinaryRpcOptions extends AdapterRpcOptions { header_max_bytes?: number; queue_chunks?: number; }
const RPC_LINE_MAX_BYTES = ARTIFACT_DEPLOYMENT_PROFILE.json_rpc_line_max_bytes;
const RPC_ARTIFACT_READ_MAX_BYTES = ARTIFACT_DEPLOYMENT_PROFILE.json_rpc_artifact_read_max_decoded_bytes;
const RPC_ARTIFACT_PAGE_ITEMS_MAX = ARTIFACT_DEPLOYMENT_PROFILE.json_rpc_artifact_page_items_max;
const RPC_ARTIFACT_PAGE_CONTENT_MAX_BYTES = ARTIFACT_DEPLOYMENT_PROFILE.json_rpc_page_content_max_decoded_bytes;
async function waitForSocket(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw new ContractValidationError("unavailable_host", "RPC socket did not become available");
}
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
  await waitForSocket(options.socket_path);
  await chmod(options.socket_path, 0o600);
  return { server, close: async () => { const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy(); await stopped; await unlink(options.socket_path).catch(() => undefined); } };
}

/**
 * Authenticated raw Artifact append transport. The request is a 4-byte big-endian
 * header length, a bounded JSON header, then exactly `byte_length` raw bytes. It
 * deliberately does not share the 1 MiB JSON-RPC framing path.
 */
export async function listenArtifactBinaryRpc(service: CoreService, options: ArtifactBinaryRpcOptions): Promise<{ server: Server; close(): Promise<void> }> {
  if (!options.token || options.token.length < 32) throw new ContractValidationError("validation_error", "Artifact RPC token must contain at least 32 characters");
  if (options.principal.role !== "host" || !options.principal.engagement_id) throw new ContractValidationError("authorization_error", "Artifact RPC requires an engagement-scoped host principal");
  const principal = registerTransportPrincipal({ ...options.principal, transport_verified: true as const });
  const headerMax = options.header_max_bytes ?? ARTIFACT_DEPLOYMENT_PROFILE.binary_transport_header_max_bytes;
  const queueChunks = options.queue_chunks ?? ARTIFACT_DEPLOYMENT_PROFILE.receive_queue_chunks;
  if (!Number.isSafeInteger(headerMax) || headerMax < 1 || headerMax > ARTIFACT_DEPLOYMENT_PROFILE.json_metadata_max_bytes || !Number.isSafeInteger(queueChunks) || queueChunks < 1 || queueChunks > ARTIFACT_DEPLOYMENT_PROFILE.receive_queue_chunks)
    throw new ContractValidationError("validation_error", "invalid Artifact transport queue/header bounds");
  await mkdir(dirname(options.socket_path), { recursive: true, mode: 0o700 });
  await unlink(options.socket_path).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
  const sockets = new Set<Socket>();
  // Clients half-close after the declared body; keep the response side open
  // while the bounded stream append finishes and publishes its result.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (sockets.size >= ARTIFACT_DEPLOYMENT_PROFILE.active_uploads_max) {
      sendArtifactTransportError(socket, "unavailable_host", "Artifact receive capacity is busy; retry after an active upload completes");
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleArtifactBinarySocket(socket, service, principal, options.token, headerMax, queueChunks);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socket_path, () => { server.off("error", reject); resolve(); }); });
  await waitForSocket(options.socket_path);
  await chmod(options.socket_path, 0o600);
  return { server, close: async () => { const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy(); await stopped; await unlink(options.socket_path).catch(() => undefined); } };
}

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #items: Buffer[] = [];
  readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;
  #failure?: Error;
  constructor(readonly maxItems: number, readonly onDrain: () => void) {}
  push(item: Buffer): boolean {
    if (this.#ended) return false;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else if (this.#items.length >= this.maxItems) return false;
    else this.#items.push(item);
    return true;
  }
  end(): void { this.#ended = true; while (this.#waiters.length) this.#waiters.shift()!({ value: undefined, done: true }); }
  fail(cause: Error): void { this.#failure = cause; this.#ended = true; while (this.#waiters.length) this.#waiters.shift()!({ value: undefined, done: true }); }
  async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.#items.length) { const item = this.#items.shift()!; this.onDrain(); return { value: item, done: false }; }
    if (this.#failure) throw this.#failure;
    if (this.#ended) return { value: undefined, done: true };
    return await new Promise<IteratorResult<Uint8Array>>((resolve) => this.#waiters.push(resolve));
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return this; }
}

function sendArtifactTransportError(socket: Socket, code: string, message: string): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
}
async function writeRpcLine(socket: Socket, line: string): Promise<void> {
  if (socket.destroyed || socket.write(line)) return;
  await new Promise<void>((resolve) => {
    const done = () => { socket.off("drain", done); socket.off("close", done); socket.off("error", done); resolve(); };
    socket.once("drain", done); socket.once("close", done); socket.once("error", done);
  });
}

function handleArtifactBinarySocket(socket: Socket, service: CoreService, principal: Principal, token: string, headerMax: number, queueChunks: number): void {
  socket.pause(); socket.setTimeout(30_000, () => socket.destroy()); let input = Buffer.alloc(0); let headerDone = false; let expectedBytes = 0; let bodyReceived = 0; let queue: ByteQueue | undefined; let pending: Buffer | undefined; let completed = false; let rejected = false; let inputEnded = false;
  const reject = (code: string, message: string) => { if (rejected) return; rejected = true; queue?.fail(new Error(message)); socket.pause(); if (!queue) sendArtifactTransportError(socket, code, message); };
  const finishBody = () => {
    if (inputEnded && !pending && !completed) {
      if (bodyReceived !== expectedBytes) reject("validation_error", "binary Artifact body ended before its declared byte_length");
      else { queue!.end(); completed = true; }
    }
  };
  const drainPending = () => {
    while (pending && queue && pending.length > 0) {
      const part = pending.subarray(0, ARTIFACT_DEPLOYMENT_PROFILE.receive_chunk_bytes);
      if (!queue.push(part)) return;
      pending = pending.subarray(part.length);
    }
    if (!pending || pending.length === 0) { pending = undefined; finishBody(); if (!socket.destroyed && !completed) socket.resume(); }
  };
  const feed = (chunk: Buffer) => {
    if (bodyReceived + chunk.length > expectedBytes) {
      reject("validation_error", "binary Artifact transport received trailing bytes");
      return;
    }
    bodyReceived += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      const part = chunk.subarray(offset, offset + ARTIFACT_DEPLOYMENT_PROFILE.receive_chunk_bytes);
      if (!queue!.push(part)) { pending = chunk.subarray(offset); socket.pause(); return; }
      offset += part.length;
    }
    finishBody();
  };
  const parseHeader = () => {
    if (input.length < 4) return false;
    const length = input.readUInt32BE(0);
    if (length < 2 || length > headerMax) { reject("validation_error", "binary Artifact header exceeds its bound"); return false; }
    if (input.length < 4 + length) return false;
    let header: { token?: unknown; operation?: unknown; request?: Record<string, unknown> };
    try { header = JSON.parse(input.subarray(4, 4 + length).toString("utf8")) as typeof header; } catch { reject("validation_error", "invalid binary Artifact header"); return false; }
    const request = header.request;
    if (header.token !== token || header.operation !== "artifact.store.append.binary" || !request || typeof request !== "object" || Array.isArray(request)) { reject("authorization_error", "invalid binary Artifact transport credentials"); return false; }
    const allowedFields = new Set(["engagement_id", "session_id", "upload_id", "ordinal", "byte_length", "chunk_hash", "idempotency_key"]);
    if (Object.keys(request).some((key) => !allowedFields.has(key))) { reject("validation_error", "binary Artifact request contains unsupported fields"); return false; }
    if (["engagement_id", "session_id", "upload_id", "chunk_hash"].some((key) => typeof request[key] !== "string") ||
        (request.idempotency_key !== undefined && typeof request.idempotency_key !== "string") ||
        typeof request.ordinal !== "number" || !Number.isSafeInteger(request.ordinal) || request.ordinal < 0 ||
        typeof request.byte_length !== "number" || !Number.isSafeInteger(request.byte_length) || request.byte_length < 1 || request.byte_length > ARTIFACT_CHUNK_BYTES) {
      reject("validation_error", "binary Artifact request metadata is invalid"); return false;
    }
    expectedBytes = request.byte_length;
    queue = new ByteQueue(queueChunks, drainPending);
    void service.artifactStoreAppendBinaryStream(principal, request as unknown as ArtifactBinaryAppendStreamInput, queue).then((result) => { if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`); }).catch(() => { if (!socket.destroyed) sendArtifactTransportError(socket, "internal_error", "internal error"); });
    headerDone = true; input = input.subarray(4 + length); if (input.length) feed(input); input = Buffer.alloc(0); return true;
  };
  socket.on("error", (cause) => queue?.fail(cause instanceof Error ? cause : new Error("socket closed")));
  socket.on("end", () => { inputEnded = true; if (!headerDone) reject("validation_error", "binary Artifact header ended early"); else finishBody(); });
  socket.once("close", () => { if (!completed && !inputEnded) queue?.fail(new Error("binary Artifact transport closed")); });
  socket.on("data", (chunk) => {
    if (rejected || completed) { if (!completed) return; reject("validation_error", "binary Artifact transport received trailing bytes"); return; }
    if (!headerDone) {
      input = Buffer.concat([input, chunk]);
      if (!parseHeader()) return;
    }
    else feed(chunk);
  });
  socket.resume();
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
      if (Buffer.byteLength(line, "utf8") > RPC_LINE_MAX_BYTES) { socket.destroy(); return; }
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let response: Record<string, unknown>;
      let input: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      try { input = JSON.parse(line) as typeof input; }
      catch { await writeRpcLine(socket, `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid request" } })}\n`); continue; }
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) { await writeRpcLine(socket, `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } })}\n`); continue; }
        const params = input.params;
        if (input.method !== "taric.dispatch" || !params || params.token !== token || typeof params.operation !== "string" || !params.request || typeof params.request !== "object" || Array.isArray(params.request)) {
          response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error" } };
        } else {
          const request = params.request as Record<string, unknown>;
          const readsArtifactContent = params.operation === "artifact.content.read" || (params.operation === "artifact.content.list" && request.include_content === true) || (params.operation === "artifact.session.output" && request.include_content === true);
          const requestedMax = request.max_response_bytes;
          if (readsArtifactContent && requestedMax !== undefined && (typeof requestedMax !== "number" || !Number.isSafeInteger(requestedMax) || requestedMax < 1 || requestedMax > RPC_ARTIFACT_READ_MAX_BYTES)) {
            response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: false, error: { code: "validation_error", message: "ordinary JSON-RPC Artifact reads are limited to 512 KiB decoded per response" } } };
          } else {
            let boundedRequest = readsArtifactContent ? { ...request, max_response_bytes: requestedMax ?? RPC_ARTIFACT_READ_MAX_BYTES } : request;
            if (params.operation === "artifact.content.list" || params.operation === "artifact.session.output") {
              boundedRequest = { ...boundedRequest, page_size: Math.min(typeof request.page_size === "number" ? request.page_size : RPC_ARTIFACT_PAGE_ITEMS_MAX, RPC_ARTIFACT_PAGE_ITEMS_MAX) };
            }
            if (readsArtifactContent && params.operation !== "artifact.content.read") boundedRequest.max_response_bytes = Math.min(typeof boundedRequest.max_response_bytes === "number" ? boundedRequest.max_response_bytes : RPC_ARTIFACT_PAGE_CONTENT_MAX_BYTES, RPC_ARTIFACT_PAGE_CONTENT_MAX_BYTES);
            const result = await service.dispatch(params.operation, principal, boundedRequest);
            response = { jsonrpc: "2.0", id: input.id ?? null, result };
          }
        }
      } catch {
        response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: false, error: { code: "internal_error", message: "internal error" } } };
      }
      let encoded = `${JSON.stringify(response)}\n`;
      if (Buffer.byteLength(encoded, "utf8") > RPC_LINE_MAX_BYTES) {
        const id = typeof input.id === "string" && input.id.length <= 128 || typeof input.id === "number" ? input.id : null;
        encoded = `${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: false, error: { code: "validation_error", message: "JSON-RPC response exceeds the 1 MiB line limit; reduce the Artifact page or byte range" } } })}\n`;
      }
      await writeRpcLine(socket, encoded);
    }
    if (Buffer.byteLength(buffer, "utf8") > RPC_LINE_MAX_BYTES) socket.destroy();
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
