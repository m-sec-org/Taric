import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type TlsOptions } from "node:tls";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CoreService, Principal } from "./service.js";
import { registerTransportPrincipal } from "./service.js";
import { ContractValidationError } from "./validation.js";
import { ARTIFACT_CHUNK_BYTES, ARTIFACT_DEPLOYMENT_PROFILE, type ArtifactBinaryAppendStreamInput } from "./artifact-content-store.js";

export interface AdapterRpcOptions {
  socket_path?: string;
  tls_tcp?: { host: string; port: number; key: TlsOptions["key"]; cert: TlsOptions["cert"]; max_connections?: number };
  network_content_root?: string;
  token: string;
  /** 单 principal 模式的 listener 身份；提供 resolvePrincipal 时可省略。 */
  principal?: Principal;
  /** 可选多 principal 解析：连接首帧声明身份，resolver 拥有 token↔身份映射的
   * 全部校验；请求体永不自选身份。未提供时 listener 保持单 principal 行为。 */
  resolvePrincipal?: (declared: { role: import("./service.js").PrincipalRole; principal_id: string; engagement_id?: string }, token: string) => Principal | Promise<Principal>;
}
export interface AdapterHttpsRpcOptions {
  host: string;
  port: number;
  key: TlsOptions["key"];
  cert: TlsOptions["cert"];
  resolvePrincipal(token: string): Principal | undefined | Promise<Principal | undefined>;
  network_content_root?: string;
  path?: string;
  max_connections?: number;
  max_concurrent_requests?: number;
  request_timeout_ms?: number;
}
export const NETWORK_RPC_MAX_CONNECTIONS = 128;
export const NETWORK_RPC_MAX_CONCURRENT_REQUESTS = 64;
export const NETWORK_RPC_REQUEST_TIMEOUT_MS = 30_000;
export const NETWORK_RPC_IDLE_TIMEOUT_MS = 30_000;
export interface ArtifactBinaryRpcOptions extends AdapterRpcOptions { header_max_bytes?: number; queue_chunks?: number; }
const RPC_LINE_MAX_BYTES = ARTIFACT_DEPLOYMENT_PROFILE.json_rpc_line_max_bytes;
const RPC_ARTIFACT_READ_MAX_BYTES = ARTIFACT_DEPLOYMENT_PROFILE.json_rpc_artifact_read_max_decoded_bytes;
const RPC_ARTIFACT_PAGE_ITEMS_MAX = ARTIFACT_DEPLOYMENT_PROFILE.json_rpc_artifact_page_items_max;
const RPC_ARTIFACT_PAGE_CONTENT_MAX_BYTES = ARTIFACT_DEPLOYMENT_PROFILE.json_rpc_page_content_max_decoded_bytes;
const RPC_NOTIFICATION_MAX_QUEUED_BYTES = 64 * 1024;
async function waitForSocket(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw new ContractValidationError("unavailable_host", "RPC socket did not become available");
}
/** Authenticated line-delimited JSON-RPC transport for out-of-process adapters. */
export async function listenAdapterRpc(service: CoreService, options: AdapterRpcOptions): Promise<{ server: Server; close(): Promise<void> }> {
  if (!options.token || options.token.length < 32) throw new ContractValidationError("validation_error", "adapter RPC token must contain at least 32 characters");
  if (!options.resolvePrincipal && (!options.principal || options.principal.role !== "host" || !options.principal.engagement_id)) throw new ContractValidationError("authorization_error", "adapter RPC requires an engagement-scoped host principal or a principal resolver");
  const network = options.tls_tcp;
  if (Boolean(options.socket_path) === Boolean(network)) throw new ContractValidationError("validation_error", "adapter RPC requires exactly one Unix socket or TLS TCP endpoint");
  if (network && (!network.host.trim() || !Number.isInteger(network.port) || network.port < 1 || network.port > 65535 || !network.key || !network.cert)) throw new ContractValidationError("validation_error", "TLS TCP adapter endpoint is invalid");
  if (network && options.network_content_root !== undefined && !options.network_content_root.trim()) throw new ContractValidationError("validation_error", "TLS TCP network_content_root is invalid");
  if (network && network.max_connections !== undefined && (!Number.isInteger(network.max_connections) || network.max_connections < 1 || network.max_connections > NETWORK_RPC_MAX_CONNECTIONS)) throw new ContractValidationError("validation_error", "TLS TCP max_connections is outside the supported bound");
  const principal = options.principal ? registerTransportPrincipal({ ...options.principal, transport_verified: true as const }) : undefined;
  const socketPath = options.socket_path;
  if (socketPath) {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await unlink(socketPath).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
  }
  const sockets = new Set<Socket>();
  const onConnection = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (network) socket.setTimeout(NETWORK_RPC_IDLE_TIMEOUT_MS, () => socket.destroy());
    handleSocket(socket, service, principal, options.token, options.resolvePrincipal, Boolean(network), options.network_content_root);
  };
  const server = network
    ? createTlsServer({ key: network.key, cert: network.cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.3", handshakeTimeout: 10_000 }, onConnection)
    : createServer(onConnection);
  if (network) server.maxConnections = network.max_connections ?? NETWORK_RPC_MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const listening = () => { server.off("error", reject); resolve(); };
    if (network) server.listen({ host: network.host, port: network.port }, listening);
    else server.listen(socketPath!, listening);
  });
  if (socketPath) { await waitForSocket(socketPath); await chmod(socketPath, 0o600); }
  return { server, close: async () => { const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy(); await stopped; if (socketPath) await unlink(socketPath).catch(() => undefined); } };
}

/** Stateless HTTPS JSON-RPC endpoint for remote hosts. */
export async function listenAdapterHttpsRpc(service: CoreService, options: AdapterHttpsRpcOptions): Promise<{ server: HttpsServer; close(): Promise<void> }> {
  const route = options.path ?? "/rpc";
  const maxConnections = options.max_connections ?? NETWORK_RPC_MAX_CONNECTIONS;
  const maxConcurrent = options.max_concurrent_requests ?? NETWORK_RPC_MAX_CONCURRENT_REQUESTS;
  const requestTimeout = options.request_timeout_ms ?? NETWORK_RPC_REQUEST_TIMEOUT_MS;
  if (!options.host.trim() || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !options.key || !options.cert || typeof options.resolvePrincipal !== "function") throw new ContractValidationError("validation_error", "HTTPS adapter endpoint is invalid");
  if (options.network_content_root !== undefined && !options.network_content_root.trim()) throw new ContractValidationError("validation_error", "HTTPS network_content_root is invalid");
  if (!route.startsWith("/") || route.includes("?") || route.includes("#")) throw new ContractValidationError("validation_error", "HTTPS adapter path is invalid");
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > NETWORK_RPC_MAX_CONNECTIONS || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > NETWORK_RPC_MAX_CONCURRENT_REQUESTS || !Number.isInteger(requestTimeout) || requestTimeout < 100 || requestTimeout > NETWORK_RPC_REQUEST_TIMEOUT_MS) throw new ContractValidationError("validation_error", "HTTPS adapter limits exceed the supported bounds");
  let activeRequests = 0;
  const sockets = new Set<Socket>();
  const server = createHttpsServer({ key: options.key, cert: options.cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.3", handshakeTimeout: 10_000 }, (request, response) => {
    void handleHttpsRequest(service, options, route, maxConcurrent, requestTimeout, request, response, () => activeRequests, (value) => { activeRequests = value; });
  });
  server.on("connection", (stream) => { const socket = stream as Socket; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.maxConnections = maxConnections;
  server.headersTimeout = 10_000;
  server.requestTimeout = requestTimeout;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: options.host, port: options.port }, () => { server.off("error", reject); resolve(); });
  });
  return { server, close: async () => { const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy(); await stopped; } };
}

/**
 * Authenticated raw Artifact append transport. The request is a 4-byte big-endian
 * header length, a bounded JSON header, then exactly `byte_length` raw bytes. It
 * deliberately does not share the 1 MiB JSON-RPC framing path.
 */
export async function listenArtifactBinaryRpc(service: CoreService, options: ArtifactBinaryRpcOptions): Promise<{ server: Server; close(): Promise<void> }> {
  if (!options.token || options.token.length < 32) throw new ContractValidationError("validation_error", "Artifact RPC token must contain at least 32 characters");
  if (!options.socket_path) throw new ContractValidationError("validation_error", "Artifact RPC requires a Unix socket path");
  const socketPath = options.socket_path;
  if (!options.principal || options.principal.role !== "host" || !options.principal.engagement_id) throw new ContractValidationError("authorization_error", "Artifact RPC requires an engagement-scoped host principal");
  const principal = registerTransportPrincipal({ ...options.principal, transport_verified: true as const });
  const headerMax = options.header_max_bytes ?? ARTIFACT_DEPLOYMENT_PROFILE.binary_transport_header_max_bytes;
  const queueChunks = options.queue_chunks ?? ARTIFACT_DEPLOYMENT_PROFILE.receive_queue_chunks;
  if (!Number.isSafeInteger(headerMax) || headerMax < 1 || headerMax > ARTIFACT_DEPLOYMENT_PROFILE.json_metadata_max_bytes || !Number.isSafeInteger(queueChunks) || queueChunks < 1 || queueChunks > ARTIFACT_DEPLOYMENT_PROFILE.receive_queue_chunks)
    throw new ContractValidationError("validation_error", "invalid Artifact transport queue/header bounds");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await unlink(socketPath).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; });
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
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
  await waitForSocket(socketPath);
  await chmod(socketPath, 0o600);
  return { server, close: async () => { const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy(); await stopped; await unlink(socketPath).catch(() => undefined); } };
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
export function writeRpcNotification(socket: Socket, signal: { topic: string; engagement_id: string; read_seq: number; emitted_at: string }): void {
  if (socket.destroyed) return;
  const line = `${JSON.stringify({ jsonrpc: "2.0", method: "taric.notification", params: signal })}\n`;
  if (socket.writableLength + Buffer.byteLength(line, "utf8") > RPC_NOTIFICATION_MAX_QUEUED_BYTES) {
    // Socket writable buffering is the only notification queue. Stop a slow peer
    // before it can turn best-effort hints into unbounded process memory.
    socket.destroy();
    return;
  }
  void writeRpcLine(socket, line).catch(() => socket.destroy());
}

function httpRpcError(response: ServerResponse, status: number, id: string | number | null, code: number, message: string, applicationCode?: string): void {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(applicationCode ? { data: { code: applicationCode } } : {}) } });
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload), ...(status === 401 ? { "www-authenticate": 'Bearer realm="taric"' } : {}) });
  response.end(payload);
}

class HttpBodyLimitError extends Error {}
async function readHttpJsonBody(request: IncomingMessage): Promise<unknown> {
  const lengthHeader = request.headers["content-length"];
  if (lengthHeader !== undefined && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > RPC_LINE_MAX_BYTES)) throw new HttpBodyLimitError();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > RPC_LINE_MAX_BYTES) throw new HttpBodyLimitError();
    chunks.push(chunk);
  }
  if (lengthHeader !== undefined && bytes !== Number(lengthHeader)) throw new Error("invalid request length");
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
}

async function dispatchAdapterOperation(service: CoreService, principal: Principal, operation: string, request: Record<string, unknown>, network: boolean, networkContentRoot?: string): Promise<unknown> {
  if (network && operation === "artifact.ingest_file") return { ok: false, error: { code: "unsupported_capability", message: "path-based Artifact ingestion is local to the Core host; use bounded Artifact transfer or an external reference" } };
  if (network && operation === "artifact.session.bind") {
    if (!networkContentRoot || typeof request.session_id !== "string" || !request.session_id.trim()) return { ok: false, error: { code: "unsupported_capability", message: "remote Artifact session binding requires a gateway-managed content root" } };
    const bindingKey = `${principal.id}\0${request.engagement_id}\0${request.session_id}`;
    request = { ...request, root: join(networkContentRoot, "remote-sessions", createHash("sha256").update(bindingKey).digest("hex")) };
  }
  const readsArtifactContent = operation === "artifact.content.read" || (operation === "artifact.content.list" && request.include_content === true) || (operation === "artifact.session.output" && request.include_content === true);
  const requestedMax = request.max_response_bytes;
  if (readsArtifactContent && requestedMax !== undefined && (typeof requestedMax !== "number" || !Number.isSafeInteger(requestedMax) || requestedMax < 1 || requestedMax > RPC_ARTIFACT_READ_MAX_BYTES))
    return { ok: false, error: { code: "validation_error", message: "ordinary JSON-RPC Artifact reads are limited to 512 KiB decoded per response" } };
  let boundedRequest = readsArtifactContent ? { ...request, max_response_bytes: requestedMax ?? RPC_ARTIFACT_READ_MAX_BYTES } : request;
  if (operation === "artifact.content.list" || operation === "artifact.session.output") boundedRequest = { ...boundedRequest, page_size: Math.min(typeof request.page_size === "number" ? request.page_size : RPC_ARTIFACT_PAGE_ITEMS_MAX, RPC_ARTIFACT_PAGE_ITEMS_MAX) };
  if (readsArtifactContent && operation !== "artifact.content.read") boundedRequest.max_response_bytes = Math.min(typeof boundedRequest.max_response_bytes === "number" ? boundedRequest.max_response_bytes : RPC_ARTIFACT_PAGE_CONTENT_MAX_BYTES, RPC_ARTIFACT_PAGE_CONTENT_MAX_BYTES);
  return await service.dispatch(operation, principal, boundedRequest);
}

async function handleHttpsRequest(
  service: CoreService,
  options: AdapterHttpsRpcOptions,
  route: string,
  maxConcurrent: number,
  requestTimeout: number,
  request: IncomingMessage,
  response: ServerResponse,
  getActive: () => number,
  setActive: (value: number) => void,
): Promise<void> {
  let id: string | number | null = null;
  const requestTarget = request.url ?? "/";
  if (requestTarget !== route) { httpRpcError(response, 404, id, -32600, "not found"); request.resume(); return; }
  if (request.method !== "POST") { response.setHeader("allow", "POST"); httpRpcError(response, 405, id, -32600, "method not allowed"); request.resume(); return; }
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") { httpRpcError(response, 415, id, -32600, "content type must be application/json"); request.resume(); return; }
  const authorizationHeaders = request.rawHeaders.reduce<number>((count, header, index) => count + (index % 2 === 0 && header.toLowerCase() === "authorization" ? 1 : 0), 0);
  const authorization = request.headers.authorization;
  const match = authorizationHeaders === 1 && typeof authorization === "string" ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
  let resolved: Principal | undefined;
  if (match && match[1].length >= 32) {
    try { resolved = await options.resolvePrincipal(match[1]); } catch { resolved = undefined; }
  }
  if (!resolved) { httpRpcError(response, 401, id, -32001, "authorization_error", "authorization_error"); request.resume(); return; }
  if (getActive() >= maxConcurrent) { response.shouldKeepAlive = false; httpRpcError(response, 503, id, -32000, "gateway capacity is busy", "unavailable_host"); request.resume(); return; }
  setActive(getActive() + 1);
  const timer = setTimeout(() => request.destroy(new Error("request timeout")), requestTimeout);
  timer.unref();
  try {
    const input = await readHttpJsonBody(request) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (!input || typeof input !== "object" || Array.isArray(input)) { httpRpcError(response, 400, id, -32600, "invalid request"); return; }
    const validId = input.id === undefined || input.id === null || (typeof input.id === "string" && input.id.length <= 128) || (typeof input.id === "number" && Number.isSafeInteger(input.id));
    if (typeof input.id === "string" && input.id.length <= 128 || typeof input.id === "number" && Number.isSafeInteger(input.id) || input.id === null) id = input.id;
    if (input.jsonrpc !== "2.0" || typeof input.method !== "string" || !validId) { httpRpcError(response, 400, id, -32600, "invalid request"); return; }
    if (input.method === "taric.subscribe" || input.method === "taric.unsubscribe") {
      const payload = JSON.stringify({ jsonrpc: "2.0", id, result: { ok: false, error: { code: "unsupported_capability", message: "HTTP request/response transport does not support connection-bound subscriptions; query host state after reconnect" } } });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) }); response.end(payload); return;
    }
    if (input.method !== "taric.dispatch" || !input.params || typeof input.params !== "object" || Array.isArray(input.params)) { httpRpcError(response, 400, id, -32600, "invalid request"); return; }
    const params = input.params as Record<string, unknown>;
    if (Object.keys(params).some((key) => !["operation", "request"].includes(key)) || typeof params.operation !== "string" || !params.request || typeof params.request !== "object" || Array.isArray(params.request)) { httpRpcError(response, 400, id, -32600, "dispatch params must contain only operation and request"); return; }
    const principal = registerTransportPrincipal({ ...resolved, transport_verified: true as const });
    let result: unknown;
    try { result = await dispatchAdapterOperation(service, principal, params.operation, params.request as Record<string, unknown>, true, options.network_content_root); }
    catch { result = { ok: false, error: { code: "internal_error", message: "internal error" } }; }
    const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (Buffer.byteLength(payload) > RPC_LINE_MAX_BYTES) { httpRpcError(response, 413, id, -32600, "response exceeds the 1 MiB JSON-RPC limit", "validation_error"); return; }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(payload) }); response.end(payload);
  } catch (cause) {
    if (response.headersSent || response.destroyed) return;
    if (cause instanceof HttpBodyLimitError) { response.shouldKeepAlive = false; httpRpcError(response, 413, id, -32600, "request body exceeds the 1 MiB JSON-RPC limit", "validation_error"); request.resume(); return; }
    httpRpcError(response, 400, id, -32700, "invalid JSON request");
  } finally {
    clearTimeout(timer);
    setActive(Math.max(0, getActive() - 1));
  }
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
function handleSocket(socket: Socket, service: CoreService, principal: Principal | undefined, token: string, resolvePrincipal?: AdapterRpcOptions["resolvePrincipal"], network = false, networkContentRoot?: string) {
  socket.setEncoding("utf8"); let buffer = "";
  // 多 principal 模式：resolver 存在时连接必须先 taric.identify 且身份随后冻结；
  // 单 principal 模式行为不变（listener principal 即连接身份）。
  let connectionPrincipal: Principal | undefined = resolvePrincipal ? undefined : principal;
  let identified = false;
  let identifiedToken: string | undefined;
  // 连接级订阅：句柄与连接绑定，关闭即退订；未订阅连接的协议行为不变。
  let socketSubscription: { unsubscribe(): void } | undefined;
  socket.once("close", () => socketSubscription?.unsubscribe());
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
        if (input.id !== undefined && input.id !== null && !(typeof input.id === "string" && input.id.length <= 128) && !(typeof input.id === "number" && Number.isSafeInteger(input.id))) { await writeRpcLine(socket, `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } })}\n`); continue; }
        const params = input.params;
        if (input.method === "taric.identify") {
          if (!resolvePrincipal) {
            response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error: single-principal listener does not accept identity frames" } };
          } else if (identified) {
            response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error: connection identity is frozen" } };
          } else if (!params || typeof params.token !== "string" || params.token.length < 32 || !params.declare || typeof params.declare !== "object" || Array.isArray(params.declare)) {
            response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error" } };
          } else {
            const declare = params.declare as { role?: unknown; principal_id?: unknown; engagement_id?: unknown };
            const roles = ["model", "host", "reviewer", "writer", "operator"];
            if (typeof declare.role !== "string" || !roles.includes(declare.role) || typeof declare.principal_id !== "string" || !declare.principal_id.trim() || declare.principal_id.length > 256 || (declare.engagement_id !== undefined && typeof declare.engagement_id !== "string")) {
              response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: false, error: { code: "validation_error", message: "identity declaration is invalid" } } };
            } else {
              try {
                // 呈交凭证即 identify 帧的 token；resolver 查表完成 token↔身份的全部校验。
                const resolved = await resolvePrincipal({ role: declare.role as Principal["role"], principal_id: declare.principal_id, ...(typeof declare.engagement_id === "string" ? { engagement_id: declare.engagement_id } : {}) }, params.token);
                identifiedToken = params.token;
                connectionPrincipal = registerTransportPrincipal({ ...resolved, transport_verified: true as const });
                identified = true;
                response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: true, data: { identified: true, role: declare.role, principal_id: declare.principal_id } } };
              } catch {
                // resolver 拒绝（token/身份不匹配或未知 token）：不注册任何身份。
                response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error" } };
              }
            }
          }
        } else if (resolvePrincipal && !identified) {
          response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error: connection must identify before dispatch" } };
        } else if (resolvePrincipal && params && typeof params.token === "string" && params.token !== identifiedToken) {
          response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error: connection credential changed after identification" } };
        } else if ((input.method === "taric.subscribe" || input.method === "taric.unsubscribe") && params && params.token === (resolvePrincipal ? identifiedToken : token) && (!params.request || (typeof params.request === "object" && !Array.isArray(params.request)))) {
          // 显式进入/退出订阅模式后服务端才可写 unsolicited 通知行。
          if (input.method === "taric.unsubscribe") {
            socketSubscription?.unsubscribe();
            socketSubscription = undefined;
            response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: true, data: { subscribed: false } } };
          } else {
            const request = (params.request ?? {}) as Record<string, unknown>;
            if (request.engagement_id !== undefined && request.engagement_id !== connectionPrincipal!.engagement_id) {
              response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: false, error: { code: "authorization_error", message: "subscription engagement must match the listener principal" } } };
            } else {
              try {
                const handle = await service.subscribe(connectionPrincipal!, {
                  engagement_id: connectionPrincipal!.engagement_id!,
                  ...(Array.isArray(request.topics) ? { topics: request.topics as string[] } : {}),
                  ...(typeof request.debounce_ms === "number" ? { debounce_ms: request.debounce_ms } : {}),
                  ...(typeof request.since_read_seq === "number" ? { since_read_seq: request.since_read_seq } : {}),
                  ...(Object.hasOwn(request, "l1_backlog_threshold") ? { l1_backlog_threshold: request.l1_backlog_threshold as number } : {}),
                }, (signal) => writeRpcNotification(socket, signal));
                socketSubscription?.unsubscribe();
                socketSubscription = handle;
                response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: true, data: { subscribed: true, engagement_id: connectionPrincipal!.engagement_id } } };
              } catch (cause) {
                const detail = cause as { code?: string; message?: string };
                response = { jsonrpc: "2.0", id: input.id ?? null, result: { ok: false, error: { code: detail.code ?? "internal_error", message: detail.message ?? "subscription rejected" } } };
              }
            }
          }
        } else if (input.method !== "taric.dispatch" || !params || params.token !== (resolvePrincipal ? identifiedToken : token) || typeof params.operation !== "string" || !params.request || typeof params.request !== "object" || Array.isArray(params.request)) {
          response = { jsonrpc: "2.0", id: input.id ?? null, error: { code: -32001, message: "authorization_error" } };
        } else {
          const result = await dispatchAdapterOperation(service, connectionPrincipal!, params.operation, params.request as Record<string, unknown>, network, networkContentRoot);
          response = { jsonrpc: "2.0", id: input.id ?? null, result };
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
