import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, rename, readFile, rm, symlink, lstat, readdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import type { AuthorityStore, CanonicalRecord } from "./store.js";

export interface ProjectionOptions {
  engagementId: string; outputDir: string; principalId?: string; canPushRemote?: boolean;
  remote?: { privateRepository: boolean; accessControl: boolean; retentionPolicy: boolean; secretScan: boolean; secretScanCallback?: () => Promise<boolean> | boolean };
  localGit?: boolean;
}
export interface ProjectionManifest { generation: string; engagement_id: string; authority_sequence: number; projected_watermark: number; schema_version: string; policy_version: string; files: Record<string, string>; created_at: string; }
export interface ProjectionResult {
  generation: string; files: string[]; manifest: ProjectionManifest; remotePushAllowed: false;
  localGit: { status: "committed" | "pending" | "disabled"; commit?: string; reason?: string };
  /** 本次发布仍被读者固定的旧 generation。删除时必须跳过这些目录。 */
  pinned_generations: string[];
}
const briefFields = new Set(["id", "display_id", "kind", "engagement_id", "trust_level", "version", "status", "title", "name", "proposition", "statement", "limitations", "scope", "updated_at", "evidence_refs", "resource_ref", "test_category", "coverage_status", "conditions", "operation", "identity_ref", "origin_reached", "origin_outcome", "decision_layer", "decision", "control_ref", "goal", "goals", "acceptance", "acceptance_criteria", "risk_budget", "next_steps", "completed_steps", "pending_steps", "work_item_ref", "blockers", "handoff_ref", "scope_ref"]);
const indexKinds = new Set(["resource", "coverage", "control_observation", "access_decision_observation", "finding", "claim"]);
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function sanitize(record: CanonicalRecord, fields: Set<string>): CanonicalRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => fields.has(key))) as CanonicalRecord;
}
function render(title: string, records: CanonicalRecord[]): string {
  const lines = [`# ${title}`, "", `Generated records: ${records.length}`, ""];
  for (const record of records) lines.push(`## ${String(record.display_id ?? record.id)}`, "", "```json", JSON.stringify(record, null, 2), "```", "");
  return lines.join("\n");
}
async function gitCheckpoint(generationDir: string, outputDir: string, manifest: ProjectionManifest, enabled: boolean): Promise<ProjectionResult["localGit"]> {
  if (!enabled) return { status: "disabled" };
  try {
    const { execFile } = await import("node:child_process");
    const run = (args: string[]) => new Promise<string>((resolvePromise, reject) => execFile("git", args, { cwd: outputDir }, (error, stdout) => error ? reject(error) : resolvePromise(stdout.trim())));
    await run(["rev-parse", "--is-inside-work-tree"]);
    await run(["add", basename(generationDir), "current"]);
    const commit = await run(["commit", "-m", `taric projection ${manifest.generation}`]);
    return { status: "committed", commit };
  } catch (error) {
    return { status: "pending", reason: error instanceof Error ? error.message : "local git checkpoint failed" };
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
  const snapshot = store.snapshot(options.engagementId, { includeCandidates: false });
  // A publication is immutable even if the authority has not advanced. This
  // keeps readers pinned to an old directory safe during republishing.
  const generation = `generation-${snapshot.read_seq}-${randomBytes(8).toString("hex")}`;
  const generationDir = join(options.outputDir, generation); const staging = join(options.outputDir, `.staging-${generation}`); const current = join(options.outputDir, "current"); const pointer = join(options.outputDir, "current.json");
  await mkdir(options.outputDir, { recursive: true }); await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
  const ordinary = snapshot.records.filter((record) => record.trust_level === "L2");
  const briefRecords = ordinary.map((record) => sanitize(record, briefFields));
  const indexRecords = ordinary.filter((record) => indexKinds.has(String(record.kind))).map((record) => sanitize(record, briefFields));
  const files: Record<string, string> = {};
  const brief = render("Engagement Brief", briefRecords); const index = render("Attack Surface Index", indexRecords);
  await writeFile(join(staging, "STATE.md"), brief, "utf8"); files["STATE.md"] = digest(brief);
  await writeFile(join(staging, "index.md"), index, "utf8"); files["index.md"] = digest(index);
  const manifest: ProjectionManifest = { generation, engagement_id: options.engagementId, authority_sequence: snapshot.read_seq, projected_watermark: snapshot.read_seq, schema_version: "1.0.0", policy_version: "projection-policy/1", files, created_at: new Date().toISOString() };
  const manifestText = JSON.stringify(manifest, null, 2); await writeFile(join(staging, "manifest.json"), manifestText, "utf8");
  // 旧 generation 由读者固定（pinned），发布不得删除；先整体落盘再切换 current 指针。
  await rename(staging, generationDir);
  const pointerText = JSON.stringify({ generation }, null, 2); const pointerStaging = `${pointer}.staging`;
  await writeFile(pointerStaging, pointerText, "utf8"); await rename(pointerStaging, pointer);
  const pointerTarget = join(options.outputDir, ".current-link"); await rm(pointerTarget, { recursive: true, force: true }); await symlink(generation, pointerTarget, "dir"); await rename(pointerTarget, current);
  const localGit = await gitCheckpoint(generationDir, options.outputDir, manifest, options.localGit ?? true);
  // 发布只追加新 generation。reader 固定的旧 generation 不再被删除，保证读侧永远看到完整的一代。
  const pinnedGenerations = await readPins(options.outputDir);
  // 本期不把布尔配置视为远端扫描或推送成功；远端 capability 固定 unsupported。
  return { generation, files: [join(current, "STATE.md"), join(current, "index.md")], manifest, remotePushAllowed: false, localGit, pinned_generations: pinnedGenerations };
}

export interface ProjectionReadRequest { principalId: string; engagementId: string; outputDir: string; generation: string; file: "STATE.md" | "index.md" | "manifest.json"; }
export type ProjectionPermissionResolver = (principalId: string, engagementId: string, generation: string) => boolean | Promise<boolean>;
/** 固定一个 generation，防止发布时回收读者正在读取的目录。 */
export async function pinProjection(request: ProjectionReadRequest, authorize: ProjectionPermissionResolver): Promise<void> {
  if (!request.principalId || !request.engagementId || typeof authorize !== "function" || !await authorize(request.principalId, request.engagementId, request.generation)) throw new Error("projection permission denied");
  if (!/^generation-[0-9]+-[a-f0-9]{16}$/.test(request.generation)) throw new Error("invalid projection generation");
  const manifest = JSON.parse(await readFile(join(resolve(request.outputDir), request.generation, "manifest.json"), "utf8")) as ProjectionManifest;
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
  const manifest = JSON.parse(await readFile(join(generationDir, "manifest.json"), "utf8")) as ProjectionManifest;
  if (manifest.engagement_id !== request.engagementId || manifest.generation !== request.generation) throw new Error("projection permission denied");
  const fileStat = await lstat(target); if (!fileStat.isFile()) throw new Error("projection path denied");
  const contents = await readFile(target, "utf8");
  if (request.file !== "manifest.json" && manifest.files[request.file] !== digest(contents)) throw new Error("projection generation integrity check failed");
  return contents;
}
