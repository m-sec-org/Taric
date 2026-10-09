import { uuidv7 } from "./identity.js";
import type { CanonicalRecord, AuthorityStore } from "./store.js";

export type CoverageStatus = "not_tested" | "queued" | "in_progress" | "tested_no_observation" | "positive" | "inconclusive" | "blocked" | "blocked_by_control" | "not_applicable";
export interface CoverageCell extends CanonicalRecord { kind: "coverage"; resource_ref: string; test_category: string; status: CoverageStatus; limitations: string[]; evidence_refs?: string[]; }
export interface NegativeObservation extends CanonicalRecord { kind: "negative_observation"; statement: string; method: string; tested_resource_refs: string[]; conditions: string[]; evidence_refs: string[]; limitations: string[]; }

export function createCoverageCell(store: AuthorityStore, input: Omit<CoverageCell, "id" | "kind" | "version" | "trust_level">): CoverageCell {
  return store.commit({ ...input, id: uuidv7(), kind: "coverage" } as unknown as CanonicalRecord, "L1") as CoverageCell;
}

export function createNegativeObservation(store: AuthorityStore, input: Omit<NegativeObservation, "id" | "kind" | "version" | "trust_level">): NegativeObservation {
  const statement = String(input.statement);
  if (!statement.includes("未") && !statement.toLowerCase().includes("not observed")) throw new Error("negative observations must be bounded statements");
  return store.commit({ ...input, id: uuidv7(), kind: "negative_observation" } as unknown as CanonicalRecord, "L1") as NegativeObservation;
}
