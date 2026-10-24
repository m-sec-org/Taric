import { readFileSync } from "node:fs";
import { createPrincipal, openRuntimeService, type CoreService, type Principal, type ReviewerAttestation } from "@taric/core";
import { discoverCliConfig } from "./cli.js";

export interface ReviewHarnessOptions {
  proposal?: string;
  inputHash?: string;
  engagementId?: string;
  exportPack?: boolean;
  submitResult?: string;
}

export interface ReviewHarnessResult {
  ok: boolean;
  mode: "export" | "submit";
  pack_markdown: string;
  submitted: boolean;
  review?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const verdicts = ["pass", "reject", "needs_evidence", "defer"] as const;
type Verdict = (typeof verdicts)[number];

function parseArgs(argv: readonly string[]): ReviewHarnessOptions {
  const options: ReviewHarnessOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = () => argv[++index];
    if (argument === "--proposal") options.proposal = next();
    else if (argument === "--input-hash") options.inputHash = next();
    else if (argument === "--engagement-id") options.engagementId = next();
    else if (argument === "--export") options.exportPack = true;
    else if (argument === "--submit-result") options.submitResult = next();
    else if (["--model", "--provider-url", "--provider-model", "--auto", "--human", "--confirm", "--verdict"].includes(argument))
      throw Object.assign(new Error("model invocation, reviewer selection, and verdict generation belong to the host/operator"), { code: "unsupported_capability" });
    else throw Object.assign(new Error(`unsupported review option: ${argument}`), { code: "validation_error" });
  }
  return options;
}

function renderPack(pack: Record<string, unknown>): string {
  return [
    "# Taric Fixed Review Pack",
    "",
    `Proposal: \`${String(pack.proposal_id)}\``,
    `Input hash: \`${String(pack.proposal_hash)}\``,
    `Evidence snapshot hash: \`${String(pack.evidence_snapshot_hash)}\``,
    `Admission policy digest: \`${String(pack.policy_digest)}\``,
    `Admission sequence: \`${String(pack.admission_seq)}\``,
    `Pack hash: \`${String(pack.pack_hash)}\``,
    "",
    "The following data is the complete sanitized snapshot captured by the admission operation. It does not resolve replacement evidence from live state.",
    "",
    "```json",
    JSON.stringify(pack, null, 2),
    "```",
    "",
  ].join("\n");
}

interface ExternalReviewResult {
  reviewer_id: string;
  verdict: Verdict;
  input_hash: string;
  evidence_snapshot_hash: string;
  policy_digest: string;
  rubric_hash?: string;
  limitations?: string[];
}

function readExternalResult(path: string): ExternalReviewResult {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw Object.assign(new Error("review result file must contain valid JSON"), { code: "validation_error" }); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("review result must be an object"), { code: "validation_error" });
  const result = value as Record<string, unknown>;
  const allowed = new Set(["reviewer_id", "verdict", "input_hash", "evidence_snapshot_hash", "policy_digest", "rubric_hash", "limitations"]);
  if (Object.keys(result).some((key) => !allowed.has(key))
    || typeof result.reviewer_id !== "string" || !result.reviewer_id.trim()
    || !verdicts.includes(result.verdict as Verdict)
    || typeof result.input_hash !== "string" || typeof result.evidence_snapshot_hash !== "string" || typeof result.policy_digest !== "string"
    || (result.rubric_hash !== undefined && typeof result.rubric_hash !== "string")
    || (result.limitations !== undefined && (!Array.isArray(result.limitations) || result.limitations.some((item) => typeof item !== "string")))
  ) throw Object.assign(new Error("review result fields are invalid"), { code: "validation_error" });
  return result as unknown as ExternalReviewResult;
}

const isDigest = (value: string): boolean => /^sha256:[a-f0-9]{64}$/.test(value);

function configuredReviewer(env: NodeJS.ProcessEnv): { id: string; attestation: ReviewerAttestation } | undefined {
  if (!env.TARIC_REVIEWER_ID || !env.TARIC_REVIEWER_ATTESTATION) return undefined;
  try {
    const value = JSON.parse(env.TARIC_REVIEWER_ATTESTATION) as Record<string, unknown>;
    if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).some((key) => !["capability", "model", "prompt_digest", "ruleset_digest"].includes(key))
      || !["deterministic", "model", "human"].includes(String(value.capability))
      || (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim()))
      || [value.prompt_digest, value.ruleset_digest].some((item) => item !== undefined && (typeof item !== "string" || !isDigest(item)))) return undefined;
    return { id: env.TARIC_REVIEWER_ID, attestation: value as unknown as ReviewerAttestation };
  } catch { return undefined; }
}

export async function runReviewHarness(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ReviewHarnessResult> {
  let options: ReviewHarnessOptions;
  try { options = parseArgs(argv); }
  catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : "validation_error";
    return { ok: false, mode: "export", pack_markdown: "", submitted: false, error: { code, message: cause instanceof Error ? cause.message : "review options are invalid" } };
  }
  const mode: ReviewHarnessResult["mode"] = options.submitResult ? "submit" : "export";
  const fail = (code: string, message: string): ReviewHarnessResult => ({ ok: false, mode, pack_markdown: "", submitted: false, error: { code, message } });
  if (Boolean(options.proposal) === Boolean(options.inputHash)) return fail("validation_error", "provide exactly one of --proposal or --input-hash");
  if (options.inputHash && !isDigest(options.inputHash)) return fail("validation_error", "--input-hash must be a SHA-256 digest");
  if (Boolean(options.exportPack) === Boolean(options.submitResult)) return fail("validation_error", "choose exactly one of --export or --submit-result");
  if (!options.engagementId && !env.TARIC_ENGAGEMENT_ID) return fail("validation_error", "engagement id is required (--engagement-id or TARIC_ENGAGEMENT_ID)");
  const engagementId = options.engagementId ?? env.TARIC_ENGAGEMENT_ID!;

  const { config } = discoverCliConfig(env);
  const service = await openRuntimeService({ config, env });
  try {
    const operator = createPrincipal("operator", "review-pack-exporter", engagementId);
    let proposalId = options.proposal;
    if (!proposalId && options.inputHash) {
      let cursor: string | undefined;
      const matches: string[] = [];
      do {
        const page = await service.listProposals(operator, { engagement_id: engagementId, page_size: 1000, ...(cursor ? { cursor } : {}) });
        if (!page.ok) return fail(page.error.code, page.error.message);
        matches.push(...page.data.proposals.filter((proposal) => proposal.content_hash === options.inputHash).map((proposal) => proposal.id));
        cursor = page.data.next_cursor;
      } while (cursor);
      if (matches.length !== 1) return fail(matches.length === 0 ? "conflict" : "validation_error", matches.length === 0 ? "no proposal matches this input hash" : "input hash resolves to multiple proposals; use --proposal");
      proposalId = matches[0];
    }
    const response = await service.dispatch("review.pack", operator, { engagement_id: engagementId, proposal_id: proposalId });
    if (!response.ok) return fail(response.error.code, response.error.message);
    const pack = response.data as Record<string, unknown>;
    const markdown = renderPack(pack);
    if (options.exportPack) return { ok: true, mode, pack_markdown: markdown, submitted: false, review: pack };

    const external = readExternalResult(options.submitResult!);
    const bindings: Array<keyof Pick<ExternalReviewResult, "input_hash" | "evidence_snapshot_hash" | "policy_digest">> = ["input_hash", "evidence_snapshot_hash", "policy_digest"];
    for (const field of bindings) {
      const expected = field === "input_hash" ? pack.proposal_hash : pack[field];
      if (external[field] !== expected) return fail("stale_version", `external review ${field} does not match the fixed review pack`);
    }
    if (![external.input_hash, external.evidence_snapshot_hash, external.policy_digest].every(isDigest))
      return fail("validation_error", "review binding fields must be SHA-256 digests");
    const configured = configuredReviewer(env);
    if (!configured) return fail("authorization_error", "trusted host configuration must provide TARIC_REVIEWER_ID and TARIC_REVIEWER_ATTESTATION");
    if (external.reviewer_id !== configured.id) return fail("authorization_error", "external result reviewer id does not match the trusted host reviewer identity");

    // This CLI forwards a host/operator-prepared result. It does not call a model,
    // select a reviewer, prompt for a verdict, or create a verdict of its own.
    const reviewer: Principal = createPrincipal("reviewer", configured.id, engagementId, [], configured.attestation);
    const submitted = await service.dispatch("review.submit", reviewer, {
      engagement_id: engagementId,
      proposal_id: proposalId,
      reviewer_id: reviewer.id,
      reviewer_kind: "reviewer",
      input_hash: external.input_hash,
      evidence_snapshot_hash: external.evidence_snapshot_hash,
      policy_digest: external.policy_digest,
      verdict: external.verdict,
      ...(external.rubric_hash === undefined ? {} : { rubric_hash: external.rubric_hash }),
      ...(external.limitations === undefined ? {} : { limitations: external.limitations }),
    });
    if (!submitted.ok) return { ...fail(submitted.error.code, submitted.error.message), pack_markdown: markdown };
    const review = submitted.data as Record<string, unknown>;
    if (review.accepted !== true) return { ...fail("conflict", String(review.reason ?? "review was not accepted")), pack_markdown: markdown, review };
    return { ok: true, mode, pack_markdown: markdown, submitted: true, review };
  } finally {
    await service.close();
  }
}
