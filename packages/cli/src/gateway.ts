import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createPrincipal,
  discoverRuntimeConfig,
  listenAdapterHttpsRpc,
  listenAdapterRpc,
  openRuntimeService,
  resolveRuntimeAuthority,
  NETWORK_RPC_MAX_CONNECTIONS,
  NETWORK_RPC_MAX_CONCURRENT_REQUESTS,
  NETWORK_RPC_REQUEST_TIMEOUT_MS,
  type ApiResponse,
  type GatewayTransportOperations,
  type Principal,
  type PrincipalRole,
  type RuntimeStartupConfig,
} from "@taric/core";

/** Multi-principal gateway. Identity comes from the token table, never the request body. */

export interface GatewayTokenEntry {
  token: string;
  role: PrincipalRole;
  principal_id: string;
  engagement_id?: string;
  session_id?: string;
}
export interface GatewayConfig {
  socket_path?: string;
  tls_tcp?: { host: string; port: number; max_connections?: number };
  https?: { host: string; port: number; path?: string; max_connections?: number; max_concurrent_requests?: number; request_timeout_ms?: number };
  tls?: { key_file: string; cert_file: string };
  tokens: GatewayTokenEntry[];
}

interface LoadedGatewayConfig {
  config: GatewayConfig;
  digest: string;
  tlsMaterial?: { key: Buffer; cert: Buffer };
}
type GatewayListener = { close(): Promise<void> };
type GatewayResult = ApiResponse<Record<string, unknown>>;
const digest = (raw: string | Buffer): string => `sha256:${createHash("sha256").update(raw).digest("hex")}`;

export function parseGatewayConfig(raw: string): GatewayConfig {
  const config = JSON.parse(raw) as GatewayConfig;
  const roles = ["model", "host", "reviewer", "writer", "operator"];
  if (!config || typeof config !== "object" || !Array.isArray(config.tokens)) throw new Error("gateway config requires a tokens array");
  const listenerCount = Number(typeof config.socket_path === "string" && Boolean(config.socket_path.trim())) + Number(config.tls_tcp !== undefined) + Number(config.https !== undefined);
  if (listenerCount === 0) throw new Error("gateway config requires at least one listener");
  if (config.socket_path !== undefined && (typeof config.socket_path !== "string" || !config.socket_path.trim())) throw new Error("gateway socket_path must be a non-empty path");
  const validateEndpoint = (endpoint: unknown, name: string): endpoint is { host: string; port: number } => {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) throw new Error(`gateway ${name} endpoint must be an object`);
    const value = endpoint as { host?: unknown; port?: unknown };
    if (typeof value.host !== "string" || !value.host.trim() || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error(`gateway ${name} endpoint requires an explicit host and port`);
    return true;
  };
  if (config.tls_tcp !== undefined) validateEndpoint(config.tls_tcp, "tls_tcp");
  if (config.https !== undefined) {
    validateEndpoint(config.https, "https");
    if (config.https.path !== undefined && (typeof config.https.path !== "string" || !config.https.path.startsWith("/") || config.https.path.includes("?") || config.https.path.includes("#"))) throw new Error("gateway HTTPS path must be an absolute route without query or fragment");
  }
  if (config.tls !== undefined && (!config.tls || typeof config.tls !== "object" || Array.isArray(config.tls))) throw new Error("gateway tls settings must be an object");
  const validateLimit = (value: unknown, maximum: number, minimum: number, name: string) => {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)) throw new Error(`gateway ${name} is outside the supported bound`);
  };
  validateLimit(config.tls_tcp?.max_connections, NETWORK_RPC_MAX_CONNECTIONS, 1, "TLS TCP max_connections");
  validateLimit(config.https?.max_connections, NETWORK_RPC_MAX_CONNECTIONS, 1, "HTTPS max_connections");
  validateLimit(config.https?.max_concurrent_requests, NETWORK_RPC_MAX_CONCURRENT_REQUESTS, 1, "HTTPS max_concurrent_requests");
  validateLimit(config.https?.request_timeout_ms, NETWORK_RPC_REQUEST_TIMEOUT_MS, 100, "HTTPS request_timeout_ms");
  if (listenerCount > Number(Boolean(config.socket_path)) && (!config.tls || typeof config.tls.key_file !== "string" || !config.tls.key_file.trim() || typeof config.tls.cert_file !== "string" || !config.tls.cert_file.trim())) throw new Error("gateway network listeners require tls.key_file and tls.cert_file");
  const seen = new Set<string>();
  for (const entry of config.tokens) {
    if (!entry || typeof entry !== "object") throw new Error("gateway token entry must be an object");
    if (typeof entry.token !== "string" || entry.token.length < 32) throw new Error("gateway tokens must contain at least 32 characters");
    if (!roles.includes(entry.role)) throw new Error(`gateway token role is invalid: ${String(entry.role)}`);
    if (typeof entry.principal_id !== "string" || !entry.principal_id.trim()) throw new Error("gateway token principal_id is required");
    if (entry.engagement_id !== undefined && typeof entry.engagement_id !== "string") throw new Error("gateway token engagement_id must be a string");
    if (entry.session_id !== undefined && typeof entry.session_id !== "string") throw new Error("gateway token session_id must be a string");
    if (seen.has(entry.token)) throw new Error("gateway tokens must be unique");
    seen.add(entry.token);
  }
  return config;
}

function loadGatewayConfig(configPath: string): LoadedGatewayConfig {
  const raw = readFileSync(configPath, "utf8");
  const config = parseGatewayConfig(raw);
  const tlsMaterial = config.tls ? {
    key: readFileSync(resolve(dirname(resolve(configPath)), config.tls.key_file)),
    cert: readFileSync(resolve(dirname(resolve(configPath)), config.tls.cert_file)),
  } : undefined;
  return { config, digest: digest(raw), tlsMaterial };
}

/** Resolver is a table lookup: declared identity must match the token entry exactly. */
export function gatewayResolver(tokens: GatewayTokenEntry[]) {
  const table = new Map(tokens.map((entry) => [entry.token, entry]));
  return (declared: { role: PrincipalRole; principal_id: string; engagement_id?: string }, token: string): Principal => {
    const entry = table.get(token);
    if (!entry) throw new Error("unknown gateway token");
    if (declared.role !== entry.role || declared.principal_id !== entry.principal_id || (declared.engagement_id ?? undefined) !== (entry.engagement_id ?? undefined)) throw new Error("declared identity does not match the gateway token table");
    return createPrincipal(entry.role, entry.principal_id, entry.engagement_id, [], undefined, entry.session_id);
  };
}

export function gatewayBearerResolver(tokens: GatewayTokenEntry[]) {
  const table = new Map(tokens.map((entry) => [entry.token, entry]));
  return (token: string): Principal | undefined => {
    const entry = table.get(token);
    if (!entry) return undefined;
    return createPrincipal(entry.role, entry.principal_id, entry.engagement_id, [], undefined, entry.session_id);
  };
}

function listenerSummary(config: GatewayConfig): Record<string, unknown> {
  return {
    unix_socket: Boolean(config.socket_path),
    tls_tcp: config.tls_tcp ? { enabled: true, host: config.tls_tcp.host, port: config.tls_tcp.port } : { enabled: false },
    https: config.https ? { enabled: true, host: config.https.host, port: config.https.port, path: config.https.path ?? "/rpc" } : { enabled: false },
  };
}

function unauthorized(): GatewayResult {
  return { ok: false, error: { code: "authorization_error", message: "gateway status or reload requires an operator or host principal" } };
}

export interface GatewayInstance {
  config: GatewayConfig;
  close(): Promise<void>;
}

export async function startGateway(configPath: string, env: NodeJS.ProcessEnv = process.env, runtimeConfigPath?: string): Promise<GatewayInstance> {
  let active = loadGatewayConfig(configPath);
  const discovered = discoverRuntimeConfig(env, process.cwd(), undefined, runtimeConfigPath);
  const runtimeConfig = discovered.config as RuntimeStartupConfig;
  const resolution = resolveRuntimeAuthority({ config: runtimeConfig, env, runtimeConfigProvenance: discovered.provenance });
  const service = await openRuntimeService({ config: runtimeConfig, env, runtimeConfigProvenance: discovered.provenance });
  let listeners: GatewayListener[] = [];
  let reloadPending = false;
  let reloadFailure: string | undefined;
  let closed = false;
  let operations: GatewayTransportOperations;

  const status = async (principal: Principal): Promise<GatewayResult> => {
    if (!principal || !["operator", "host"].includes(principal.role)) return unauthorized();
    let authorityReady = true;
    let readinessCode = "ready";
    try {
      const probe = await service.status();
      if (!probe.ok) { authorityReady = false; readinessCode = probe.error.code; }
    } catch { authorityReady = false; readinessCode = "unavailable_host"; }
    return {
      ok: true,
      data: {
        liveness: !closed,
        readiness: authorityReady && !reloadPending,
        readiness_code: reloadPending ? "reloading" : readinessCode,
        authority: { backend: resolution.authority.backend, profile: resolution.authority.profile, schema_version: resolution.diagnostics.schema_version, policy_digest: resolution.diagnostics.policy_digest, fencing: authorityReady ? resolution.authority.lease_mode === "server_side" ? "server_side_ready" : "local" : "blocked" },
        runtime_configuration: { source: resolution.runtimeConfigProvenance.source, digest: resolution.runtimeConfigProvenance.digest, content_root_mode: resolution.precedence.content_root === "default" ? "derived" : "configured", precedence: resolution.precedence },
        gateway_configuration: { digest: active.digest, listeners: listenerSummary(active.config), token_count: active.config.tokens.length },
        ...(reloadFailure ? { reload_failure: reloadFailure } : {}),
      },
    };
  };

  const closeListeners = async (items: GatewayListener[]) => {
    const errors: unknown[] = [];
    for (const listener of [...items].reverse()) { try { await listener.close(); } catch (cause) { errors.push(cause); } }
    if (errors.length) throw new AggregateError(errors, "one or more gateway listeners failed to close");
  };

  const openListeners = async (loaded: LoadedGatewayConfig): Promise<GatewayListener[]> => {
    const opened: GatewayListener[] = [];
    try {
      const resolver = gatewayResolver(loaded.config.tokens);
      if (loaded.config.socket_path) opened.push(await listenAdapterRpc(service, { socket_path: loaded.config.socket_path, token: `gateway-frame-token-${loaded.config.socket_path.slice(-16)}`, resolvePrincipal: resolver, gateway_operations: operations }));
      if (loaded.config.tls_tcp && loaded.tlsMaterial) opened.push(await listenAdapterRpc(service, { tls_tcp: { ...loaded.config.tls_tcp, ...loaded.tlsMaterial }, network_content_root: resolution.contentRoot, token: "taric-tls-tcp-frame-token-boundary", resolvePrincipal: resolver, gateway_operations: operations }));
      if (loaded.config.https && loaded.tlsMaterial) opened.push(await listenAdapterHttpsRpc(service, { ...loaded.config.https, ...loaded.tlsMaterial, network_content_root: resolution.contentRoot, resolvePrincipal: gatewayBearerResolver(loaded.config.tokens), max_connections: loaded.config.https.max_connections ?? NETWORK_RPC_MAX_CONNECTIONS, gateway_operations: operations }));
      return opened;
    } catch (cause) {
      await closeListeners(opened).catch(() => undefined);
      throw cause;
    }
  };

  const reload = async (principal: Principal): Promise<GatewayResult> => {
    if (!principal || principal.role !== "operator") return unauthorized();
    if (reloadPending) return { ok: false, error: { code: "unavailable_host", message: "gateway reload is already in progress" } };
    let next: LoadedGatewayConfig;
    try { next = loadGatewayConfig(configPath); }
    catch (cause) { return { ok: false, error: { code: "validation_error", message: cause instanceof Error ? cause.message : "gateway configuration is invalid" } }; }
    reloadPending = true;
    reloadFailure = undefined;
    setTimeout(() => {
      void (async () => {
        const previous = active;
        const previousListeners = listeners;
        try {
          if (closed) throw new Error("gateway is closed");
          await closeListeners(previousListeners);
          const replacement = await openListeners(next);
          listeners = replacement;
          active = next;
        } catch (cause) {
          reloadFailure = cause instanceof Error ? cause.message : "gateway reload failed";
          try { listeners = await openListeners(previous); active = previous; }
          catch (restoreCause) { reloadFailure = restoreCause instanceof Error ? restoreCause.message : reloadFailure; listeners = []; }
        } finally { reloadPending = false; }
      })();
    }, 0);
    return { ok: true, data: { accepted: true, config_digest: next.digest, reconnect_required: true } };
  };
  operations = { status, reload };
  try {
    listeners = await openListeners(active);
    return {
      config: active.config,
      async close() { if (closed) return; closed = true; await closeListeners(listeners); await service.close(); },
    };
  } catch (cause) {
    await closeListeners(listeners).catch(() => undefined);
    await service.close();
    throw cause;
  }
}

export async function runGatewayMain(configPath: string | undefined, env: NodeJS.ProcessEnv = process.env, runtimeConfigPath?: string): Promise<number> {
  if (!configPath) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "validation_error", message: "gateway requires --config <gateway.json>" } })}\n`);
    return 2;
  }
  let gateway: GatewayInstance;
  try { gateway = await startGateway(configPath, env, runtimeConfigPath); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "gateway startup failed";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "gateway_startup_failed", message } })}\n`);
    return 1;
  }
  process.stdout.write(`Taric multi-principal gateway listening (${gateway.config.tokens.length} tokens)\n`);
  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void gateway.close().catch(() => undefined).finally(resolveStop); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
