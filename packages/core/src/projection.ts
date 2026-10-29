import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, rename, readFile, rm, symlink, lstat, readdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import type { AuthorityStore, CanonicalRecord } from "./store.js";

export interface ProjectionOptions {
  engagementId: string; outputDir: string; principalId?: string;
  remote?: {
    repository: string;
    privateRepository: boolean;
    accessControl: boolean;
    retentionPolicy: string;
    authorizeRemotePush: (engagementId: string) => Promise<boolean> | boolean;
    secretScanCallback?: (input: SecretScanInput) => Promise<SecretScanCallbackResult | boolean> | SecretScanCallbackResult | boolean;
    /** This callback performs the remote push; repository access credentials stay in host configuration, not authority state or projections. */
    pushCallback?: (input: RemotePushInput) => Promise<RemotePushCallbackResult | boolean> | RemotePushCallbackResult | boolean;
  };
  localGit?: boolean;
}
export interface SecretScanInput { generation: string; generationDir: string; engagementId: string; manifest: ProjectionManifest; }
export interface SecretScanEvidence { passed: boolean; scanner_tool_version: string; result_hash: string; }
export type SecretScanCallbackResult = Partial<SecretScanEvidence> & {
  ok?: boolean;
  scanner?: { tool_version?: string; result_hash?: string; passed?: boolean };
};
export interface RemotePushInput {
  generation: string;
  generationDir: string;
  engagementId: string;
  repository: string;
  retention_policy: string;
  idempotency_key: string;
  manifest: ProjectionManifest;
  scan: SecretScanEvidence;
}
export type RemotePushCallbackResult = { pushed?: boolean; ok?: boolean; reason?: string };
export interface ProjectionManifest {
  generation: string;
  engagement_id: string;
  authority_sequence: number;
  projected_watermark: number;
  schema_version: string;
  policy_version: string;
  policy_digest: string;
  files: Record<string, string>;
  entity_ids: string[];
  created_at: string;
  /** Hash of the manifest payload excluding this field, so readers can verify it. */
  manifest_hash: string;
}
export interface ProjectionCheckpoint {
  status: "committed" | "pending" | "disabled";
  commit?: string;
  reason?: string;
  retryable?: boolean;
  authority_sequence?: number;
  manifest_hash?: string;
}
export interface RemoteProjectionStatus {
  status: "not_requested" | "blocked" | "pending" | "pushed";
  reason?: string;
  retryable: boolean;
  scan?: SecretScanEvidence;
  configuration?: { repository_hash: string; private_repository: boolean; access_control: boolean; retention_policy: string };
}
export interface ProjectionCheckpointState {
  generation: string;
  engagement_id: string;
  authority_sequence: number;
  manifest_hash: string;
  local_git: ProjectionCheckpoint;
  remote: RemoteProjectionStatus;
}
export interface ProjectionResult {
  generation: string; files: string[]; manifest: ProjectionManifest; remotePushAllowed: boolean;
  localGit: ProjectionCheckpoint;
  remote: RemoteProjectionStatus;
  /** 本次发布仍被读者固定的旧 generation。删除时必须跳过这些目录。 */
  pinned_generations: string[];
}
const briefFields = new Set(["id", "display_id", "kind", "engagement_id", "trust_level", "version", "status", "title", "name", "proposition", "statement", "limitations", "scope", "updated_at", "evidence_refs", "resource_ref", "test_category", "coverage_status", "conditions", "operation", "identity_ref", "origin_reached", "origin_outcome", "decision_layer", "decision", "control_ref", "goal", "goals", "acceptance", "acceptance_criteria", "risk_budget", "next_steps", "completed_steps", "pending_steps", "work_item_ref", "blockers", "handoff_ref", "scope_ref"]);
const indexKinds = new Set(["resource", "coverage", "control_observation", "access_decision_observation", "finding", "claim"]);
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function manifestDigest(manifest: Omit<ProjectionManifest, "manifest_hash">): string {
  return digest(JSON.stringify(manifest));
}
function withManifestHash(manifest: Omit<ProjectionManifest, "manifest_hash">): ProjectionManifest {
  return { ...manifest, manifest_hash: manifestDigest(manifest) };
}
function normalizeScanResult(value: SecretScanCallbackResult | boolean): SecretScanEvidence | undefined {
  if (typeof value === "boolean") return undefined;
  const scanner = value.scanner ?? {};
  const passed = value.passed ?? scanner.passed ?? value.ok;
  const scanner_tool_version = value.scanner_tool_version ?? scanner.tool_version;
  const result_hash = value.result_hash ?? scanner.result_hash;
  if (typeof passed !== "boolean" || typeof scanner_tool_version !== "string" || scanner_tool_version.length === 0 || typeof result_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(result_hash)) return undefined;
  return { passed, scanner_tool_version, result_hash };
}
function normalizePushResult(value: RemotePushCallbackResult | boolean): boolean {
  return value === true || (typeof value === "object" && (value.ok === true || value.pushed === true));
}
async function persistCheckpointState(outputDir: string, state: ProjectionCheckpointState): Promise<void> {
  const checkpointsDir = join(outputDir, "checkpoints");
  await mkdir(checkpointsDir, { recursive: true });
  const target = join(checkpointsDir, `${state.generation}.json`);
  const temporary = `${target}.staging`;
  await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
  await rename(temporary, target);
}
async function readVerifiedManifest(generationDir: string, expectedGeneration?: string): Promise<ProjectionManifest> {
  const manifest = JSON.parse(await readFile(join(generationDir, "manifest.json"), "utf8")) as ProjectionManifest;
  if (expectedGeneration && manifest.generation !== expectedGeneration) throw new Error("projection checkpoint binding mismatch");
  const payload = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifest_hash")) as Omit<ProjectionManifest, "manifest_hash">;
  if (manifest.manifest_hash !== manifestDigest(payload)) throw new Error("projection manifest integrity check failed");
  for (const [file, expectedHash] of Object.entries(manifest.files)) {
    if (!["STATE.md", "index.md"].includes(file)) throw new Error("projection manifest contains an unsupported file");
    if (digest(await readFile(join(generationDir, file), "utf8")) !== expectedHash) throw new Error(`projection generation integrity check failed: ${file}`);
  }
  return manifest;
}
/** Retry local commit or remote push for a previously published immutable generation. */
export async function retryProjectionCheckpoint(options: {
  outputDir: string;
  generation: string;
  localGit?: boolean;
  remote?: ProjectionOptions["remote"];
}): Promise<ProjectionCheckpointState> {
  if (!/^generation-[0-9]+-[a-f0-9]{16}$/.test(options.generation)) throw new Error("invalid projection generation");
  const outputDir = resolve(options.outputDir);
  const generationDir = resolve(outputDir, options.generation);
  if (!generationDir.startsWith(`${outputDir}/`)) throw new Error("projection path denied");
  const manifest = await readVerifiedManifest(generationDir, options.generation);
  const checkpointPath = join(outputDir, "checkpoints", `${options.generation}.json`);
  let previous: ProjectionCheckpointState;
  try { previous = JSON.parse(await readFile(checkpointPath, "utf8")) as ProjectionCheckpointState; }
  catch { throw new Error("projection checkpoint state unavailable"); }
  if (previous.manifest_hash !== manifest.manifest_hash || previous.authority_sequence !== manifest.authority_sequence || previous.engagement_id !== manifest.engagement_id) throw new Error("projection checkpoint state binding mismatch");
  if (options.remote && previous.remote.configuration) {
    const repositoryHash = options.remote.repository ? digest(options.remote.repository) : digest("");
    if (previous.remote.configuration.repository_hash !== repositoryHash || previous.remote.configuration.retention_policy !== options.remote.retentionPolicy || previous.remote.configuration.private_repository !== options.remote.privateRepository || previous.remote.configuration.access_control !== options.remote.accessControl) throw new Error("projection retry remote policy mismatch");
  }

  let state: ProjectionCheckpointState = {
    generation: manifest.generation,
    engagement_id: manifest.engagement_id,
    authority_sequence: manifest.authority_sequence,
    manifest_hash: manifest.manifest_hash,
    local_git: previous.local_git,
    remote: previous.remote,
  };
  if (options.localGit === true) {
    if (previous.local_git.status !== "pending") throw new Error("local Git projection checkpoint is not pending");
    state.local_git = await gitCheckpoint(generationDir, outputDir, manifest, true);
  }
  if (options.remote) {
    if (!previous.remote.retryable || !["pending", "blocked"].includes(previous.remote.status)) throw new Error("remote projection checkpoint is not retryable");
    state.remote = await runRemotePush(options.remote, manifest, generationDir);
  }
  await persistCheckpointState(outputDir, state);
  return state;
}
function sanitize(record: CanonicalRecord, fields: Set<string>): CanonicalRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => fields.has(key))) as CanonicalRecord;
}
async function runRemotePush(remote: NonNullable<ProjectionOptions["remote"]>, manifest: ProjectionManifest, generationDir: string): Promise<RemoteProjectionStatus> {
  const configuration = {
    repository_hash: remote.repository ? digest(remote.repository) : digest(""),
    private_repository: remote.privateRepository === true,
    access_control: remote.accessControl === true,
    retention_policy: remote.retentionPolicy ?? "",
  };
  if (!remote.repository || remote.privateRepository !== true || remote.accessControl !== true || !remote.retentionPolicy.trim() || typeof remote.authorizeRemotePush !== "function" || typeof remote.secretScanCallback !== "function" || typeof remote.pushCallback !== "function") {
    return { status: "blocked", retryable: true, configuration, reason: "remote push requires a private repository, access control, retention policy, real scan callback, and push callback" };
  }
  let authorized = false;
  try { authorized = await remote.authorizeRemotePush(manifest.engagement_id); }
  catch (error) { return { status: "blocked", retryable: true, configuration, reason: error instanceof Error ? error.message : "Engagement remote-push authorization failed" }; }
  if (!authorized) return { status: "blocked", retryable: true, configuration, reason: "Engagement has not explicitly authorized remote push" };
  let scan: SecretScanEvidence | undefined;
  try {
    scan = normalizeScanResult(await remote.secretScanCallback({ generation: manifest.generation, generationDir, engagementId: manifest.engagement_id, manifest }));
  } catch (error) {
    return { status: "pending", retryable: true, configuration, reason: error instanceof Error ? error.message : "secrets scan failed" };
  }
  if (!scan || !scan.passed) return { status: "pending", retryable: true, configuration, scan, reason: scan ? "secrets scan reported findings" : "secrets scan did not return pass status, scanner tool version, and result hash" };
  try {
    const pushed = normalizePushResult(await remote.pushCallback({
      generation: manifest.generation,
      generationDir,
      engagementId: manifest.engagement_id,
      repository: remote.repository,
      retention_policy: remote.retentionPolicy,
      idempotency_key: `${manifest.generation}:${manifest.manifest_hash}`,
      manifest,
      scan,
    }));
    return pushed ? { status: "pushed", retryable: false, scan, configuration } : { status: "pending", retryable: true, scan, configuration, reason: "remote push callback did not confirm a push" };
  } catch (error) {
    return { status: "pending", retryable: true, scan, configuration, reason: error instanceof Error ? error.message : "remote push failed" };
  }
}
function writeCheckpointState(outputDir: string, manifest: ProjectionManifest, localGit: ProjectionCheckpoint, remote: RemoteProjectionStatus): Promise<void> {
  return persistCheckpointState(outputDir, {
    generation: manifest.generation,
    engagement_id: manifest.engagement_id,
    authority_sequence: manifest.authority_sequence,
    manifest_hash: manifest.manifest_hash,
    local_git: localGit,
    remote,
  });
}
function render(title: string, records: CanonicalRecord[]): string {
  const lines = [`# ${title}`, "", `Generated records: ${records.length}`, ""];
  for (const record of records) lines.push(`## ${String(record.display_id ?? record.id)}`, "", "```json", JSON.stringify(record, null, 2), "```", "");
  return lines.join("\n");
}
async function gitCheckpoint(generationDir: string, outputDir: string, manifest: ProjectionManifest, enabled: boolean): Promise<ProjectionCheckpoint> {
  const base = { authority_sequence: manifest.authority_sequence, manifest_hash: manifest.manifest_hash };
  if (!enabled) return { status: "disabled", ...base };
  try {
    const { execFile } = await import("node:child_process");
    const run = (args: string[]) => new Promise<string>((resolvePromise, reject) => execFile("git", args, { cwd: outputDir }, (error, stdout) => error ? reject(error) : resolvePromise(stdout.trim())));
    await run(["rev-parse", "--is-inside-work-tree"]);
    await run(["add", "--", basename(generationDir), "current"]);
    const commit = await run(["commit", "--only", "--allow-empty", "-m", `taric projection ${manifest.generation}`, "-m", `authority-sequence=${manifest.authority_sequence}`, "-m", `manifest-hash=${manifest.manifest_hash}`, "--", basename(generationDir), "current"]);
    return { status: "committed", commit, ...base };
  } catch (error) {
    return { status: "pending", retryable: true, reason: error instanceof Error ? error.message : "local git checkpoint failed", ...base };
  }
}
/** 读取 outputDir 下的 reader pin 文件，返回正在被固定的 generation。 */
async function readPins(outputDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(outputDir, "pins"), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /^generation-[0-9]+-[a-f0-9]{16}$/.test(entry.name)).map((entry) => entry.name);
  } catch { return []; }
}
export async function publishProjection(store: AuthorityStore, options: ProjectionOptions): Promise<ProjectionResult> {
  const snapshot = await store.snapshot(options.engagementId, { includeCandidates: false });
  // A publication is immutable even if the authority has not advanced. This
  // keeps readers pinned to an old directory safe during republishing.
  const generation = `generation-${snapshot.read_seq}-${randomBytes(8).toString("hex")}`;
  const generationDir = join(options.outputDir, generation); const staging = join(options.outputDir, `.staging-${generation}`); const current = join(options.outputDir, "current");
  await mkdir(options.outputDir, { recursive: true }); await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
  const ordinary = snapshot.records.filter((record) => record.trust_level === "L2");
  const briefRecords = ordinary.map((record) => sanitize(record, briefFields));
  const indexRecords = ordinary.filter((record) => indexKinds.has(String(record.kind))).map((record) => sanitize(record, briefFields));
  const files: Record<string, string> = {};
  const brief = render("Engagement Brief", briefRecords); const index = render("Attack Surface Index", indexRecords);
  await writeFile(join(staging, "STATE.md"), brief, "utf8"); files["STATE.md"] = digest(brief);
  await writeFile(join(staging, "index.md"), index, "utf8"); files["index.md"] = digest(index);
  const manifestWithoutHash: Omit<ProjectionManifest, "manifest_hash"> = {
    generation,
    engagement_id: options.engagementId,
    authority_sequence: snapshot.read_seq,
    projected_watermark: snapshot.read_seq,
    schema_version: "1.0.0",
    policy_version: "projection-policy/1",
    policy_digest: digest("projection-policy/1"),
    files,
    entity_ids: ordinary.map((record) => record.id),
    created_at: new Date().toISOString(),
  } as Omit<ProjectionManifest, "manifest_hash">;
  let manifest = withManifestHash(manifestWithoutHash);
  await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  // 旧 generation 由读者固定（pinned），发布不得删除；先整体落盘再切换 current 指针。
  await rename(staging, generationDir);
  // `current` is the authoritative pointer. Renaming a prepared symlink over
  // the previous symlink keeps readers on a complete old or complete new tree.
  const pointerTarget = join(options.outputDir, `.current-link-${generation}`);
  await symlink(generation, pointerTarget, "dir");
  await rename(pointerTarget, current);

  await writeCheckpointState(
    options.outputDir,
    manifest,
    { status: options.localGit === false ? "disabled" : "pending", retryable: options.localGit !== false, reason: options.localGit === false ? undefined : "local Git checkpoint pending", authority_sequence: manifest.authority_sequence, manifest_hash: manifest.manifest_hash },
    options.remote ? { status: "pending", retryable: true, reason: "remote checkpoint pending" } : { status: "not_requested", retryable: false },
  );
  let remote: RemoteProjectionStatus = { status: "not_requested", retryable: false };
  if (options.remote) {
    remote = await runRemotePush(options.remote, manifest, generationDir);
  }
  const localGit = await gitCheckpoint(generationDir, options.outputDir, manifest, options.localGit ?? true);
  await writeCheckpointState(options.outputDir, manifest, localGit, remote);
  // 发布只追加新 generation。reader 固定的旧 generation 不再被删除，保证读侧永远看到完整的一代。
  const pinnedGenerations = await readPins(options.outputDir);
  return { generation, files: [join(current, "STATE.md"), join(current, "index.md")], manifest, remotePushAllowed: remote.status === "pushed", localGit, remote, pinned_generations: pinnedGenerations };
}

export interface ProjectionReadRequest { principalId: string; engagementId: string; outputDir: string; generation: string; file: "STATE.md" | "index.md" | "manifest.json"; }
export type ProjectionPermissionResolver = (principalId: string, engagementId: string, generation: string) => boolean | Promise<boolean>;
/** 固定一个 generation，防止发布时回收读者正在读取的目录。 */
export async function pinProjection(request: ProjectionReadRequest, authorize: ProjectionPermissionResolver): Promise<void> {
  if (!request.principalId || !request.engagementId || typeof authorize !== "function" || !await authorize(request.principalId, request.engagementId, request.generation)) throw new Error("projection permission denied");
  if (!/^generation-[0-9]+-[a-f0-9]{16}$/.test(request.generation)) throw new Error("invalid projection generation");
  const generationDir = resolve(request.outputDir, request.generation);
  const manifest = await readVerifiedManifest(generationDir, request.generation);
  if (manifest.engagement_id !== request.engagementId || manifest.generation !== request.generation) throw new Error("projection permission denied");
  await mkdir(join(request.outputDir, "pins"), { recursive: true });
  await writeFile(join(request.outputDir, "pins", request.generation), request.principalId, "utf8");
}
/** 释放 reader pin。调用者负责在读完之后调用。 */
export async function unpinProjection(outputDir: string, generation: string): Promise<void> {
  if (!/^generation-[0-9]+-[a-f0-9]{16}$/.test(generation)) throw new Error("invalid projection generation");
  await rm(join(resolve(outputDir), "pins", generation), { force: true });
}
export async function readProjection(request: ProjectionReadRequest, authorize: ProjectionPermissionResolver): Promise<string> {
  if (!request.principalId || !request.engagementId || typeof authorize !== "function" || !await authorize(request.principalId, request.engagementId, request.generation)) throw new Error("projection permission denied");
  if (!["STATE.md", "index.md", "manifest.json"].includes(request.file)) throw new Error("projection path denied");
  if (!/^generation-[0-9]+-[a-f0-9]{16}$/.test(request.generation)) throw new Error("invalid projection generation");
  const root = resolve(request.outputDir); const generationDir = resolve(root, request.generation); const target = resolve(generationDir, request.file);
  if (generationDir !== resolve(root, request.generation) || !target.startsWith(`${generationDir}/`) || basename(target) !== request.file) throw new Error("projection path denied");
  const stat = await lstat(generationDir); if (!stat.isDirectory()) throw new Error("projection generation unavailable");
  const manifest = await readVerifiedManifest(generationDir, request.generation);
  if (manifest.engagement_id !== request.engagementId || manifest.generation !== request.generation) throw new Error("projection permission denied");
  const fileStat = await lstat(target); if (!fileStat.isFile()) throw new Error("projection path denied");
  const contents = await readFile(target, "utf8");
  if (request.file !== "manifest.json" && manifest.files[request.file] !== digest(contents)) throw new Error("projection generation integrity check failed");
  return contents;
}
