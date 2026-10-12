import { ADAPTER_CONTRACT_VERSION, TaricAdapterClient, type AdapterDescriptor, type AdapterCapability, type AdapterError } from "./adapter.js";
import { API_CONTRACT_VERSION, type CoreService, type Principal } from "./service.js";

/** Locked DSH/Cordis build validated against the published 0.2.0-rc.2 package contract. */
export const SUPPORTED_DEEPSEEK_HOST = {
  version: "0.2.0-rc.2",
  commit: "639ed01",
  cordis: "4.0.4",
  package: "@deepseek-ai/dsh",
} as const;

/** Events actually exported by the pinned @deepseek-ai/dsh-session Cordis service. */
export const deepSeekHooks = ["session/created", "session/event", "session/flush", "session/disposed"] as const;
export type DeepSeekHook = (typeof deepSeekHooks)[number];
export interface DeepSeekCordisContext {
  on(event: string, handler: (...args: unknown[]) => unknown): (() => void) | void;
  [key: string]: unknown;
}
export interface DeepSeekBinding {
  engagement_id: string;
  host_id?: string;
  agent_id?: string;
  work_run_id?: string;
  generation?: number;
}

export function createDeepSeekDescriptor(version: string = SUPPORTED_DEEPSEEK_HOST.version, commit: string = SUPPORTED_DEEPSEEK_HOST.commit): AdapterDescriptor {
  const supported = version === SUPPORTED_DEEPSEEK_HOST.version && commit === SUPPORTED_DEEPSEEK_HOST.commit;
  const capabilities: AdapterCapability[] = supported ? ["session_lifecycle"] : [];
  return {
    host_id: "deepseek-harness", version, host_commit: commit,
    contract_version: ADAPTER_CONTRACT_VERSION, api_contract_version: API_CONTRACT_VERSION,
    capabilities: supported ? ["session_lifecycle"] : [], supported,
    unsupported_capabilities: supported ? [] : ["deepseek_native_adapter"],
    test_evidence: supported ? ["deepseek-session-event-contract-v1"] : [],
    fallback: ["mcp.context.query", "mcp.resource.query", "mcp.proposal.submit", "cli"],
  };
}

export class DeepSeekHarnessAdapter {
  readonly client: TaricAdapterClient;
  readonly descriptor: AdapterDescriptor;
  readonly #principal: Principal;
  readonly #disposers: Array<() => void> = [];
  readonly #eventResults = new Map<string, Promise<unknown>>();
  #loaded = false;
  constructor(service: CoreService, principal: Principal, version: string = SUPPORTED_DEEPSEEK_HOST.version, commit: string = SUPPORTED_DEEPSEEK_HOST.commit) {
    this.descriptor = createDeepSeekDescriptor(version, commit);
    this.client = new TaricAdapterClient(this.descriptor, service, principal);
    this.#principal = principal;
  }
  call<T = unknown>(operation: string, request: Record<string, unknown>) { return this.client.call<T>(operation, request); }
  status() { return { ...this.client.status(), service_connected: this.#principal.transport_verified === true, hooks: this.#loaded ? [...deepSeekHooks] : [], fallback: [...(this.descriptor.fallback ?? [])], test_evidence: [...(this.descriptor.test_evidence ?? [])] }; }
  async register(ctx: DeepSeekCordisContext, binding: DeepSeekBinding) {
    if (!this.descriptor.supported) throw new Error("unsupported_capability");
    if (this.#principal.role !== "host" || !this.#principal.transport_verified || !this.#principal.engagement_id || binding.engagement_id !== this.#principal.engagement_id) throw new Error("authorization_error");
    if (this.#loaded) return { loaded: true, hooks: [], available_capabilities: [...this.descriptor.capabilities], reload_idempotent: true };
    if ((binding.work_run_id === undefined) !== (binding.generation === undefined)) throw new Error("validation_error");
    const handlers: Record<DeepSeekHook, (...args: unknown[]) => Promise<unknown> | undefined> = {
      "session/created": async () => this.call("engagement.status", { engagement_id: binding.engagement_id }),
      "session/event": (_session, event) => {
        const value = objectPayload(event);
        return this.idempotent({ event_id: value.id, type: value.type }, async () => ({ observed: true, type: value.type }));
      },
      "session/flush": async () => undefined,
      "session/disposed": async () => undefined,
    };
    for (const event of deepSeekHooks) {
      const disposer = ctx.on(event, (...args) => handlers[event](...args));
      if (typeof disposer !== "function") throw new Error(`unavailable_host: Cordis did not register ${event}`);
      this.#disposers.push(disposer);
    }
    this.#loaded = true;
    return { loaded: true, hooks: [...deepSeekHooks], available_capabilities: [...this.descriptor.capabilities], missing_capabilities: ["context_injection", "proposal_submission", "worker_attribution", "checkpoint", "action_mode", "host_result", "cancel", "reload"], reload_idempotent: true };
  }
  unload() { for (const dispose of this.#disposers.splice(0).reverse()) dispose(); this.#loaded = false; }
  private idempotent(payload: unknown, call: () => Promise<unknown>): Promise<unknown> {
    const object = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const key = typeof object.idempotency_key === "string" ? object.idempotency_key : typeof object.event_id === "string" ? object.event_id : undefined;
    if (!key) return call();
    const prior = this.#eventResults.get(key);
    if (prior) return prior;
    const result = call(); this.#eventResults.set(key, result); return result;
  }
}

function objectPayload(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function createDeepSeekHarnessAdapter(service: CoreService, principal: Principal, version: string = SUPPORTED_DEEPSEEK_HOST.version, commit: string = SUPPORTED_DEEPSEEK_HOST.commit) { return new DeepSeekHarnessAdapter(service, principal, version, commit); }

/** Hermes requests are delegated to its Python general plugin over authenticated local JSON-RPC. */
export const SUPPORTED_HERMES_HOST = { version: "0.19.0", commit: "3ef6bbd201263d354fd83ec55b3c306ded2eb72a" } as const;
export function createHermesDescriptor(version: string = SUPPORTED_HERMES_HOST.version, commit: string = SUPPORTED_HERMES_HOST.commit): AdapterDescriptor {
  const supported = version === SUPPORTED_HERMES_HOST.version && commit === SUPPORTED_HERMES_HOST.commit;
  return { host_id: "hermes", version, host_commit: commit, contract_version: ADAPTER_CONTRACT_VERSION, api_contract_version: API_CONTRACT_VERSION,
    capabilities: supported ? ["session_lifecycle", "context_injection"] : [], supported,
    unsupported_capabilities: supported ? [] : ["hermes_native_adapter"], test_evidence: supported ? ["hermes-plugin-runtime-contract-v1"] : [],
    fallback: ["mcp.context.query", "mcp.resource.query", "mcp.proposal.submit", "cli"] };
}

export function createHermesAdapter(service: CoreService, principal: Principal, version: string = SUPPORTED_HERMES_HOST.version, commit: string = SUPPORTED_HERMES_HOST.commit) {
  const descriptor = createHermesDescriptor(version, commit);
  return new TaricAdapterClient(descriptor, service, principal);
}

export type NativeAdapterError = AdapterError;
