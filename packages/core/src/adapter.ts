import type { AuthorityStore } from "./store.js";

export const ADAPTER_CONTRACT_VERSION = "1.0" as const;
export const adapterCapabilities = ["session_lifecycle", "context_injection", "proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result"] as const;
export type AdapterCapability = (typeof adapterCapabilities)[number];
export interface AdapterDescriptor { host_id: string; version: string; contract_version: string; capabilities: AdapterCapability[]; }
export interface AdapterContext { engagement_id: string; work_run_id?: string; host_id: string; agent_id?: string; dispatch_id?: string; }
export interface AdapterResult { accepted: boolean; reason?: string; }

export function validateAdapter(descriptor: AdapterDescriptor): AdapterResult {
  if (descriptor.contract_version !== ADAPTER_CONTRACT_VERSION) return { accepted: false, reason: "unsupported contract version" };
  const unknown = descriptor.capabilities.filter((capability) => !(adapterCapabilities as readonly string[]).includes(capability));
  if (unknown.length) return { accepted: false, reason: `unsupported capabilities: ${unknown.join(",")}` };
  return { accepted: true };
}

export class TaricAdapterFacade {
  constructor(readonly descriptor: AdapterDescriptor, readonly store: AuthorityStore) {
    const result = validateAdapter(descriptor); if (!result.accepted) throw new Error(result.reason);
  }
  submitProposal(context: AdapterContext, proposal: Parameters<AuthorityStore["submitProposal"]>[0]): ReturnType<AuthorityStore["submitProposal"]> {
    if (proposal.engagement_id !== context.engagement_id) throw new Error("engagement mismatch");
    return this.store.submitProposal(proposal);
  }
}
