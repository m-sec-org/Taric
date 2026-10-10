import { ADAPTER_CONTRACT_VERSION, TaricAdapterClient, type AdapterDescriptor, type PiExtensionApi } from "./adapter.js";
import { API_CONTRACT_VERSION, type CoreService, type Principal } from "./service.js";

/** Only capabilities with a concrete Pi 1.1.0 event mapping are advertised. */
export const supportedPiCapabilities = ["session_lifecycle", "context_injection"] as const;

/** 首发唯一受支持的原生宿主。其版本与 commit 来自 compat manifest。 */
export const SUPPORTED_PI_HOST = {
  host_id: "pi",
  package: "@earendil-works/pi-coding-agent",
  version: "1.1.0",
  /** v1.1.0 发布对应上游 7c10bd4（v1.0.4 之后的 v1.x 线）。 */
  host_commit: "7c10bd4",
  source: "https://github.com/earendil-works/pi",
  extension_api: "ExtensionAPI.on",
} as const;

/** 未列出的 Pi 版本一律视为未测试，不进入 supported。 */
export function isSupportedPiVersion(version: string): boolean { return version === SUPPORTED_PI_HOST.version; }

export function createPiDescriptor(version: string = SUPPORTED_PI_HOST.version): AdapterDescriptor {
  const supported = isSupportedPiVersion(version);
  return {
    host_id: "pi",
    version,
    host_commit: supported ? SUPPORTED_PI_HOST.host_commit : undefined,
    contract_version: ADAPTER_CONTRACT_VERSION,
    api_contract_version: API_CONTRACT_VERSION,
    capabilities: supported ? [...supportedPiCapabilities] : [],
    supported,
    unsupported_capabilities: supported ? [] : ["pi_native_adapter"],
  };
}

/** Pi 只接受 Core service；不接受 AuthorityStore，避免 adapter 变成第二份 authority。 */
export function createPiAdapter(service: CoreService, principal: Principal, version: string = SUPPORTED_PI_HOST.version) {
  return new TaricAdapterClient(createPiDescriptor(version), service, principal);
}

/** Pi 扩展工厂：Pi 1.x 传入 ExtensionAPI，函数可为 async。 */
export function createPiExtension(service: CoreService, principal: Principal, version: string = SUPPORTED_PI_HOST.version) {
  const adapter = createPiAdapter(service, principal, version);
  return async function taricPiExtension(pi: PiExtensionApi) {
    const result = await adapter.register(pi);
    return { ...result, adapter: adapter.status() };
  };
}
