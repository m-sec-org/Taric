import { API_CONTRACT_VERSION, type CoreService, type Principal, type PrincipalRole } from "./service.js";

/** Adapter 契约版本与 Core API 版本分开演进；两者都必须显式声明。 */
export const ADAPTER_CONTRACT_VERSION = "1.0" as const;

export const adapterCapabilities = ["session_lifecycle", "context_injection", "proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result"] as const;
export type AdapterCapability = (typeof adapterCapabilities)[number];

export type AdapterHostId = "pi" | "deepseek-harness" | "hermes";

export interface AdapterDescriptor {
  host_id: AdapterHostId;
  /** 宿主版本与 commit 必须来自兼容清单，不接受未知版本作为 supported。 */
  version: string;
  host_commit?: string;
  contract_version: string;
  api_contract_version: string;
  capabilities: AdapterCapability[];
  supported: boolean;
  unsupported_capabilities?: string[];
}

/** 宿主传给 adapter 的事件只作为归属数据，不能自行声明权限或身份。 */
export interface AdapterContext { engagement_id: string; work_run_id?: string; host_id: AdapterHostId; agent_id?: string; dispatch_id?: string; generation?: number; budget?: number; }

export interface AdapterResult { accepted: boolean; reason?: string; }

export type PiLifecycleEventName = "session_start" | "context" | "proposal" | "checkpoint" | "action" | "result" | "cancel" | "error";
export interface PiHostEvent<T extends PiLifecycleEventName = PiLifecycleEventName> { type: T; context: AdapterContext; payload?: Record<string, unknown>; }

/** Pi 1.x ExtensionAPI 使用 pi.on(event, handler) 注册回调。 */
export interface PiExtensionApi { on(event: string, handler: (event: unknown) => Promise<unknown>): () => void; }

export interface AdapterError { code: string; message: string; follow_up?: string; }

export interface AdapterCapabilityReport {
  contract_version: string;
  api_contract_version: string;
  host_id: AdapterHostId;
  host_version: string;
  host_commit?: string;
  supported: boolean;
  capabilities: AdapterCapability[];
  unsupported_capabilities: string[];
  service_connected: boolean;
  missing_capabilities: string[];
}

export interface AdapterClient {
  readonly descriptor: AdapterDescriptor;
  /** 返回 Core envelope；失败时返回 { ok:false, error }，不使用抛出表达权限错误。 */
  call<T = unknown>(operation: string, request: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: AdapterError }>;
  status(): AdapterCapabilityReport;
  /** Pi 扩展入口。DeepSeek/Hermes 返回 unsupported_capability。 */
  register(extension: PiExtensionApi): Promise<{ loaded: boolean; callbacks: string[]; reload_idempotent: boolean }>;
}

export function validateAdapter(descriptor: AdapterDescriptor): AdapterResult {
  if (descriptor.contract_version !== ADAPTER_CONTRACT_VERSION) return { accepted: false, reason: "unsupported contract version" };
  if (descriptor.api_contract_version !== API_CONTRACT_VERSION) return { accepted: false, reason: "unsupported API contract version" };
  const unknown = (descriptor.capabilities ?? []).filter((capability) => !(adapterCapabilities as readonly string[]).includes(capability));
  if (unknown.length) return { accepted: false, reason: `unsupported capabilities: ${unknown.join(",")}` };
  if (!descriptor.supported) return { accepted: false, reason: "unsupported_capability" };
  return { accepted: true };
}

/**
 * 所有宿主 adapter 共用的薄客户端。它只持有受认证 Core service 句柄，不持有 store/DB。
 * principal 由 transport 注入，宿主事件无法覆盖。
 */
export class TaricAdapterClient implements AdapterClient {
  readonly descriptor: AdapterDescriptor;
  readonly #service: CoreService;
  readonly #principal: Principal;
  #loaded = false;

  constructor(descriptor: AdapterDescriptor, service: CoreService, principal: Principal) {
    this.descriptor = { ...descriptor, capabilities: [...(descriptor.capabilities ?? [])] };
    this.#service = service;
    this.#principal = { ...principal };
  }

  async call<T = unknown>(operation: string, request: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: AdapterError }> {
    // Unsupported hosts are diagnostic-only in this release. Do not let the
    // generic client turn a descriptor into an accidental native adapter.
    if (!this.descriptor.supported) {
      return { ok: false, error: { code: "unsupported_capability", message: `${this.descriptor.host_id} adapter is unsupported`, follow_up: this.descriptor.unsupported_capabilities?.[0] } };
    }
    return this.#service.dispatch(operation, this.#principal, request) as { ok: true; data: T } | { ok: false; error: AdapterError };
  }

  status(): AdapterCapabilityReport {
    return {
      contract_version: this.descriptor.contract_version,
      api_contract_version: this.descriptor.api_contract_version,
      host_id: this.descriptor.host_id,
      host_version: this.descriptor.version,
      host_commit: this.descriptor.host_commit,
      supported: this.descriptor.supported,
      capabilities: this.descriptor.supported ? [...this.descriptor.capabilities] : [],
      unsupported_capabilities: [...(this.descriptor.unsupported_capabilities ?? [])],
      service_connected: true,
      missing_capabilities: adapterCapabilities.filter((capability) => !this.descriptor.capabilities.includes(capability)),
    };
  }

  async register(extension: PiExtensionApi): Promise<{ loaded: boolean; callbacks: string[]; reload_idempotent: boolean }> {
    if (this.descriptor.host_id !== "pi" || !this.descriptor.supported) throw new Error("unsupported_capability");
    if (this.#principal.role !== "host" || !this.#principal.engagement_id) throw new Error("authorization_error");
    // /reload 会重新调用工厂。这里保证同一实例重复注册不会产生第二次业务副作用。
    if (this.#loaded) return { loaded: true, callbacks: [], reload_idempotent: true };
    // Keep the stable Taric lifecycle names for the contract while also
    // subscribing to the real Pi 1.x event names. Pi event payloads do not
    // carry a Taric principal, so handle() derives identity from the
    // transport-verified principal and only accepts event attribution as a
    // cross-check.
    const callbacks: PiLifecycleEventName[] = ["session_start", "context"];
    extension.on("session_start", async (raw) => this.handle("session_start", raw));
    extension.on("context", async (raw) => this.handle("context", raw));
    extension.on("before_agent_start", async (raw) => this.handle("context", raw));
    this.#loaded = true;
    return { loaded: true, callbacks, reload_idempotent: true };
  }

  private async handle(name: PiLifecycleEventName, raw: unknown): Promise<unknown> {
    const event = raw as PiHostEvent;
    const supplied = event?.context;
    const principalEngagement = this.#principal.engagement_id;
    const context = supplied ?? (principalEngagement ? { engagement_id: principalEngagement, host_id: this.descriptor.host_id } : undefined);
    if (!context || context.host_id !== this.descriptor.host_id || (principalEngagement && context.engagement_id !== principalEngagement)) return { ok: false, error: { code: "authorization_error", message: "adapter host attribution mismatch" } };
    switch (name) {
      case "session_start": return this.call("engagement.status", { engagement_id: context.engagement_id });
      case "context": {
        const response = await this.call<Record<string, unknown>>("context.build", { engagement_id: context.engagement_id, budget: context.budget ?? (event.payload?.budget as number | undefined) });
        if (!response.ok) return response;
        const pack = JSON.stringify(response.data);
        const contextMessage = { role: "user", customType: "taric-context", content: pack, display: false };
        // Pi's `context` event transforms the conversation; `before_agent_start`
        // injects a persistent message. Keep the two result shapes distinct.
        if ((event as { type?: string } | undefined)?.type === "context") return { messages: [contextMessage] };
        return { message: { customType: "taric-context", content: pack, display: false } };
      }
      case "proposal": return this.call("proposal.submit", { ...(event.payload ?? {}), engagement_id: context.engagement_id });
      case "checkpoint": return this.call("checkpoint.commit", { engagement_id: context.engagement_id, work_run_id: context.work_run_id, host_id: context.host_id, agent_id: context.agent_id, generation: context.generation, checkpoint: event.payload?.checkpoint ?? {} });
      case "action": return this.call("action.recommend", { ...(event.payload ?? {}), engagement_id: context.engagement_id, work_run_id: context.work_run_id });
      case "result": return this.call("action.host-result", { engagement_id: context.engagement_id, work_run_id: context.work_run_id, host_id: context.host_id, generation: context.generation, ...(event.payload ?? {}) });
      case "cancel": return { ok: true, data: { cancelled: false, reason: "host owns cancellation" } };
      case "error": return { ok: true, data: { recorded: false, reason: String(event.payload?.message ?? "host error") } };
    }
  }
}

export function createPrincipal(role: PrincipalRole, id: string, engagementId?: string): Principal {
  return { id, role, engagement_id: engagementId, transport_verified: true };
}
