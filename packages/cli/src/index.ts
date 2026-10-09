/** Taric operator CLI package entry point. */
export const CLI_PACKAGE = "@taric/cli" as const;

export const cliCommands = ["taric init", "taric status", "taric context build", "taric propose", "taric review", "taric action recommend", "taric audit verify"] as const;
