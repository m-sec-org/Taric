import contractSchema from "../schemas/v1/core.schema.json" with { type: "json" };
import { SCHEMA_VERSION } from "./version.js";

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
  "review",
  "protectiveControl",
  "protectiveControlRevision",
  "controlObservation",
  "accessDecisionObservation",
  "controlApplicabilityEvent",
  "attempt",
  "workRun",
  "checkpoint",
  "actionIntent",
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
  core_api_version: "1.0.0",
  adapter_api_version: "1.0.0",
  host: { name: "Pi", version: "unsupported-unpinned", commit: "unsupported-unpinned" },
  unsupported_capabilities: unsupportedCapabilities,
} as const;
