import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPrincipal, listenAdapterHttpsRpc, listenAdapterRpc, openRuntimeService, NETWORK_RPC_MAX_CONNECTIONS, NETWORK_RPC_MAX_CONCURRENT_REQUESTS, NETWORK_RPC_REQUEST_TIMEOUT_MS, type Principal, type PrincipalRole } from "@taric/core";
import { discoverCliConfig, resolveCliStartup } from "./cli.js";

/** 多 principal 网关：一个 listener 服务多个 token 解析的身份。
 * 身份只来自 resolver 查表，请求体永不自选身份。 */

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

/** resolver 即查表：声明身份必须与 token 表项逐字段一致，不匹配即抛错（fail closed）。 */
export function gatewayResolver(tokens: GatewayTokenEntry[]) {
  const table = new Map(tokens.map((entry) => [entry.token, entry]));
  return (declared: { role: PrincipalRole; principal_id: string; engagement_id?: string }, token: string): Principal => {
    const entry = table.get(token);
    if (!entry) throw new Error("unknown gateway token");
    if (declared.role !== entry.role || declared.principal_id !== entry.principal_id || (declared.engagement_id ?? undefined) !== (entry.engagement_id ?? undefined))
      throw new Error("declared identity does not match the gateway token table");
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

export async function startGateway(configPath: string, env: NodeJS.ProcessEnv = process.env) {
  const config = parseGatewayConfig(readFileSync(configPath, "utf8"));
  const tlsMaterial = config.tls ? {
    key: readFileSync(resolve(dirname(resolve(configPath)), config.tls.key_file)),
    cert: readFileSync(resolve(dirname(resolve(configPath)), config.tls.cert_file)),
  } : undefined;
  const { config: runtimeConfig } = discoverCliConfig(env);
  const contentRoot = resolveCliStartup(runtimeConfig, env).contentRoot;
  const service = await openRuntimeService({ config: runtimeConfig, env });
  const listeners: Array<{ close(): Promise<void> }> = [];
  try {
    const resolver = gatewayResolver(config.tokens);
    if (config.socket_path) listeners.push(await listenAdapterRpc(service, {
      socket_path: config.socket_path,
      token: `gateway-frame-token-${config.socket_path.slice(-16)}`,
      resolvePrincipal: resolver,
    }));
    if (config.tls_tcp && tlsMaterial) listeners.push(await listenAdapterRpc(service, {
      tls_tcp: { ...config.tls_tcp, ...tlsMaterial },
      network_content_root: contentRoot,
      token: "taric-tls-tcp-frame-token-boundary",
      resolvePrincipal: resolver,
    }));
    if (config.https && tlsMaterial) listeners.push(await listenAdapterHttpsRpc(service, {
      ...config.https,
      ...tlsMaterial,
      network_content_root: contentRoot,
      resolvePrincipal: gatewayBearerResolver(config.tokens),
      max_connections: config.https.max_connections ?? NETWORK_RPC_MAX_CONNECTIONS,
    }));
    return {
      config,
      async close() {
        const errors: unknown[] = [];
        for (const listener of [...listeners].reverse()) { try { await listener.close(); } catch (cause) { errors.push(cause); } }
        await service.close();
        if (errors.length) throw new AggregateError(errors, "one or more gateway listeners failed to close");
      },
    };
  } catch (cause) {
    for (const listener of [...listeners].reverse()) await listener.close().catch(() => undefined);
    await service.close();
    throw cause;
  }
}

export async function runGatewayMain(configPath: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!configPath) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "validation_error", message: "gateway requires --config <gateway.json>" } })}\n`);
    return 2;
  }
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  try { gateway = await startGateway(configPath, env); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : "gateway startup failed";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "gateway_startup_failed", message } })}\n`);
    return 1;
  }
  process.stdout.write(`Taric multi-principal gateway listening (${gateway.config.tokens.length} tokens)\n`);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void gateway.close().catch(() => undefined).finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
