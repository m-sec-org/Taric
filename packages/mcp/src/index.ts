/** Taric MCP transport package entry point. */
export const MCP_PACKAGE = "@taric/mcp" as const;

export { modelTools, createMcpServer, createMcpService, runMcpStdio } from "./server.js";
