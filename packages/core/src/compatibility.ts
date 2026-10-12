/** 首发单机兼容清单。运行时诊断、CLI、MCP 与 Pi 必须使用同一份数据。 */
export interface ManifestCapability {
  id: string;
  state: "supported" | "unsupported";
  detail: string;
  follow_up?: string;
}

export interface CompatibilityManifest {
  manifest_version: "1.0";
  profile: "single_host_taric_plugin_v1";
  generated_from: "packages/core/src/compatibility.ts";
  /** 设计输入来源。只用于冻结分析基线，永远不是 runtime dependency。 */
  design_inputs: DesignInput[];
  /** 明确不做的事。投毒输入不得修改这些标志。 */
  non_goals: NonGoal[];
  security_invariants: SecurityInvariant[];
  hosts: {
    pi: { state: "supported" | "unsupported"; package: string; version: string; commit: string; extension_api: string; detail: string; follow_up?: string };
    "deepseek-harness": ManifestCapability & { version?: string; commit?: string; contract?: string };
    hermes: ManifestCapability & { version?: string; commit?: string; contract?: string };
  };
  capabilities: ManifestCapability[];
}

export interface DesignInput {
  id: string;
  kind: "local_reference" | "upstream_repository";
  location: string;
  /** 上游仓库的冻结 commit。 */
  commit?: string;
  /** 本地忽略目录没有 Git 历史时，用内容摘要锁定分析基线。 */
  content_digest?: string;
  purpose: "design_input_only";
}

export interface NonGoal { id: string; detail: string; }
export interface SecurityInvariant { id: string; detail: string; }

/** Phase 0 参考来源冻结。仅用于设计与评审，不是 runtime dependency 或格式兼容承诺。 */
export const TARIC_DESIGN_INPUTS: DesignInput[] = [
  { id: "reference/tools/kb", kind: "local_reference", location: "reference/tools/kb", content_digest: "sha256:2a61472575e6a18e1e981539dcb0ca6dea893f804e538d8e5cfea08b6de503b8", purpose: "design_input_only" },
  { id: "reference/link", kind: "local_reference", location: "reference/link", commit: "cc92f3632121b04063b24eaaf3a8c5429eaf2b57", purpose: "design_input_only" },
  { id: "ptes", kind: "upstream_repository", location: "https://github.com/pentest-standard/docs", commit: "48d01db07d3c690326d9729f7c5db0bd03bd99b9", purpose: "design_input_only" },
  { id: "pentest-skills", kind: "upstream_repository", location: "https://github.com/ahmdobeidat/pentest-skills", commit: "7941e680e2e1097386b7ba6ee65e094396d56ee4", purpose: "design_input_only" },
];

export const TARIC_NON_GOALS: NonGoal[] = [
  { id: "agent_platform", detail: "Taric 不是 agent 平台，不实现宿主运行时或 provider。" },
  { id: "agent_loop", detail: "Taric 不运行模型循环。" },
  { id: "worker_scheduler", detail: "宿主负责创建、调度和取消 worker。" },
  { id: "target_execution", detail: "Taric 不执行目标系统操作。" },
  { id: "action_grant", detail: "Taric 不签发动作授权。" },
  { id: "hitl_identity", detail: "宿主管理人工身份和审批流程。" },
  { id: "credential_management", detail: "Taric 不保存或注入凭据。" },
  { id: "artifact_content_management", detail: "Artifact 原文、脱敏与保留由宿主负责。" },
  { id: "cross_engagement_auto_sharing", detail: "跨 Engagement 不自动共享记忆。" },
  { id: "legacy_format_compatibility", detail: "不提供旧 KB/Link runtime、schema、CLI 或格式兼容。" },
];

export const TARIC_SECURITY_INVARIANTS: SecurityInvariant[] = [
  { id: "registry_immutable_from_untrusted_input", detail: "能力、非目标和安全不变量只能来自代码常量，不接受请求或内容字段。" },
  { id: "model_writes_are_proposals_only", detail: "模型输入不能提升 trust level 或获得 writer capability。" },
  { id: "host_owns_authorization", detail: "动作授权与执行始终属于宿主。" },
  { id: "engagement_isolation", detail: "记录与引用不能跨 Engagement。" },
  { id: "projection_allowlist_fixed", detail: "投影字段白名单不能由输入扩展。" },
];

export const TARIC_COMPATIBILITY_MANIFEST: CompatibilityManifest = {
  manifest_version: "1.0",
  profile: "single_host_taric_plugin_v1",
  generated_from: "packages/core/src/compatibility.ts",
  design_inputs: TARIC_DESIGN_INPUTS,
  non_goals: TARIC_NON_GOALS,
  security_invariants: TARIC_SECURITY_INVARIANTS,
  hosts: {
    pi: {
      state: "supported",
      package: "@earendil-works/pi-coding-agent",
      version: "1.1.0",
      commit: "7c10bd4",
      extension_api: "ExtensionAPI.on",
      detail: "Pi 1.1.0 lifecycle hooks and bound proposal/checkpoint/action/result/error paths are supported by the pinned host contract.",
    },
    "deepseek-harness": { id: "deepseek_native_adapter", state: "supported", version: "0.2.0-rc.2", commit: "639ed01", contract: "@deepseek-ai/cordis@4.0.4", detail: "Locked DeepSeek Harness/Cordis lifecycle bridge with Core-scoped callbacks." },
    hermes: { id: "hermes_native_adapter", state: "supported", version: "0.19.0", commit: "3ef6bbd201263d354fd83ec55b3c306ded2eb72a", contract: "general-plugin-hooks-v1", detail: "Hermes general plugin with Core RPC for context and session/tool observation; no provider replacement." },
  },
  capabilities: [
    { id: "cli.operator", state: "supported", detail: "JSON 输入输出、stderr 诊断与非零退出码。" },
    { id: "mcp.stdio_model_tools", state: "supported", detail: "initialize/tools/list/tools/call；stdout 仅协议 JSON。" },
    { id: "pi_native_adapter", state: "supported", detail: "绑定 Pi 1.1.0（commit 7c10bd4）；未测试版本按 unsupported 处理。" },
    { id: "pi.session_lifecycle", state: "supported", detail: "session_start 已接入受认证 Core client。" },
    { id: "pi.context_injection", state: "supported", detail: "context 与 before_agent_start 返回 Taric Context Pack。" },
    { id: "pi.proposal_checkpoint_action_result_hooks", state: "supported", detail: "Pi 1.1.0 proposal, checkpoint, action/result, and error callbacks are bound to the authenticated Core client." },
    { id: "deepseek_native_adapter", state: "supported", detail: "Locked DeepSeek Harness 0.2.0-rc.2 / Cordis 4.0.4 session events; no context or action lifecycle hooks." },
    { id: "hermes_native_adapter", state: "supported", detail: "Hermes 0.19.0 context and observer hooks over Core RPC; proposal/checkpoint integration and provider replacement unsupported." },
    { id: "storage.postgresql", state: "unsupported", detail: "首发只支持 SQLite WAL。", follow_up: "add-shared-authority-backend" },
    { id: "git.remote_push", state: "supported", detail: "仅在 Engagement 明确授权且真实扫描 callback 通过后推送；失败可重试。" },
    { id: "secrets.external_scanner", state: "supported", detail: "由宿主提供真实 scanner callback，并记录 tool version/result hash。" },
    { id: "quality.full_statistical_evaluation", state: "unsupported", detail: "precision/recall/95% CI 未交付。", follow_up: "validate-memory-quality" },
    { id: "graph.relation_impact", state: "supported", detail: "类型化关系、三方 patch、冲突证据和 bounded impact continuation 已交付。" },
  ],
};
