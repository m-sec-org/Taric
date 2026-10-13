import { API_CONTRACT_VERSION, registerTransportPrincipal, type CoreService, type Principal, type PrincipalCapability, type PrincipalRole } from "./service.js";

/** Adapter 契约版本与 Core API 版本分开演进；两者都必须显式声明。 */
export const ADAPTER_CONTRACT_VERSION = "1.0" as const;

export const adapterCapabilities = ["session_lifecycle", "context_injection", "proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result", "cancel", "reload"] as const;
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
  test_evidence?: string[];
  fallback?: string[];
}

/** 宿主传给 adapter 的事件只作为归属数据，不能自行声明权限或身份。 */
export interface AdapterContext { engagement_id: string; work_run_id?: string; host_id: AdapterHostId; agent_id?: string; dispatch_id?: string; generation?: number; budget?: number; }

export interface AdapterResult { accepted: boolean; reason?: string; }

export type PiLifecycleEventName = "session_start" | "context" | "proposal" | "checkpoint" | "action" | "result" | "cancel" | "error";
export interface PiHostEvent<T extends PiLifecycleEventName = PiLifecycleEventName> { type: T; context: AdapterContext; payload?: Record<string, unknown>; }

export interface PiActionResult {
  action_id: string;
  mode: "llm_recommend" | "authorized_autonomous" | "host_hitl";
  status: "executed" | "failed" | "unknown";
  result_ref?: string;
  host_decision_ref?: string;
}

/** Explicit host-owned runtime facts required for run-scoped writes. */
export interface PiRuntimeBinding {
  work_run_id?: string;
  generation?: number;
  agent_id?: string;
  /** Must return a sanitized checkpoint; Pi transcript/reasoning is never persisted by the adapter. */
  checkpoint?: (event: unknown) => Record<string, unknown> | undefined;
  /** Maps a host tool invocation to an advisory Taric action recommendation. */
  recommendationForTool?: (event: unknown) => { target: string; method: string; rationale: string; uncertainty?: string; scope?: string; constraints?: string[]; memory_refs?: string[]; evidence_refs?: string[] } | undefined;
  /** Supplies the host's actual decision/result metadata for a completed tool call. */
  resultForTool?: (event: unknown) => PiActionResult | undefined;
}

export interface PiRegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

/** Pi 1.1 ExtensionAPI hooks and tool registration used by the pinned host contract. */
export interface PiExtensionApi {
  on(event: string, handler: (event: unknown, context?: unknown) => Promise<unknown> | unknown): () => void;
  registerTool?(tool: PiRegisteredTool): void;
}

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
  register(extension: PiExtensionApi, binding?: PiRuntimeBinding): Promise<{ loaded: boolean; callbacks: string[]; hooks: string[]; available_capabilities: AdapterCapability[]; missing_capabilities: AdapterCapability[]; reload_idempotent: boolean }>;
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
  #registeredHooks: string[] = [];
  #availableCapabilities: AdapterCapability[] = [];

  constructor(descriptor: AdapterDescriptor, service: CoreService, principal: Principal) {
    this.descriptor = { ...descriptor, capabilities: [...(descriptor.capabilities ?? [])] };
    this.#service = service;
    this.#principal = principal;
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
      missing_capabilities: adapterCapabilities.filter((capability) => !(this.#availableCapabilities.length ? this.#availableCapabilities : this.descriptor.capabilities).includes(capability)),
    };
  }

  async register(extension: PiExtensionApi, binding: PiRuntimeBinding = {}): Promise<{ loaded: boolean; callbacks: string[]; hooks: string[]; available_capabilities: AdapterCapability[]; missing_capabilities: AdapterCapability[]; reload_idempotent: boolean }> {
    if (this.descriptor.host_id !== "pi" || !this.descriptor.supported) throw new Error("unsupported_capability");
    if (this.#principal.role !== "host" || !this.#principal.id || this.#principal.transport_verified !== true || !this.#principal.engagement_id) throw new Error("authorization_error");
    // /reload 会重新调用工厂。这里保证同一实例重复注册不会产生第二次业务副作用。
    if (this.#loaded) return { loaded: true, callbacks: [], hooks: [], available_capabilities: [...this.#availableCapabilities], missing_capabilities: adapterCapabilities.filter((item) => !this.#availableCapabilities.includes(item)), reload_idempotent: true };
    if (binding.generation !== undefined && (!Number.isInteger(binding.generation) || binding.generation < 1)) throw new Error("validation_error");
    if ((binding.work_run_id === undefined) !== (binding.generation === undefined)) throw new Error("validation_error");

    const hooks = ["session_start", "context", "before_agent_start", "agent_before_settle", "tool_result", "session_shutdown"];
    // `callbacks` is the stable Taric lifecycle vocabulary. `hooks` below is
    // the concrete Pi 1.1.0 registration list; Pi has no native proposal,
    // checkpoint, action, result, or error event names.
    const callbacks: PiLifecycleEventName[] = ["session_start", "context"];
    extension.on("session_start", async (raw) => this.handle("session_start", raw));
    extension.on("context", async (raw) => this.handle("context", raw));
    extension.on("before_agent_start", async (raw) => this.handle("context", raw));
    extension.on("agent_before_settle", async (raw) => {
      const event = raw as { outcome?: unknown };
      if (binding.checkpoint && binding.work_run_id && binding.generation !== undefined && event?.outcome !== "error") {
        const checkpoint = binding.checkpoint(raw);
        if (checkpoint) return this.call("checkpoint.commit", this.runRequest(binding, { checkpoint }));
      }
      if (event?.outcome === "error") {
        return this.call("error.report", { engagement_id: this.#principal.engagement_id, message: "Pi agent run failed" });
      }
      return undefined;
    });
    extension.on("tool_result", async (raw) => {
      const event = raw as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
      if (event?.isError === true) {
        return this.call("error.report", { engagement_id: this.#principal.engagement_id, error_ref: typeof event.toolCallId === "string" ? event.toolCallId : undefined, message: `Pi tool ${typeof event.toolName === "string" ? event.toolName : "unknown"} failed` });
      }
      if (binding.resultForTool && binding.work_run_id && binding.generation !== undefined) {
        const result = binding.resultForTool(raw);
        if (result) return this.call("action.host-result", this.runRequest(binding, { ...result }));
      }
      return undefined;
    });
    if (extension.registerTool) {
      extension.registerTool(this.proposalTool(binding));
      if (binding.recommendationForTool) hooks.push("tool_call");
      if (binding.recommendationForTool) extension.on("tool_call", async (raw) => {
        const recommendation = binding.recommendationForTool?.(raw);
        if (!recommendation) return undefined;
        return this.call("action.recommend", { ...recommendation, engagement_id: this.#principal.engagement_id, work_run_id: binding.work_run_id, generation: binding.generation });
      });
      extension.registerTool(this.actionRecommendationTool(binding));
      hooks.push("registerTool:taric_proposal", "registerTool:taric_action_recommend");
    }
    extension.on("session_shutdown", async () => undefined);
    this.#registeredHooks = hooks;
    this.#availableCapabilities = ["session_lifecycle", "context_injection", ...(extension.registerTool ? ["proposal_submission", "action_mode"] as AdapterCapability[] : []), ...(binding.agent_id ? ["worker_attribution"] as AdapterCapability[] : []), ...(binding.checkpoint ? ["checkpoint"] as AdapterCapability[] : []), ...(binding.resultForTool ? ["host_result"] as AdapterCapability[] : [])];
    this.#loaded = true;
    return { loaded: true, callbacks, hooks: [...hooks], available_capabilities: [...this.#availableCapabilities], missing_capabilities: adapterCapabilities.filter((item) => !this.#availableCapabilities.includes(item)), reload_idempotent: true };
  }

  private runRequest(binding: PiRuntimeBinding, extra: Record<string, unknown>): Record<string, unknown> {
    // The adapter kind identifies the integration surface; the authenticated
    // principal identifies the lease owner for every run-scoped write.
    return { engagement_id: this.#principal.engagement_id, work_run_id: binding.work_run_id, host_id: this.#principal.id, agent_id: binding.agent_id, generation: binding.generation, ...extra };
  }

  private proposalTool(binding: PiRuntimeBinding): PiRegisteredTool {
    return {
      name: "taric_proposal",
      label: "Submit Taric proposal",
      description: "Submit a candidate memory record to Taric for review. This does not change canonical memory.",
      parameters: {
        type: "object",
        properties: {
          subject_type: { type: "string", minLength: 1 },
          base_version: { type: "integer", minimum: 0 },
          content: { type: "object" },
        },
        required: ["subject_type", "base_version", "content"],
        additionalProperties: false,
      },
      execute: async (_toolCallId, params) => {
        const response = await this.call("proposal.submit", { ...params, engagement_id: this.#principal.engagement_id, work_run_id: binding.work_run_id, generation: binding.generation });
        return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
      },
    };
  }

  private actionRecommendationTool(binding: PiRuntimeBinding): PiRegisteredTool {
    return {
      name: "taric_action_recommend",
      label: "Recommend host action",
      description: "Record an advisory action recommendation in Taric. It does not authorize or execute the action.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", minLength: 1 },
          method: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
          uncertainty: { type: "string" },
          scope: { type: "string", minLength: 1 },
          constraints: { type: "array", items: { type: "string" } },
          memory_refs: { type: "array", items: { type: "string" } },
          evidence_refs: { type: "array", items: { type: "string" } },
        },
        required: ["target", "method", "rationale"],
        additionalProperties: false,
      },
      execute: async (_toolCallId, params) => {
        const response = await this.call("action.recommend", { ...params, engagement_id: this.#principal.engagement_id, work_run_id: binding.work_run_id, generation: binding.generation });
        return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
      },
    };
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

export function createPrincipal(role: PrincipalRole, id: string, engagementId?: string, grant: readonly PrincipalCapability[] = []): Principal {
  const defaults: Record<PrincipalRole, Principal["capabilities"]> = {
    model: ["read", "propose"],
    host: ["read", "propose", "work", "checkpoint", "action", "content"],
    reviewer: ["read", "review"],
    writer: ["read", "propose", "admit", "audit"],
    operator: ["read", "propose", "admit", "audit", "operator", "content"],
  };
  const principal = { id, role, engagement_id: engagementId, capabilities: [...new Set([...(defaults[role] ?? []), ...grant])], transport_verified: true } as Principal;
  return registerTransportPrincipal(principal);
}
