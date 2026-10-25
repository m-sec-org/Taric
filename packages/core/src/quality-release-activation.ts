import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { coreSchema } from "@taric/schemas";
import { policyDigest } from "./policy.js";
import { verifyReleaseReport, type ReleaseReportVerificationFailure } from "./release-report.js";
import { runtimeImplementationDigest } from "./implementation-digest.js";

const digest = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface QualityReleaseActivation {
  activatable: boolean;
  failures: readonly ReleaseReportVerificationFailure[];
}

/**
 * Verify report bytes against an independently provisioned deployment pin,
 * then bind the embedded evidence to the Core implementation running now.
 */
export function verifyPinnedQualityReleaseReport(reportBytes: Uint8Array, expectedReportDigest: string | undefined): QualityReleaseActivation {
  const failures: ReleaseReportVerificationFailure[] = [];
  if (typeof expectedReportDigest !== "string" || !SHA256.test(expectedReportDigest)) {
    return { activatable: false, failures: [{ kind: "invalid-report", reason: "an independently provisioned SHA-256 report pin is required" }] };
  }
  if (digest(Buffer.from(reportBytes)) !== expectedReportDigest) {
    return { activatable: false, failures: [{ kind: "stale-report", reason: "quality release report bytes do not match the configured pin" }] };
  }

  let wrapper: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(reportBytes).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("report wrapper must be an object");
    wrapper = parsed as Record<string, unknown>;
  } catch {
    return { activatable: false, failures: [{ kind: "invalid-report", reason: "pinned quality release report is malformed" }] };
  }
  if (wrapper.technical_passed !== true || wrapper.implementation_complete !== true) failures.push({ kind: "failed-report", reason: "technical and runtime release gates must pass before quality activation" });

  const current = {
    commit: runtimeImplementationDigest() as `sha256:${string}`,
    schema: digest(JSON.stringify(coreSchema)) as `sha256:${string}`,
    policy: policyDigest() as `sha256:${string}`,
  };
  if (wrapper.schema_digest !== current.schema) failures.push({ kind: "stale-report", reason: "quality release report schema digest does not match this runtime" });
  if (wrapper.policy_digest !== current.policy) failures.push({ kind: "stale-report", reason: "quality release report policy digest does not match this runtime" });

  const quality = wrapper.quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) {
    failures.push({ kind: "invalid-report", reason: "quality release report payload is required" });
  } else {
    const qualityDigests = (quality as Record<string, unknown>).digests;
    if (!qualityDigests || typeof qualityDigests !== "object" || Array.isArray(qualityDigests)) {
      failures.push({ kind: "invalid-report", reason: "quality release report digests are required" });
    } else {
      const values = qualityDigests as Record<string, unknown>;
      if (values.commit !== current.commit) failures.push({ kind: "stale-report", reason: "quality release report implementation digest does not match this runtime" });
      if (values.schema !== current.schema) failures.push({ kind: "stale-report", reason: "quality release report schema digest does not match this runtime" });
      if (values.policy !== current.policy) failures.push({ kind: "stale-report", reason: "quality release report policy digest does not match this runtime" });
      if (values.sample !== wrapper.sample_digest || !SHA256.test(String(values.sample))) failures.push({ kind: "invalid-report", reason: "quality sample digest does not match the pinned release wrapper" });
      if (values.fixture !== wrapper.fixture_digest || !SHA256.test(String(values.fixture))) failures.push({ kind: "invalid-report", reason: "quality fixture digest does not match the pinned release wrapper" });
      if (failures.length === 0) failures.push(...verifyReleaseReport(quality, { ...current, sample: values.sample as `sha256:${string}`, fixture: values.fixture as `sha256:${string}` }).failures);
    }
  }
  return { activatable: failures.length === 0, failures };
}

/** Missing or unreadable deployment evidence is a deterministic disabled state. */
export function loadPinnedQualityReleaseActivation(path: string | undefined, expectedReportDigest: string | undefined): QualityReleaseActivation {
  if (!path) return { activatable: false, failures: [{ kind: "invalid-report", reason: "quality release report path is not configured" }] };
  if (!expectedReportDigest) return verifyPinnedQualityReleaseReport(Buffer.alloc(0), expectedReportDigest);
  try {
    return verifyPinnedQualityReleaseReport(readFileSync(path), expectedReportDigest);
  } catch {
    return { activatable: false, failures: [{ kind: "invalid-report", reason: "configured quality release report is unavailable" }] };
  }
}
