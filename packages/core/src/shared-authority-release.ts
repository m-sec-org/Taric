import { createHash } from "node:crypto";
import { coreSchema, SCHEMA_VERSION } from "@taric/schemas";
import type { DeploymentDiagnostics, DeploymentGuardInput } from "./deployment-guard.js";
import { checkDeploymentGuard } from "./deployment-guard.js";
import { policyDigest } from "./policy.js";

export const SHARED_AUTHORITY_RELEASE_REPORT_VERSION = "shared-authority-release/1" as const;

export interface SharedAuthorityGate {
  id: string;
  passed: boolean;
  required?: boolean;
  reason?: string;
  evidence?: readonly string[];
}

export interface BackupRecoveryEvidence {
  verified: boolean;
  schema_version?: string;
  source_sequence?: number;
  recovered_sequence?: number;
  backup_timestamp?: string;
  integrity?: string;
  engagement_id?: string;
  provenance_verified?: boolean;
  revisions_verified?: boolean;
  unresolved_errors?: readonly string[];
}

export interface SharedAuthorityReleaseInput extends DeploymentGuardInput {
  schema_version?: string;
  schemaVersion?: string;
  schema_digest?: string;
  schemaDigest?: string;
  policy_digest?: string;
  policyDigest?: string;
  backup?: BackupRecoveryEvidence;
  conformance?: { passed: boolean; suite_version?: string; evidence?: readonly string[] };
  gates?: readonly SharedAuthorityGate[];
  required_gate_ids?: readonly string[];
  requiredGateIds?: readonly string[];
}

export interface SharedAuthorityReleaseGate extends Omit<SharedAuthorityGate, "reason" | "evidence" | "required"> {
  required: boolean;
  reason: string | null;
  evidence: readonly string[];
}

export interface SharedAuthorityReleaseEvidence {
  version: typeof SHARED_AUTHORITY_RELEASE_REPORT_VERSION;
  profile: "single_host_sqlite" | "multi_host_authority";
  backend: "sqlite" | "postgresql";
  status: "enabled" | "disabled" | "failed";
  enabled: boolean;
  diagnostics: DeploymentDiagnostics;
  schema_version: string | null;
  schema_digest: string | null;
  policy_digest: string | null;
  backup: BackupRecoveryEvidence | null;
  recovered_sequence: number | null;
  conformance: { passed: boolean; suite_version: string | null; evidence: readonly string[] };
  gates: readonly SharedAuthorityReleaseGate[];
  failures: readonly string[];
}

function requiredIds(input: SharedAuthorityReleaseInput): readonly string[] {
  const ids = input.required_gate_ids ?? input.requiredGateIds ?? [
    "storage-conformance",
    "backup-restore",
    "lease-fencing",
    "reader-pin",
    "failure-recovery",
  ];
  return [...new Set(ids.map(String))].sort((a, b) => a.localeCompare(b));
}

function normalizeGates(input: SharedAuthorityReleaseInput, required: readonly string[]): readonly SharedAuthorityReleaseGate[] {
  const seen = new Set<string>();
  const gates = [...(input.gates ?? [])].map((gate) => {
    if (!gate || typeof gate.id !== "string" || gate.id.trim() === "") throw new TypeError("release gate id is required");
    if (seen.has(gate.id)) throw new TypeError(`duplicate release gate id: ${gate.id}`);
    seen.add(gate.id);
    return {
      id: gate.id,
      passed: gate.passed === true,
      required: required.includes(gate.id) || gate.required !== false,
      reason: gate.reason?.trim() || (gate.passed === true ? null : `gate ${gate.id} failed`),
      evidence: [...(gate.evidence ?? [])].map(String).sort((a, b) => a.localeCompare(b)),
    };
  });
  for (const id of required) if (!seen.has(id)) gates.push({ id, passed: false, required: true, reason: `required gate ${id} has no outcome`, evidence: [] });
  return gates.sort((a, b) => a.id.localeCompare(b.id));
}

function validBackupMetadata(backup: BackupRecoveryEvidence | null): boolean {
  if (!backup?.verified) return false;
  if (!backup.schema_version || !backup.engagement_id || !backup.integrity) return false;
  if (!Number.isSafeInteger(backup.source_sequence) || Number(backup.source_sequence) < 0) return false;
  if (!Number.isSafeInteger(backup.recovered_sequence) || Number(backup.recovered_sequence) < 0) return false;
  if (backup.recovered_sequence !== backup.source_sequence) return false;
  if (!backup.backup_timestamp || !Number.isFinite(Date.parse(backup.backup_timestamp))) return false;
  if (backup.provenance_verified !== true || backup.revisions_verified !== true) return false;
  return (backup.unresolved_errors?.length ?? 0) === 0;
}

function validDigest(value: string | undefined): boolean {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const CURRENT_SCHEMA_DIGEST = digest(JSON.stringify(coreSchema));

/**
 * Build deterministic Phase 5 evidence. Multi-host is enabled only when the
 * deployment guard, every required gate, conformance, and verified backup all
 * pass. A single-host report intentionally records Phase 5 as disabled.
 */
export function buildSharedAuthorityReleaseEvidence(input: SharedAuthorityReleaseInput): SharedAuthorityReleaseEvidence {
  if (!input || typeof input !== "object") throw new TypeError("release evidence input is required");
  const guard = checkDeploymentGuard(input);
  const required = requiredIds(input);
  const gates = normalizeGates(input, required);
  const conformance = {
    passed: input.conformance?.passed === true,
    suite_version: input.conformance?.suite_version ?? null,
    evidence: [...(input.conformance?.evidence ?? [])].map(String).sort((a, b) => a.localeCompare(b)),
  };
  const backup = input.backup ? { ...input.backup, unresolved_errors: [...(input.backup.unresolved_errors ?? [])].map(String).sort((a, b) => a.localeCompare(b)) } : null;
  const failures: string[] = [];
  if (guard.supported === false) failures.push(...guard.reasons);
  if (guard.diagnostics.profile === "multi_host_authority") {
    for (const gate of gates) if (gate.required && !gate.passed) failures.push(gate.reason ?? `required gate ${gate.id} failed`);
    if (!conformance.passed || !conformance.suite_version || conformance.evidence.length === 0) failures.push("shared storage conformance did not pass with versioned evidence");
    if (!validBackupMetadata(backup)) failures.push("verified backup/restore metadata, provenance, revisions, and recovered sequence are required");
    if (!validDigest(input.schema_digest ?? input.schemaDigest ?? CURRENT_SCHEMA_DIGEST)) failures.push("shared authority schema digest is invalid");
    if (!validDigest(input.policy_digest ?? input.policyDigest ?? policyDigest())) failures.push("shared authority policy digest is invalid");
  }
  const enabled = guard.diagnostics.profile === "multi_host_authority" && failures.length === 0;
  return {
    version: SHARED_AUTHORITY_RELEASE_REPORT_VERSION,
    profile: guard.diagnostics.profile,
    backend: guard.diagnostics.backend,
    status: guard.diagnostics.profile === "single_host_sqlite" ? "disabled" : enabled ? "enabled" : "failed",
    enabled,
    diagnostics: guard.diagnostics,
    schema_version: input.schema_version ?? input.schemaVersion ?? backup?.schema_version ?? SCHEMA_VERSION,
    schema_digest: input.schema_digest ?? input.schemaDigest ?? CURRENT_SCHEMA_DIGEST,
    policy_digest: input.policy_digest ?? input.policyDigest ?? policyDigest(),
    backup,
    recovered_sequence: backup?.recovered_sequence ?? null,
    conformance,
    gates,
    failures: [...new Set(failures)],
  };
}

export const createSharedAuthorityReleaseEvidence = buildSharedAuthorityReleaseEvidence;

