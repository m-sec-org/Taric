import { ADAPTER_CONTRACT_VERSION, TaricAdapterClient, type AdapterCapability, type AdapterDescriptor, type PiExtensionApi } from "./adapter.js";
import { API_CONTRACT_VERSION, type CoreService, type Principal } from "./service.js";

/** Static upper bound; an instance advertises only callbacks/tools it binds. */
export const supportedPiCapabilities = ["session_lifecycle", "context_injection", "proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result"] as const;

/** 认证版本项：版本、上游 commit 与取证引用一体；认证粒度是版本，不是区间。 */
export interface CertifiedPiVersion {
  version: string;
  host_commit: string;
  evidence_ref: string;
}

/**
 * 认证的 Pi 版本集合（最新在前）。集合成员资格是唯一支持判据：
 * 两个认证版本之间的版本不会自动获得支持（RM-2：未测试版本不自动
 * supported；兼容区间必须有两端边界测试才可声明，当前不声明任何区间）。
 */
export const CERTIFIED_PI_VERSIONS: readonly CertifiedPiVersion[] = [
  { version: "1.4.0", host_commit: "4a08025", evidence_ref: "packages/core/test/host-adapters.test.mjs" },
];
const LATEST_CERTIFIED = CERTIFIED_PI_VERSIONS[0];

/** 同 major 未认证版本的已知安全子集：只读生命周期与上下文注入，不含任何权威写入面。 */
export const PI_UNCERTIFIED_SAFE_CAPABILITIES: readonly AdapterCapability[] = ["session_lifecycle", "context_injection"];
/** 更远版本的最小诊断集：不静默清零，但仅保留只读状态面。 */
export const PI_UNCERTIFIED_MINIMAL_CAPABILITIES: readonly AdapterCapability[] = ["session_lifecycle"];

/** 首发唯一受支持的原生宿主。version/host_commit 派生自认证集合最新项。 */
export const SUPPORTED_PI_HOST = {
  host_id: "pi",
  package: "@earendil-works/pi-coding-agent",
  version: LATEST_CERTIFIED.version,
  /** v1.4.0 发布对应上游 tag commit 4a08025（earendil-works/pi v1.x 线，2026-10-21）。 */
  host_commit: LATEST_CERTIFIED.host_commit,
  source: "https://github.com/earendil-works/pi",
  extension_api: "ExtensionAPI.on",
} as const;

/** 认证版本的取证入口；未命中返回 undefined（fail closed）。 */
export function certifiedPiVersion(version: string): CertifiedPiVersion | undefined {
  return CERTIFIED_PI_VERSIONS.find((entry) => entry.version === version);
}

/** 集合成员资格判定：不做区间推断。 */
export function isSupportedPiVersion(version: string): boolean { return certifiedPiVersion(version) !== undefined; }

/** 版本门结果：certified（全能力）/ not_certified（同 major，安全子集）/ unsupported（更远，最小集）。 */
export function piVersionCertificationState(version: string): "certified" | "not_certified" | "unsupported" {
  if (certifiedPiVersion(version)) return "certified";
  const latestMajor = Number(LATEST_CERTIFIED.version.split(".")[0]);
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) && major === latestMajor ? "not_certified" : "unsupported";
}

export function createPiDescriptor(version: string = SUPPORTED_PI_HOST.version): AdapterDescriptor {
  const certified = certifiedPiVersion(version);
  const certification_state = piVersionCertificationState(version);
  const supported = certified !== undefined;
  return {
    host_id: "pi",
    framework_package: SUPPORTED_PI_HOST.package,
    distribution: "pi",
    version,
    commit: certified?.host_commit,
    host_commit: certified?.host_commit,
    contract_version: ADAPTER_CONTRACT_VERSION,
    api_contract_version: API_CONTRACT_VERSION,
    capabilities: supported ? [...supportedPiCapabilities]
      : certification_state === "not_certified" ? [...PI_UNCERTIFIED_SAFE_CAPABILITIES]
      : [...PI_UNCERTIFIED_MINIMAL_CAPABILITIES],
    supported,
    runtime_binding_required: true,
    native_certified: supported,
    certification_state,
    certification_evidence: certified ? [{ framework_package: SUPPORTED_PI_HOST.package, distribution: "pi", version: certified.version, commit: certified.host_commit, state: "verified", ref: certified.evidence_ref }] : [],
    quality_release_state: "pending",
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
