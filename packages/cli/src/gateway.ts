import { readFileSync } from "node:fs";
import { createPrincipal, listenAdapterRpc, openRuntimeService, type Principal, type PrincipalRole } from "@taric/core";
import { discoverCliConfig } from "./cli.js";

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
  socket_path: string;
  tokens: GatewayTokenEntry[];
}

export function parseGatewayConfig(raw: string): GatewayConfig {
  const config = JSON.parse(raw) as GatewayConfig;
  const roles = ["model", "host", "reviewer", "writer", "operator"];
  if (!config || typeof config !== "object" || !Array.isArray(config.tokens) || typeof config.socket_path !== "string" || !config.socket_path.trim())
    throw new Error("gateway config requires socket_path and a tokens array");
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

export async function startGateway(configPath: string, env: NodeJS.ProcessEnv = process.env) {
  const config = parseGatewayConfig(readFileSync(configPath, "utf8"));
  const { config: runtimeConfig } = discoverCliConfig(env);
  const service = await openRuntimeService({ config: runtimeConfig, env });
  try {
    const listener = await listenAdapterRpc(service, {
      socket_path: config.socket_path,
      // listener 固定帧 token 满足构造校验；实际凭证是 identify 帧携带的
      // 表内 token，由 resolver 查表完成全部 token↔身份校验。
      token: `gateway-frame-token-${config.socket_path.slice(-16)}`,
      resolvePrincipal: gatewayResolver(config.tokens),
    });
    return {
      config,
      async close() { await listener.close(); await service.close(); },
    };
  } catch (cause) {
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
