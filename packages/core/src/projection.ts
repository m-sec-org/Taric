import { mkdir, writeFile, rename, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AuthorityStore, CanonicalRecord } from "./store.js";

export interface ProjectionOptions { engagementId: string; outputDir: string; canPushRemote?: boolean; remote?: { privateRepository: boolean; accessControl: boolean; retentionPolicy: boolean; secretScan: boolean }; }
export interface ProjectionResult { generation: string; files: string[]; remotePushAllowed: boolean; }
const allowed = new Set(["id", "display_id", "kind", "engagement_id", "trust_level", "version", "status", "title", "name", "proposition", "statement", "limitations", "scope", "updated_at", "evidence_refs", "artifact_refs", "resource_ref", "test_category", "coverage_status"]);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key)).map(([key, val]) => [key, sanitize(val)]));
}
function render(title: string, records: CanonicalRecord[]): string {
  const lines = [`# ${title}`, "", `Generated records: ${records.length}`, ""];
  for (const record of records) lines.push(`## ${String(record.display_id ?? record.id)}`, "", "```json", JSON.stringify(sanitize(record), null, 2), "```", "");
  return lines.join("\n");
}
export async function publishProjection(store: AuthorityStore, options: ProjectionOptions): Promise<ProjectionResult> {
  const snapshot = store.snapshot(options.engagementId, { includeCandidates: true });
  const generation = `generation-${snapshot.read_seq}`;
  const staging = join(options.outputDir, `.staging-${generation}`); const current = join(options.outputDir, "current");
  await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "STATE.md"), render("Engagement Brief", snapshot.records), "utf8");
  await writeFile(join(staging, "index.md"), render("Attack Surface Index", snapshot.records), "utf8");
  await rm(current, { recursive: true, force: true }); await rename(staging, current);
  const remotePushAllowed = Boolean(options.canPushRemote && options.remote?.privateRepository && options.remote.accessControl && options.remote.retentionPolicy && options.remote.secretScan);
  return { generation, files: [join(current, "STATE.md"), join(current, "index.md")], remotePushAllowed };
}

export async function readProjection(path: string, canRead: boolean): Promise<string> {
  if (!canRead) throw new Error("projection permission denied");
  return readFile(path, "utf8");
}
