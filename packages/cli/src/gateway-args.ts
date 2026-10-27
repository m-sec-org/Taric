import { resolve } from "node:path";

/** Parsed gateway process arguments. Listener and runtime files are separate
 * deployment inputs and are never inferred from one another. */
export interface GatewayArguments {
  configPath: string;
  runtimeConfigPath?: string;
}

export class GatewayArgumentError extends Error {
  readonly code = "validation_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "GatewayArgumentError";
  }
}

/**
 * Parse only gateway transport flags. The caller may handle `--help` before
 * invoking this function. Repeated or unknown flags fail closed so an
 * operator cannot accidentally bind a listener using a different file than
 * the one they intended.
 */
export function parseGatewayArguments(argv: readonly string[]): GatewayArguments {
  let configPath: string | undefined;
  let runtimeConfigPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--config" && flag !== "--runtime-config") throw new GatewayArgumentError(`gateway does not support ${String(flag)}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new GatewayArgumentError(`${flag} requires a path`);
    if (flag === "--config") {
      if (configPath !== undefined) throw new GatewayArgumentError("gateway --config may only be supplied once");
      configPath = value;
    } else {
      if (runtimeConfigPath !== undefined) throw new GatewayArgumentError("gateway --runtime-config may only be supplied once");
      runtimeConfigPath = value;
    }
    index += 1;
  }
  if (!configPath) throw new GatewayArgumentError("gateway requires --config <gateway.json>");
  if (runtimeConfigPath !== undefined && resolve(runtimeConfigPath) === resolve(configPath)) throw new GatewayArgumentError("gateway listener and runtime configuration paths must be different");
  return Object.freeze({ configPath, ...(runtimeConfigPath ? { runtimeConfigPath } : {}) });
}
