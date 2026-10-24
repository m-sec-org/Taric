import contractSchema from "../schemas/v1/core.schema.json" with { type: "json" };
import { SCHEMA_VERSION } from "./version.js";
import { ADAPTER_CONTRACT_VERSION, API_CONTRACT_VERSION } from "./registry.js";

export { SCHEMA_VERSION } from "./version.js";
export * from "./registry.js";
export * from "./types.js";

export const CORE_SCHEMA_ID = contractSchema.$id;
export const coreSchema = contractSchema;
export const contractNames = [
  "scope",
  "engagement",
  "resource",
  "resourceRevision",
  "observation",
  "relation",
  "testHypothesis",
  "attackPath",
  "patchSet",
  "conflict",
  "impactEvent",
  "claim",
  "workItem",
  "evidence",
  "finding",
  "coverageCell",
  "negativeObservation",
  "proposal",
  "proposalEnvelope",
  "proposalCandidate",
  "proposalProvenance",
  "promotionL2",
  "review",
  "reviewPackRequest",
  "reviewSubmitRequest",
  "protectiveControl",
  "protectiveControlRevision",
  "controlObservation",
  "accessDecisionObservation",
  "controlApplicabilityEvent",
  "attempt",
  "workRun",
  "workQueryRequest",
  "coverageGateResult",
  "coverageQueryRequest",
  "checkpoint",
  "actionIntent",
  "artifactSessionBinding",
  "artifactStoreBegin",
  "artifactIngestFile",
  "artifactStoreAppend",
  "artifactStoreCommit",
  "artifactContentRead",
  "artifactContentList",
  "artifactSessionOutput",
  "auditEvent",
  "apiSuccess",
  "apiError",
] as const;
export type ContractName = (typeof contractNames)[number];

export const unsupportedCapabilities = [
  "postgresql_authority",
  "remote_push",
  "full_quality_evaluation",
  "snapshot_import",
  "migration",
  "backup_restore",
  "target_execution",
] as const;
export type UnsupportedCapability = (typeof unsupportedCapabilities)[number];

export const supportedProfile = {
  deployment: "single_host",
  schema_version: SCHEMA_VERSION,
  core_api_version: API_CONTRACT_VERSION,
  adapter_api_version: ADAPTER_CONTRACT_VERSION,
  host: { name: "Pi", version: "unsupported-unpinned", commit: "unsupported-unpinned" },
  unsupported_capabilities: unsupportedCapabilities,
} as const;
