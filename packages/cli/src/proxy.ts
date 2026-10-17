import { createPrincipal, listenAdapterRpc, openRuntimeService } from "@taric/core";
import { discoverCliConfig } from "./cli.js";

export async function startAdapterProxy(env: NodeJS.ProcessEnv = process.env) {
  const { config } = discoverCliConfig(env);
  const socket_path = env.TARIC_CORE_SOCKET;
  const token = env.TARIC_ADAPTER_TOKEN;
  const engagement_id = env.TARIC_ENGAGEMENT_ID ?? config.engagement_id;
  if (!socket_path || !token || token.length < 32 || !engagement_id) {
    throw new Error("proxy requires TARIC_CORE_SOCKET, TARIC_ADAPTER_TOKEN (32+ characters), and TARIC_ENGAGEMENT_ID");
  }

  const service = await openRuntimeService({ config, env });
  try {
    const listener = await listenAdapterRpc(service, {
      socket_path,
      token,
      principal: createPrincipal("host", env.TARIC_PRINCIPAL_ID ?? config.principal_id ?? "adapter-host", engagement_id, [], undefined, env.TARIC_SESSION_ID),
    });
    return {
      async close() {
        await listener.close();
        await service.close();
      },
    };
  } catch (cause) {
    await service.close();
    throw cause;
  }
}

export async function runProxyMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let proxy: Awaited<ReturnType<typeof startAdapterProxy>>;
  try {
    proxy = await startAdapterProxy(env);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "proxy startup failed";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "proxy_startup_failed", message } })}\n`);
    return 1;
  }

  process.stdout.write("Taric adapter RPC proxy listening\n");
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void proxy.close().catch(() => undefined).finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
