import { SCHEMA_VERSION } from "./version.js";

/**
 * Phase 1 合同注册表（tasks 1.3）。
 *
 * 每个受支持操作都声明 request/response/error/unsupported 四类契约，Core、CLI、MCP
 * 与 adapter 都从这一份注册表派生，避免各处维护不同的支持名单。注册表只描述本期
 * 单机首发实际交付的操作；延期能力必须显式登记为 unsupported 并给出 follow-up。
 */

export const API_CONTRACT_VERSION = "1.0.0" as const;
export const ADAPTER_CONTRACT_VERSION = "1.0" as const;

export type OperationRole = "model" | "host" | "reviewer" | "writer" | "operator";
export type ContractRef = string;
/**
 * 稳定操作名：`domain.verb` 形式（`action.host-decision`）或单词形式（例如 `query`）。
 * 单词名同样是受支持的公开操作名，不能被点分约束误判为非法；复合词允许连字符。
 */
export const OPERATION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function isValidOperationName(operation: string): boolean {
  return OPERATION_NAME_PATTERN.test(operation);
}

/** 稳定的 API 错误码；CLI/MCP/Pi 必须原样保留，不得改写为通用失败。 */
export const apiErrorCodes = [
  "validation_error",
  "authorization_error",
  "stale_version",
  "conflict",
  "unsupported_capability",
  "unsupported_schema_version",
  "unavailable_host",
  "internal_error",
  "idempotency_conflict",
  "invalid_cursor",
  "minimum_budget_required",
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

export interface OperationContract {
  /** 稳定的点分操作名，例如 `proposal.submit`。 */
  operation: string;
  /** 允许调用该操作的角色；空数组表示任何已验证 principal 都不可调用。 */
  roles: OperationRole[];
  request: ContractRef;
  response: ContractRef;
  /** 该操作可能返回的错误码子集。 */
  errors: ApiErrorCode[];
  /** 该操作是否接受幂等键；接受时重试必须返回原始结果。 */
  idempotent: boolean;
  /** 该操作是否改变权威状态。 */
  mutates_authority: boolean;
  /** 需要 Engagement 归属校验。 */
  engagement_scoped: boolean;
  capability?: string;
}

export interface UnsupportedContract {
  capability: string;
  /** 承接该能力的 follow-up change 名称。 */
  follow_up: string;
  reason: string;
}

const COMMON_READ_ERRORS: ApiErrorCode[] = ["validation_error", "authorization_error", "invalid_cursor", "minimum_budget_required", "internal_error"];
const COMMON_WRITE_ERRORS: ApiErrorCode[] = [
  "validation_error",
  "authorization_error",
  "stale_version",
  "conflict",
  "unsupported_schema_version",
  "internal_error",
  "idempotency_conflict",
];

/** 本期受支持的 Phase 1 操作目录。顺序即文档中的稳定顺序。 */
export const operationContracts: OperationContract[] = [
  { operation: "engagement.init", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: false },
  { operation: "engagement.status", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "capability.status", roles: ["model", "host", "reviewer", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: false },
  { operation: "adapter.status", roles: ["host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: false },
  { operation: "adapter.install", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: false, engagement_scoped: false },
  { operation: "adapter.remove", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: false, engagement_scoped: false },
  { operation: "adapter.config", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: false, engagement_scoped: false },
  { operation: "context.build", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "context.query", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "query", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "resource.query", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "evidence.query", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "proposal.submit", roles: ["model", "host", "operator"], request: "proposalEnvelope", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: true, engagement_scoped: true },
  { operation: "proposal.list", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "capture.observation", roles: ["host", "operator"], request: "observation", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "review.submit", roles: ["reviewer"], request: "review", response: "apiSuccess", errors: [...COMMON_WRITE_ERRORS, "conflict"], idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "admission.evaluate", roles: ["host", "writer", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: true, engagement_scoped: true },
  { operation: "admission.commit", roles: ["host", "writer", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: true, engagement_scoped: true },
  { operation: "admission.promote_l2", roles: ["writer", "operator"], request: "promotionL2", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: true, engagement_scoped: true, capability: "writer" },
  { operation: "control.observe", roles: ["host", "operator"], request: "controlObservation", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "access.observe", roles: ["host", "operator"], request: "accessDecisionObservation", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "control.list", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "work.claim", roles: ["host"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "work.renew", roles: ["host"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "work.reclaim", roles: ["host"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "work.resume", roles: ["host"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "checkpoint.propose", roles: ["model", "host", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "checkpoint.commit", roles: ["host"], request: "checkpoint", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "action.recommend", roles: ["model", "host", "operator"], request: "actionIntent", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "action.host-decision", roles: ["host"], request: "actionIntent", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "action.host-result", roles: ["host"], request: "actionIntent", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "action.reconcile", roles: ["host"], request: "actionIntent", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "artifact.session.bind", roles: ["host", "operator"], request: "artifactSessionBinding", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: true, engagement_scoped: true },
  { operation: "artifact.store.begin", roles: ["host", "operator"], request: "artifactStoreBegin", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: true, engagement_scoped: true },
  { operation: "artifact.store.append", roles: ["host", "operator"], request: "artifactStoreAppend", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: true, engagement_scoped: true },
  { operation: "artifact.store.commit", roles: ["host", "operator"], request: "artifactStoreCommit", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: true, mutates_authority: true, engagement_scoped: true },
  { operation: "artifact.metadata", roles: ["host", "operator"], request: "artifactContentRead", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "artifact.content.read", roles: ["host", "operator"], request: "artifactContentRead", response: "apiSuccess", errors: [...COMMON_READ_ERRORS, "unavailable_host"], idempotent: false, mutates_authority: false, engagement_scoped: true, capability: "content_read" },
  { operation: "artifact.content.list", roles: ["host", "operator"], request: "artifactContentList", response: "apiSuccess", errors: [...COMMON_READ_ERRORS, "unavailable_host"], idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "artifact.session.output", roles: ["host", "operator"], request: "artifactSessionOutput", response: "apiSuccess", errors: [...COMMON_READ_ERRORS, "unavailable_host"], idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "audit.verify", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: false },
  { operation: "audit.doctor", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: false },
  { operation: "audit.reconcile", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: false },
  { operation: "error.report", roles: ["host"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "snapshot.export", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_READ_ERRORS, idempotent: false, mutates_authority: false, engagement_scoped: true },
  { operation: "resource.revise", roles: ["host", "writer", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "resource.patch", roles: ["host", "writer", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "resource.relation", roles: ["host", "writer", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "resource.impact", roles: ["host", "writer", "operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
  { operation: "snapshot.import", roles: ["operator"], request: "apiSuccess", response: "apiSuccess", errors: COMMON_WRITE_ERRORS, idempotent: false, mutates_authority: true, engagement_scoped: true },
];

/** 本期不交付、必须返回 unsupported_capability 的能力。 */
export const unsupportedContracts: UnsupportedContract[] = [
  { capability: "migration", follow_up: "evolve-engagement-memory", reason: "升级迁移属于后续变更" },
  { capability: "backup.restore", follow_up: "evolve-engagement-memory", reason: "备份/恢复属于后续变更" },
  { capability: "remote.push", follow_up: "evolve-engagement-memory", reason: "远端 push 与外部 secrets scan 属于后续变更" },
  { capability: "full_quality_evaluation", follow_up: "validate-memory-quality", reason: "precision/recall 与 95% CI 属于后续变更" },
];

/**
 * 永久非目标：本期和后续变更都不实现，因此没有 follow-up 承接。
 * 与 `unsupportedContracts` 区分，避免把非目标伪装成待交付能力。
 */
export const permanentNonGoals: Array<{ capability: string; reason: string }> = [
  { capability: "target_execution", reason: "Taric 不执行目标系统动作，也不发放授权；始终由宿主负责" },
  { capability: "hitl_identity", reason: "Taric 不建立人的身份或 HITL 审批系统" },
  { capability: "agent_loop", reason: "Taric 不实现 agent loop 或 worker 调度" },
  { capability: "audit_signing_keys", reason: "Taric 不托管审计签名密钥" },
  { capability: "artifact_redaction", reason: "Taric stores opaque originals and does not redact payloads" },
  { capability: "secret_scanning", reason: "Taric does not inspect raw payloads for secrets" },
  { capability: "credential_lifecycle", reason: "Taric does not manage credential or token lifecycle" },
  { capability: "content_retention", reason: "Retention and expiry remain host/operator policy" },
];

const operationsByName = new Map(operationContracts.map((contract) => [contract.operation, contract]));
const unsupportedByName = new Map(unsupportedContracts.map((contract) => [contract.capability, contract]));

export function operationContract(operation: string): OperationContract | undefined {
  return operationsByName.get(operation);
}

export function unsupportedContract(capability: string): UnsupportedContract | undefined {
  return unsupportedByName.get(capability);
}

export function isSupportedOperation(operation: string): boolean {
  return operationsByName.has(operation);
}

export function supportedOperations(): string[] {
  return operationContracts.map((contract) => contract.operation);
}

/** follow-up 变更集合，用于校验注册表指向的 change 真实存在。 */
export const followUpChanges = [
  "integrate-native-host-adapters",
  "evolve-engagement-memory",
  "validate-memory-quality",
  "add-shared-authority-backend",
] as const;
export type FollowUpChange = (typeof followUpChanges)[number];

export const contractRegistry = {
  schema_version: SCHEMA_VERSION,
  api_contract_version: API_CONTRACT_VERSION,
  adapter_contract_version: ADAPTER_CONTRACT_VERSION,
  error_codes: apiErrorCodes,
  operations: operationContracts,
  unsupported: unsupportedContracts,
  permanent_non_goals: permanentNonGoals,
  follow_ups: followUpChanges,
} as const;
