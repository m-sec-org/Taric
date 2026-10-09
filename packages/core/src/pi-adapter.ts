import { TaricAdapterFacade, type AdapterDescriptor } from "./adapter.js";
import type { AuthorityStore } from "./store.js";

export function createPiAdapter(store: AuthorityStore, version = "unknown") {
  const descriptor: AdapterDescriptor = { host_id: "pi", version, contract_version: "1.0", capabilities: ["session_lifecycle", "context_injection", "proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result"] };
  return new TaricAdapterFacade(descriptor, store);
}
