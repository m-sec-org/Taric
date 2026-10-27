import { API_CONTRACT_VERSION, registerTransportPrincipal, type CoreService, type Principal, type PrincipalCapability, type PrincipalRole, type ReviewerAttestation } from "./service.js";
import { ContractValidationError } from "./validation.js";
import type { DiagnosticDetails } from "./validation.js";

/** Adapter 契约版本与 Core API 版本分开演进；两者都必须显式声明。 */
export const ADAPTER_CONTRACT_VERSION = "1.0" as const;

export const adapterCapabilities = ["session_lifecycle", "context_injection", "proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result", "cancel", "reload"] as const;
export type AdapterCapability = (typeof adapterCapabilities)[number];

/**
 * Adapter identifiers are extension points, rather than an allow-list.  The
 * native adapters still use the well-known values below, while integrations
 * may register a namespaced identifier after format validation.
 */
export type AdapterHostId = string;

export type AdapterEvidenceState = "verified" | "pending" | "failed" | "skipped" | "mock";
export interface AdapterCertificationEvidence {
  framework_package?: string;
  distribution?: string;
  version?: string;
  commit?: string;
  state: AdapterEvidenceState;
  /** A human-readable or machine-stable reference; it is never an authority grant. */
  ref?: string;
}

export interface AdapterDescriptor {
  host_id: AdapterHostId;
  /** Framework package and host distribution are intentionally separate facts. */
  framework_package?: string;
  distribution?: string;
  /** 宿主版本与 commit 必须来自兼容清单，不接受未知版本作为 supported。 */
  version: string;
  commit?: string;
  /** Kept as a read-compatible alias for the original public descriptor. */
  host_commit?: string;
  contract_version: string;
  api_contract_version: string;
  capabilities: AdapterCapability[];
  /** Untrusted host-framework claims, preserved for diagnostics only. */
  declared_capabilities?: string[];
  /** True when native hooks are unavailable until this instance is registered. */
  runtime_binding_required?: boolean;
  supported: boolean;
  unsupported_capabilities?: string[];
  test_evidence?: string[];
  certification_evidence?: AdapterCertificationEvidence[];
  /** Static certification is supplied by Taric's manifest, never by a capability declaration. */
  native_certified?: boolean;
  /** Version-gate outcome: certified (full) / not_certified (same-major safe subset) / unsupported (far). */
  certification_state?: "certified" | "not_certified" | "unsupported";
  /** Quality-release evidence is independent from technical capability evidence. */
  quality_release_state?: "verified" | "pending" | "blocked";
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

export interface AdapterError { code: string; message: string; follow_up?: string; details?: DiagnosticDetails; }

export interface AdapterCapabilityReport {
  contract_version: string;
  api_contract_version: string;
  host_id: AdapterHostId;
  framework_package?: string;
  distribution?: string;
  host_version: string;
  commit?: string;
  host_commit?: string;
  supported: boolean;
  /** Version-gate outcome surfaced next to `supported`; uncertified never reports supported. */
  certification_state?: "certified" | "not_certified" | "unsupported";
  capabilities: AdapterCapability[];
  unsupported_capabilities: string[];
  service_connected: boolean;
  missing_capabilities: string[];
  implementation_state: "available" | "unavailable";
  runtime_state: "enabled" | "disabled";
  authorization_state: "authorized" | "unauthorized" | "unknown";
  evidence_state: AdapterEvidenceState;
  quality_release_state: "verified" | "pending" | "blocked";
  /** Per-capability composition, retained separately from the enabled list. */
  capability_status: Record<AdapterCapability, {
    implementation_state: "available" | "unavailable";
    runtime_state: "enabled" | "disabled";
    authorization_state: "authorized" | "unauthorized" | "unknown";
    evidence_state: AdapterEvidenceState;
    quality_release_state: "verified" | "pending" | "blocked";
    reason?: string;
  }>;
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
  if (!isValidAdapterId(descriptor.host_id)) return { accepted: false, reason: "invalid adapter id" };
  if (descriptor.framework_package !== undefined && !isValidAdapterId(descriptor.framework_package)) return { accepted: false, reason: "invalid framework package" };
  if (descriptor.distribution !== undefined && !isValidAdapterId(descriptor.distribution)) return { accepted: false, reason: "invalid distribution" };
  if (typeof descriptor.version !== "string" || descriptor.version.length === 0 || descriptor.version.length > 128) return { accepted: false, reason: "invalid adapter version" };
  if (descriptor.commit !== undefined && !isValidCommit(descriptor.commit)) return { accepted: false, reason: "invalid adapter commit" };
  if (descriptor.host_commit !== undefined && !isValidCommit(descriptor.host_commit)) return { accepted: false, reason: "invalid adapter commit" };
  if (descriptor.contract_version !== ADAPTER_CONTRACT_VERSION) return { accepted: false, reason: "unsupported contract version" };
  if (descriptor.api_contract_version !== API_CONTRACT_VERSION) return { accepted: false, reason: "unsupported API contract version" };
  const unknown = (descriptor.capabilities ?? []).filter((capability) => !(adapterCapabilities as readonly string[]).includes(capability));
  if (unknown.length) return { accepted: false, reason: `unsupported capabilities: ${unknown.join(",")}` };
  // A custom identifier is metadata until Taric has a matching certification
  // record. Self-declared `supported` or capability fields cannot create one.
  if (!NATIVE_ADAPTER_IDS.has(descriptor.host_id) && descriptor.supported) return { accepted: false, reason: "unsupported_capability" };
  if (!descriptor.supported) return { accepted: false, reason: "unsupported_capability" };
  return { accepted: true };
}

const NATIVE_ADAPTER_IDS = new Set(["pi", "deepseek-harness", "hermes"]);

export interface CustomAdapterIdentity {
  adapter_id: string;
  framework_package: string;
  distribution: string;
  version: string;
  commit?: string;
  /** Host claims are metadata only and never become Taric capabilities. */
  declared_capabilities?: readonly string[];
}

/** Build an un-certified custom adapter identity for use with generic Core APIs. */
export function createCustomAdapterDescriptor(identity: CustomAdapterIdentity): AdapterDescriptor {
  if (!isValidAdapterId(identity.adapter_id)) throw new ContractValidationError("validation_error", "invalid adapter id");
  const descriptor: AdapterDescriptor = {
    host_id: identity.adapter_id,
    framework_package: identity.framework_package,
    distribution: identity.distribution,
    version: identity.version,
    ...(identity.commit ? { commit: identity.commit, host_commit: identity.commit } : {}),
    contract_version: ADAPTER_CONTRACT_VERSION,
    api_contract_version: API_CONTRACT_VERSION,
    capabilities: [],
    ...(identity.declared_capabilities ? { declared_capabilities: [...identity.declared_capabilities] } : {}),
    supported: false,
    native_certified: false,
    certification_evidence: [],
    quality_release_state: "pending",
    unsupported_capabilities: ["native_adapter_not_certified"],
    fallback: ["core.authenticated_protocol"],
  };
  if (!isValidAdapterId(identity.framework_package) || !isValidAdapterId(identity.distribution) ||
      typeof identity.version !== "string" || identity.version.length === 0 || identity.version.length > 128 ||
      (identity.commit !== undefined && !isValidCommit(identity.commit))) {
    throw new ContractValidationError("validation_error", "invalid adapter identity");
  }
  return descriptor;
}

/** Validate an extension identifier without making it a native certification. */
export function isValidAdapterId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9@](?:[A-Za-z0-9._/@:~-]*[A-Za-z0-9])?$/.test(value) && !value.includes("..") && !value.includes("//");
}

function isValidCommit(value: string): boolean {
  return value.length >= 4 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/**
 * 所有宿主 adapter 共用的薄客户端。它只持有受认证 Core service 句柄，不持有 store/DB。
 * principal 由 transport 注入，宿主事件无法覆盖。
 */
export class TaricAdapterClient implements AdapterClient {
  readonly descriptor: AdapterDescriptor;
  readonly #service: CoreService;
  readonly #principal: Principal;
  #serviceContacted = false;
  #loaded = false;
  #runtimeInitialized = false;
  #registeredHooks: string[] = [];
  #availableCapabilities: AdapterCapability[] = [];

  constructor(descriptor: AdapterDescriptor, service: CoreService, principal: Principal) {
    this.descriptor = { ...descriptor, capabilities: [...(descriptor.capabilities ?? [])] };
    this.#service = service;
    this.#principal = principal;
  }

  async call<T = unknown>(operation: string, request: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: AdapterError }> {
    const response = await this.#service.dispatch(operation, this.#principal, request) as { ok: true; data: T } | { ok: false; error: AdapterError };
    this.#serviceContacted = true;
    return response;
  }

  status(): AdapterCapabilityReport {
    const certification = this.descriptor.certification_state ?? (this.descriptor.supported ? "certified" : "unsupported");
    const certificationVerified = this.hasCurrentCertificationEvidence();
    // certified 需完整取证；not_certified 允许 descriptor 声明的安全子集以
    // evidence_state "pending" 运行；unsupported 不激活任何运行时能力。
    const runtimeAllowed = certification === "certified" ? this.descriptor.supported && certificationVerified : certification === "not_certified";
    const registeredCapabilities = this.#runtimeInitialized ? [...this.#availableCapabilities] : [];
    const available = runtimeAllowed && this.#principal.transport_verified === true ? registeredCapabilities : [];
    const evidence = runtimeAllowed && certification === "not_certified" ? "pending" : this.currentEvidenceState();
    const quality = this.descriptor.quality_release_state ?? "pending";
    const implementation_state = runtimeAllowed ? "available" : "unavailable";
    const runtime_state = available.length > 0 ? "enabled" : "disabled";
    const authorization_state = this.#principal.transport_verified === true && Boolean(this.#principal.engagement_id) ? "authorized" : "unauthorized";
    const capability_status = Object.fromEntries(adapterCapabilities.map((capability) => {
      const enabled = available.includes(capability);
      return [capability, {
        implementation_state: runtimeAllowed && this.descriptor.capabilities.includes(capability) ? "available" : "unavailable",
        runtime_state: enabled && runtime_state === "enabled" ? "enabled" : "disabled",
        authorization_state,
        evidence_state: enabled ? evidence : (evidence === "verified" ? "pending" : evidence),
        quality_release_state: quality,
        ...(enabled ? {} : { reason: this.reasonForUnavailable(capability) }),
      }];
    })) as AdapterCapabilityReport["capability_status"];
    return {
      contract_version: this.descriptor.contract_version,
      api_contract_version: this.descriptor.api_contract_version,
      host_id: this.descriptor.host_id,
      framework_package: this.descriptor.framework_package,
      distribution: this.descriptor.distribution,
      host_version: this.descriptor.version,
      commit: this.descriptor.commit ?? this.descriptor.host_commit,
      host_commit: this.descriptor.host_commit,
      supported: this.descriptor.supported && certificationVerified,
      certification_state: certification,
      capabilities: [...available],
      unsupported_capabilities: [...(this.descriptor.unsupported_capabilities ?? [])],
      service_connected: this.#serviceContacted,
      missing_capabilities: adapterCapabilities.filter((capability) => !available.includes(capability)),
      implementation_state,
      runtime_state,
      authorization_state,
      evidence_state: evidence,
      quality_release_state: quality,
      capability_status,
    };
  }

  /** Record capabilities installed by this adapter instance after binding checks. */
  setRuntimeCapabilities(capabilities: readonly AdapterCapability[]): void {
    const allowed = new Set(adapterCapabilities);
    if (capabilities.some((capability) => !allowed.has(capability))) throw new ContractValidationError("validation_error", "unknown adapter capability");
    if (capabilities.some((capability) => !this.descriptor.capabilities.includes(capability))) throw new ContractValidationError("unsupported_capability", "runtime capability exceeds the certified adapter descriptor");
    this.#runtimeInitialized = true;
    this.#availableCapabilities = this.descriptor.supported && this.hasCurrentCertificationEvidence() && this.#principal.transport_verified === true
      ? [...new Set(capabilities)]
      : [];
  }

  private reasonForUnavailable(capability: AdapterCapability): string {
    const certification = this.descriptor.certification_state ?? (this.descriptor.supported ? "certified" : "unsupported");
    if (certification === "unsupported") return "host version is outside the certified line";
    if (certification === "not_certified" && !this.descriptor.capabilities.includes(capability)) return "capability requires a certified host version";
    if (!this.descriptor.supported || !this.hasCurrentCertificationEvidence()) return "unknown release or missing matching certification evidence";
    if (this.#principal.transport_verified !== true || !this.#principal.engagement_id) return "authenticated Engagement binding is unavailable";
    if (!this.#runtimeInitialized) return "adapter instance has not registered runtime hooks or tools";
    if (capability === "checkpoint" || capability === "host_result") return "requires callback and valid run binding";
    if (capability === "action_mode") return "requires a bound host tool registration";
    if (capability === "worker_attribution") return "requires host agent binding";
    return "hook or tool is not bound for this adapter instance";
  }

  private currentEvidenceState(): AdapterEvidenceState {
    const evidence = this.descriptor.certification_evidence ?? [];
    if (evidence.length === 0) return this.descriptor.supported ? "pending" : "failed";
    if (evidence.some((item) => item.state === "failed" || item.state === "skipped" || item.state === "mock")) return evidence.find((item) => item.state === "failed" || item.state === "skipped" || item.state === "mock")!.state;
    return this.hasCurrentCertificationEvidence() ? "verified" : "pending";
  }

  private hasCurrentCertificationEvidence(): boolean {
    if (!this.descriptor.supported || this.descriptor.native_certified !== true) return false;
    const matching = this.descriptor.certification_evidence?.some((item) => item.state === "verified" &&
      item.framework_package === this.descriptor.framework_package && item.distribution === this.descriptor.distribution &&
      item.version === this.descriptor.version && item.commit === (this.descriptor.commit ?? this.descriptor.host_commit));
    return matching === true;
  }

  private hasRunBinding(binding: PiRuntimeBinding): boolean {
    return typeof binding.work_run_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.work_run_id) &&
      Number.isSafeInteger(binding.generation) && (binding.generation ?? 0) > 0 &&
      typeof binding.agent_id === "string" && binding.agent_id.trim().length > 0;
  }

  async register(extension: PiExtensionApi, binding: PiRuntimeBinding = {}): Promise<{ loaded: boolean; callbacks: string[]; hooks: string[]; available_capabilities: AdapterCapability[]; missing_capabilities: AdapterCapability[]; reload_idempotent: boolean }> {
    const certification = this.descriptor.certification_state ?? (this.descriptor.supported ? "certified" : "unsupported");
    // not_certified（同 major 未认证）允许注册以绑定只读安全子集；unsupported 拒绝。
    if (this.descriptor.host_id !== "pi" || certification === "unsupported") throw new ContractValidationError("unsupported_capability", "unsupported_capability");
    const certifiedRuntime = certification === "certified";
    if (this.#principal.role !== "host" || !this.#principal.id || this.#principal.transport_verified !== true || !this.#principal.engagement_id) throw new ContractValidationError("authorization_error", "authorization_error");
    // /reload 会重新调用工厂。这里保证同一实例重复注册不会产生第二次业务副作用。
    if (this.#loaded) return { loaded: true, callbacks: [], hooks: [], available_capabilities: [...this.#availableCapabilities], missing_capabilities: adapterCapabilities.filter((item) => !this.#availableCapabilities.includes(item)), reload_idempotent: true };
    if (binding.generation !== undefined && (!Number.isSafeInteger(binding.generation) || binding.generation < 1)) throw new ContractValidationError("validation_error", "validation_error");
    if ((binding.work_run_id === undefined) !== (binding.generation === undefined)) throw new ContractValidationError("validation_error", "validation_error");
    if (binding.work_run_id !== undefined && !this.hasRunBinding(binding)) throw new ContractValidationError("validation_error", "validation_error");

    const hooks = ["session_start", "context", "before_agent_start", "agent_before_settle", "tool_result", "session_shutdown"];
    // `callbacks` is the stable Taric lifecycle vocabulary. `hooks` below is
    // the concrete Pi 1.x registration list (unchanged through 1.4.0); Pi has
    // no native proposal, checkpoint, action, result, or error event names.
    const callbacks: PiLifecycleEventName[] = ["session_start", "context"];
    extension.on("session_start", async (raw) => this.handle("session_start", raw));
    extension.on("context", async (raw) => this.handle("context", raw));
    extension.on("before_agent_start", async (raw) => this.handle("context", raw));
    extension.on("agent_before_settle", async (raw) => {
      // 权威写入面（checkpoint/error.report）仅认证版本可触达。
      if (!certifiedRuntime) return undefined;
      const event = raw as { outcome?: unknown };
      if (binding.checkpoint && this.hasRunBinding(binding) && event?.outcome !== "error") {
        const checkpoint = binding.checkpoint(raw);
        if (checkpoint) return this.call("checkpoint.commit", this.runRequest(binding, { checkpoint }));
      }
      if (event?.outcome === "error") {
        return this.call("error.report", { engagement_id: this.#principal.engagement_id, message: "Pi agent run failed" });
      }
      return undefined;
    });
    extension.on("tool_result", async (raw) => {
      // 权威写入面（error.report/action.host-result）仅认证版本可触达。
      if (!certifiedRuntime) return undefined;
      const event = raw as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
      if (event?.isError === true) {
        return this.call("error.report", { engagement_id: this.#principal.engagement_id, error_ref: typeof event.toolCallId === "string" ? event.toolCallId : undefined, message: `Pi tool ${typeof event.toolName === "string" ? event.toolName : "unknown"} failed` });
      }
      if (binding.resultForTool && this.hasRunBinding(binding)) {
        const result = binding.resultForTool(raw);
        if (result) return this.call("action.host-result", this.runRequest(binding, { ...result }));
      }
      return undefined;
    });
    if (certifiedRuntime && extension.registerTool) {
      extension.registerTool(this.proposalTool(binding));
      if (binding.recommendationForTool && this.hasRunBinding(binding)) hooks.push("tool_call");
      if (binding.recommendationForTool && this.hasRunBinding(binding)) {
        extension.on("tool_call", async (raw) => {
          const recommendation = binding.recommendationForTool?.(raw);
          if (!recommendation) return undefined;
          return this.call("action.recommend", { ...recommendation, engagement_id: this.#principal.engagement_id, work_run_id: binding.work_run_id, generation: binding.generation });
        });
      }
      hooks.push("registerTool:taric_proposal");
      if (binding.recommendationForTool && this.hasRunBinding(binding)) {
        extension.registerTool(this.actionRecommendationTool(binding));
        hooks.push("registerTool:taric_action_recommend");
      }
    }
    extension.on("session_shutdown", async () => undefined);
    this.#registeredHooks = hooks;
    const hasRunBinding = this.hasRunBinding(binding);
    this.#availableCapabilities = [
      "session_lifecycle", "context_injection",
      ...(extension.registerTool ? ["proposal_submission"] as AdapterCapability[] : []),
      ...(extension.registerTool && binding.recommendationForTool && hasRunBinding ? ["action_mode"] as AdapterCapability[] : []),
      ...(binding.agent_id && hasRunBinding ? ["worker_attribution"] as AdapterCapability[] : []),
      ...(binding.checkpoint && hasRunBinding ? ["checkpoint"] as AdapterCapability[] : []),
      ...(binding.resultForTool && hasRunBinding ? ["host_result"] as AdapterCapability[] : []),
    ];
    // 未认证版本收敛到 descriptor 声明的安全子集/最小集。
    if (!certifiedRuntime) this.#availableCapabilities = this.#availableCapabilities.filter((capability) => this.descriptor.capabilities.includes(capability));
    this.#runtimeInitialized = true;
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
          expected_version: { type: "integer", minimum: 0 },
          proposal_id: { type: "string" },
          client_request_id: { type: "string", maxLength: 128 },
          target_id: { type: "string" },
          subject_ref: { type: "string" },
          content: { type: "object" },
        },
        required: ["subject_type", "expected_version", "content"],
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

export function createPrincipal(role: PrincipalRole, id: string, engagementId?: string, grant: readonly PrincipalCapability[] = [], reviewerAttestation?: ReviewerAttestation, transportSessionId?: string): Principal {
  const defaults: Record<PrincipalRole, Principal["capabilities"]> = {
    model: ["read", "propose"],
    host: ["read", "propose", "work", "checkpoint", "action", "content"],
    reviewer: ["read", "review"],
    writer: ["read", "propose", "admit", "writer"],
    operator: ["read", "propose", "admit", "writer", "audit", "operator", "content"],
  };
  const principal = { id, role, engagement_id: engagementId, ...(transportSessionId !== undefined ? { transport_session_id: transportSessionId } : {}), capabilities: [...new Set([...(defaults[role] ?? []), ...grant])], ...(reviewerAttestation ? { reviewer_attestation: { ...reviewerAttestation } } : {}), transport_verified: true } as Principal;
  return registerTransportPrincipal(principal);
}
