import { ADAPTER_CONTRACT_VERSION, TaricAdapterClient, type AdapterDescriptor } from "./adapter.js";
import { API_CONTRACT_VERSION, type CoreService, type Principal } from "./service.js";

/** DeepSeek Harness 原生 adapter 属于 follow-up `integrate-native-host-adapters`。 */
export function createDeepSeekDescriptor(version = "unpinned"): AdapterDescriptor {
  return {
    host_id: "deepseek-harness",
    version,
    contract_version: ADAPTER_CONTRACT_VERSION,
    api_contract_version: API_CONTRACT_VERSION,
    capabilities: [],
    supported: false,
    unsupported_capabilities: ["deepseek_native_adapter"],
  };
}

export function createDeepSeekHarnessAdapter(service: CoreService, principal: Principal, version = "unpinned") {
  return new TaricAdapterClient(createDeepSeekDescriptor(version), service, principal);
}

export function createHermesDescriptor(version = "unpinned"): AdapterDescriptor {
  return {
    host_id: "hermes",
    version,
    contract_version: ADAPTER_CONTRACT_VERSION,
    api_contract_version: API_CONTRACT_VERSION,
    capabilities: [],
    supported: false,
    unsupported_capabilities: ["hermes_native_adapter"],
  };
}

export function createHermesAdapter(service: CoreService, principal: Principal, version = "unpinned") {
  return new TaricAdapterClient(createHermesDescriptor(version), service, principal);
}
