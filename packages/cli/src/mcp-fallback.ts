export const mcpFallbackCapabilities = ["context.query", "resource.query", "evidence.query", "proposal.submit", "checkpoint.propose", "action.recommend"] as const;

export function describeMcpFallback() {
  return { lifecycle_automation: false, capabilities: mcpFallbackCapabilities, host_execution: "delegated" as const };
}
