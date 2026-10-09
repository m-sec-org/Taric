import contractSchema from "../schemas/v1/core.schema.json" with { type: "json" };

export const SCHEMA_VERSION = "1.0.0" as const;
export const CORE_SCHEMA_ID = contractSchema.$id;
export const coreSchema = contractSchema;
export const contractNames = [
  "scope",
  "engagement",
  "resource",
  "observation",
  "relation",
  "claim",
  "workItem",
  "evidence",
  "finding",
  "coverageCell",
  "proposal",
  "review",
] as const;
export type ContractName = (typeof contractNames)[number];
