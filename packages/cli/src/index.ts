/** Taric operator CLI package entry point. */
export const CLI_PACKAGE = "@taric/cli" as const;

export { cliCommands, cliSubcommands, cliHelp, createCliService, discoverCliConfig, normalizeCliOperation, resolveCliStartup, runCli, runCliMain, type CliExitCode, type CliConfig, type CliStartupResolution } from "./cli.js";
export { startAdapterProxy, runProxyMain } from "./proxy.js";
