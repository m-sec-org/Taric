/** Taric operator CLI package entry point. */
export const CLI_PACKAGE = "@taric/cli" as const;

export { cliCommands, cliSubcommands, cliHelp, createCliService, normalizeCliOperation, runCli, type CliExitCode } from "./cli.js";
