import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { uuidv7 } from "./identity.js";
import { ContractValidationError } from "./validation.js";

export const ARTIFACT_CHUNK_BYTES = 64 * 1024 * 1024;
const ARTIFACT_BASE64_CHARS = Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4;
const ARTIFACT_METADATA_MAX_BYTES = 16 * 1024;
export const ARTIFACT_DEPLOYMENT_PROFILE = Object.freeze({
  version: "artifact-deployment/1",
  id: "local_process_crash",
  decoded_chunk_bytes: ARTIFACT_CHUNK_BYTES,
  base64_transport_chars: ARTIFACT_BASE64_CHARS,
  json_metadata_max_bytes: ARTIFACT_METADATA_MAX_BYTES,
  transport_envelope_max_bytes: ARTIFACT_BASE64_CHARS + ARTIFACT_METADATA_MAX_BYTES,
  response_envelope_max_bytes: ARTIFACT_BASE64_CHARS + ARTIFACT_METADATA_MAX_BYTES,
  binary_transport_header_max_bytes: ARTIFACT_METADATA_MAX_BYTES,
  binary_transport_envelope_max_bytes: ARTIFACT_CHUNK_BYTES + ARTIFACT_METADATA_MAX_BYTES + 4,
  json_rpc_line_max_bytes: 1024 * 1024,
  json_rpc_artifact_read_max_decoded_bytes: 512 * 1024,
  json_rpc_artifact_page_items_max: 16,
  json_rpc_page_content_max_decoded_bytes: 128 * 1024,
  receive_chunk_bytes: 64 * 1024,
  receive_queue_chunks: 2,
  receive_queue_bytes_max: 128 * 1024,
  active_uploads_max: 2,
  page_items_max: 1000,
  metadata_page_bytes_max: 1024 * 1024,
  publication: "staging_copy_atomic_rename_catalog_transaction",
  recovery: "verified_publication_markers",
  fsync: "none",
  power_loss_durable: false,
} as const);
export type ArtifactFaultPoint = "before_manifest" | "before_rename" | "after_rename" | "after_publication_marker" | "before_catalog_commit" | "after_catalog_commit";
export interface ArtifactContentOptions {
  /** Test-only process-crash injection; never accepted from an API request. */
  fault?: (point: ArtifactFaultPoint) => void;
  measure?: (point: "decode" | "append" | "copy" | "publish") => void;
}
const MAX_PAGE_SIZE = 1000;
const SHA = /^sha256:[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_BASE64_CHARS = Math.ceil(ARTIFACT_CHUNK_BYTES / 3) * 4;

export type ArtifactPayloadKind = "text" | "binary" | "manifest";
export type ArtifactContentStatus = "external" | "pending" | "available" | "unavailable" | "integrity_failed" | "quarantined";
export interface ArtifactStoreError extends Error { code: "validation_error" | "authorization_error" | "conflict" | "stale_version" | "unavailable_host" | "idempotency_conflict"; }
export type ArtifactSessionMode = "host-session" | "run-bound";
export interface ArtifactBinding {
  engagement_id: string;
  session_id: string;
  root: string;
  binding_id: string;
  created_at: string;
  mode: ArtifactSessionMode;
  work_run_id?: string;
  attempt_id?: string;
  generation?: number;
  owner_host?: string;
}
export interface ArtifactBeginInput { engagement_id: string; session_id: string; payload_kind: ArtifactPayloadKind; media_type: string; storage_mode?: "external" | "taric_stored"; charset?: string; content_encoding?: string; transfer_encoding?: string; captured_at?: string; summary_ref?: string; summary?: string; expected_bytes?: number; expected_hash?: string; category?: string; host_ref?: string; work_run_id?: string; attempt_id?: string; generation?: number; base_content_ref?: string; parent_ref?: string; derived_from?: string; child_refs?: string[]; idempotency_key?: string; }
export interface ArtifactAppendInput { engagement_id: string; session_id: string; upload_id: string; ordinal: number; data: string; encoding?: "base64"; chunk_hash: string; idempotency_key?: string; }
export interface ArtifactBinaryAppendInput { engagement_id: string; session_id: string; upload_id: string; ordinal: number; bytes: Uint8Array; chunk_hash: string; idempotency_key?: string; }
export interface ArtifactBinaryAppendStreamInput { engagement_id: string; session_id: string; upload_id: string; ordinal: number; byte_length: number; chunk_hash: string; idempotency_key?: string; }
export interface ArtifactCommitInput { engagement_id: string; session_id: string; upload_id: string; total_bytes: number; chunk_count?: number; content_hash: string; idempotency_key?: string; }
export interface ArtifactRow { content_ref: string; artifact_id: string; version: number; engagement_id: string; session_id: string; payload_kind: ArtifactPayloadKind; media_type: string; charset?: string; content_encoding?: string; transfer_encoding?: string; storage_mode?: "external" | "taric_stored"; category?: string; summary_ref?: string; captured_at?: string; host_ref?: string; byte_length: number; chunk_count: number; content_hash?: string; manifest_hash?: string; content_status: ArtifactContentStatus; integrity_status: "unverified" | "verified" | "mismatch" | "missing"; stored_at: string; work_run_id?: string; attempt_id?: string; generation?: number; parent_ref?: string; child_refs?: string[]; relative_dir: string; manifest_path: string; }
interface Upload { upload_id: string; artifact_id: string; version: number; binding: ArtifactBinding; principal: string; input: ArtifactBeginInput; staging_dir: string; chunks: Array<{ ordinal: number; bytes: number; hash: string; path: string }>; total_bytes: number; }
interface ArtifactScope { engagement_id?: string; session_id?: string; }
interface ArtifactCatalogAuthority {
  artifactMutation<T>(operation: () => Promise<T>): Promise<T>;
  artifactSessions(scope?: ArtifactScope): Promise<ArtifactBinding[]>; saveArtifactSession(binding: ArtifactBinding): Promise<void>;
  artifactCatalogRows(scope?: ArtifactScope): Promise<Array<Record<string, unknown>>>; saveArtifactCatalogRow(row: ArtifactRow, chunks: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }>, uploadId?: string, idempotency?: { key: string; principal: string; request_hash: string; result: unknown }, principal?: string): Promise<void>;
  artifactCatalogRow?(engagementId: string, sessionId: string, contentRef: string): Promise<Record<string, unknown> | undefined>;
  artifactCatalogWatermark?(engagementId: string, sessionId: string): Promise<{ catalog_watermark: number; index_watermark: number; index_status: string }>;
  queryArtifactCatalog?(input: { engagement_id: string; session_id: string; category?: string; media_type?: string; work_run_id?: string; after?: { stored_at: string; content_ref: string }; limit: number }): Promise<{ items: Array<Record<string, unknown>>; has_more: boolean; watermark: { catalog_watermark: number; index_watermark: number; index_status: string } }>;
  explainArtifactCatalog?(input: { engagement_id: string; session_id: string; category?: string; media_type?: string; work_run_id?: string }): Promise<string[]>;
  artifactPublications?(scope?: ArtifactScope): Promise<Array<{ upload_id: string; engagement_id: string; session_id: string; content_ref: string; phase: string; body: Record<string, unknown> }>>;
  startArtifactPublication?(uploadId: string, engagementId: string, sessionId: string, contentRef: string, publishPath: string): Promise<void>;
  prepareArtifactPublication?(uploadId: string, row: ArtifactRow, chunks: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }>, publishPath: string, idempotency?: { key: string; principal: string; request_hash: string; result: unknown }): Promise<void>;
  markArtifactPublication?(uploadId: string, phase: "publishing" | "published" | "quarantined"): Promise<void>;
  failArtifactPublication?(uploadId: string, reason: string): Promise<void>;
  completeArtifactPublication?(uploadId: string, row: ArtifactRow, chunks: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }>, idempotency?: { key: string; principal: string; request_hash: string; result: unknown }): Promise<void>;
  updateArtifactCatalogRow?(row: ArtifactRow, eventType: string): Promise<void>;
  artifactUploads(scope?: ArtifactScope): Promise<Array<{ upload_id: string; engagement_id: string; session_id: string; body: Record<string, unknown> }>>;
  saveArtifactUpload(uploadId: string, engagementId: string, sessionId: string, body: Record<string, unknown>): Promise<void>; deleteArtifactUpload(uploadId: string): Promise<void>;
  recordArtifactEvent(eventType: string, engagementId: string, subjectId: string, metadata: Record<string, unknown>): Promise<void>;
  artifactIdempotencyResult(key: string, operation: string, principal: string, engagementId: string, requestHash: string): Promise<unknown | undefined>;
  saveArtifactIdempotency(key: string, operation: string, principal: string, engagementId: string, requestHash: string, result: unknown): Promise<void>;
  validateArtifactFence(input: { engagement_id: string; session_id: string; work_run_id: string; attempt_id: string; generation: number; principal: string }): Promise<void>;
  executionCatalogRows(input: { engagement_id: string; session_id: string; work_run_id?: string; attempt_id?: string }): Promise<Array<Record<string, unknown>>>;
  executionCatalogPage?(input: { engagement_id: string; session_id: string; work_run_id?: string; attempt_id?: string; cursor?: string; page_size: number }): Promise<{ items: Array<Record<string, unknown>>; next_cursor?: string; index_watermark: number }>;
}

function fail(code: ArtifactStoreError["code"], message: string): never { throw new ContractValidationError(code, message); }
function hashBytes(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function isCanonicalBase64(value: string): boolean {
  if (!BASE64.test(value) || value.length % 4 !== 0) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==")) return value.length > 0 && alphabet.indexOf(value[value.length - 3]!) % 16 === 0;
  if (value.endsWith("=")) return value.length > 0 && alphabet.indexOf(value[value.length - 2]!) % 4 === 0;
  return true;
}
function hashFile(path: string, aggregate?: ReturnType<typeof createHash>): string {
  const digest = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) { const bytes = buffer.subarray(0, bytesRead); digest.update(bytes); aggregate?.update(bytes); }
  } finally { closeSync(fd); }
  return `sha256:${digest.digest("hex")}`;
}
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)])); return value; }
function requestHash(value: unknown): string { return hashBytes(Buffer.from(JSON.stringify(canonical(value)))); }
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function checkHash(value: string, label: string): void { if (!SHA.test(value)) fail("validation_error", `${label} must be sha256`); }
function safeSegment(value: string, label: string): void { if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) fail("validation_error", `${label} must be an opaque segment`); }
function isWithin(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${sep}`); }
function canonicalWithin(root: string, candidate: string): string { const requested = resolve(candidate); if (!isWithin(root, requested)) fail("authorization_error", "path escaped the task session"); const resolved = realpathSync(requested); if (!isWithin(root, resolved)) fail("authorization_error", "path escaped the task session"); return resolved; }
function cursorEncode(value: Record<string, unknown>): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function cursorDecode(value: string): Record<string, unknown> { try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed as Record<string, unknown>; } catch { fail("validation_error", "invalid catalog cursor"); } }

export class ArtifactContentStore {
  readonly #configuredRoot: string;
  readonly #root: string;
  readonly #bindings = new Map<string, ArtifactBinding>();
  readonly #uploads = new Map<string, Upload>();
  readonly #rows = new Map<string, ArtifactRow>();
  readonly #idempotency = new Map<string, { operation: string; principal: string; engagement_id: string; request_hash: string; result: unknown }>();
  readonly #uploadOperations = new Map<string, { tail: Promise<void>; depth: number }>();
  readonly #authority?: ArtifactCatalogAuthority;
  readonly #options: ArtifactContentOptions;
  #initialization?: Promise<void>;
  constructor(root: string, authority?: unknown, options: ArtifactContentOptions = {}) {
    if (!isAbsolute(root)) fail("validation_error", "content root must be absolute");
    const resolvedRoot = resolve(root); this.#configuredRoot = resolvedRoot; mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 }); this.#root = realpathSync(resolvedRoot);
    this.#authority = authority as ArtifactCatalogAuthority | undefined;
    this.#options = options;
  }
  /** Hydrates only this process's spool; shared authority catalogs are refreshed for each request. */
  initialize(): Promise<void> {
    return this.#initialization ??= this.hydrate().catch((error: unknown) => { this.#initialization = undefined; throw error; });
  }
  private async hydrate(): Promise<void> {
    if (!this.#authority) {
      let state: { bindings?: ArtifactBinding[]; rows?: ArtifactRow[] } = {};
      try { state = JSON.parse(readFileSync(join(this.#root, ".catalog.json"), "utf8")) as typeof state; } catch { /* A new spool has no catalog. */ }
      for (const binding of state.bindings ?? []) if (this.localBinding(binding)) this.#bindings.set(this.bindingKey(binding.engagement_id, binding.session_id), binding);
      for (const row of state.rows ?? []) if (this.#bindings.has(this.bindingKey(row.engagement_id, row.session_id))) this.#rows.set(this.rowKey(row), row);
      return;
    }
    await this.refreshBindings();
    await this.refreshUploads();
    await this.recoverPublications();
  }
  /** Replays only publication markers whose complete manifest and catalog row are still verifiable. */
  private async recoverPublications(): Promise<void> {
    for (const marker of await this.#authority?.artifactPublications?.() ?? []) {
      const body = marker.body as { row?: ArtifactRow; chunks?: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }>; publish_path?: string; idempotency?: { key: string; principal: string; request_hash: string; result: unknown } };
      const row = body.row;
      if (!row || !["ready", "publishing", "published"].includes(marker.phase)) continue;
      const binding = this.#bindings.get(this.bindingKey(marker.engagement_id, marker.session_id));
      if (!binding || !this.localBinding(binding)) continue;
      try {
        const manifestPath = canonicalWithin(binding.root, join(binding.root, row.manifest_path));
        const manifestBytes = readFileSync(manifestPath);
        if (row.manifest_hash && hashBytes(manifestBytes) !== row.manifest_hash) continue;
        const manifest = JSON.parse(manifestBytes.toString("utf8")) as { chunks?: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }> };
        if (!Array.isArray(manifest.chunks) || manifest.chunks.length !== row.chunk_count) continue;
        if (this.checkArtifactFiles(binding, row, [], []).content_status !== "available") continue;
        const committed = await this.#authority?.artifactCatalogRow?.(row.engagement_id, row.session_id, row.content_ref);
        const alreadyCommitted = Boolean(row.content_hash && row.manifest_hash && committed?.content_hash === row.content_hash && committed.manifest_hash === row.manifest_hash);
        const upload = this.#uploads.get(marker.upload_id);
        if (!alreadyCommitted) {
          if (!upload) continue;
          await this.assertFence(upload.input, upload.principal);
        }
        if (this.#authority?.completeArtifactPublication) await this.#authority.completeArtifactPublication(marker.upload_id, row, body.chunks ?? manifest.chunks, body.idempotency);
        this.#rows.set(this.rowKey(row), row);
        this.#uploads.delete(marker.upload_id);
      } catch {
        // Leave the marker pending for operator reconciliation; no body is exposed.
      }
    }
  }
  deploymentProfile(): typeof ARTIFACT_DEPLOYMENT_PROFILE { return ARTIFACT_DEPLOYMENT_PROFILE; }
  async bind(input: { engagement_id: string; session_id: string; root: string; mode: ArtifactSessionMode; work_run_id?: string; attempt_id?: string; generation?: number; owner_host?: string }, principal = "unknown"): Promise<ArtifactBinding> {
    await this.initialize();
    // Binding overlap is a spool-wide invariant, so this write refreshes all local owners.
    await this.refreshBindings();
    safeSegment(input.engagement_id, "engagement_id"); safeSegment(input.session_id, "session_id");
    if (input.mode !== "host-session" && input.mode !== "run-bound") fail("validation_error", "session binding mode is required");
    if (input.mode === "run-bound") {
      if (!input.work_run_id || !input.attempt_id || !Number.isSafeInteger(input.generation) || input.generation! < 1 || !input.owner_host) fail("validation_error", "run-bound session requires WorkRun, Attempt, generation, and owner");
      if (input.owner_host !== principal) fail("authorization_error", "run-bound session owner must match the transport principal");
      if (!this.#authority) fail("stale_version", "run-bound session requires an authority fence");
    } else if (input.work_run_id !== undefined || input.attempt_id !== undefined || input.generation !== undefined || input.owner_host !== undefined) {
      fail("validation_error", "host-session binding cannot include run attribution");
    }
    const requested = resolve(input.root);
    if (requested !== this.#configuredRoot && !requested.startsWith(`${this.#configuredRoot}${sep}`)) fail("authorization_error", "session root is outside configured content root");
    mkdirSync(requested, { recursive: true, mode: 0o700 }); const canonicalRequested = realpathSync(requested);
    if (canonicalRequested !== this.#root && !canonicalRequested.startsWith(`${this.#root}${sep}`)) fail("authorization_error", "session root is outside configured content root");
    for (const bound of this.#bindings.values()) {
      if (bound.engagement_id === input.engagement_id && bound.session_id === input.session_id) continue;
      if (isWithin(bound.root, canonicalRequested) || isWithin(canonicalRequested, bound.root)) fail("conflict", "task session roots cannot overlap");
    }
    const existing = this.#bindings.get(this.bindingKey(input.engagement_id, input.session_id)); if (existing) { mkdirSync(requested, { recursive: true, mode: 0o700 }); if (realpathSync(existing.root) !== realpathSync(requested) || existing.mode !== input.mode || existing.work_run_id !== input.work_run_id || existing.attempt_id !== input.attempt_id || existing.generation !== input.generation || existing.owner_host !== input.owner_host) fail("conflict", "task session is already bound with different authority"); return existing; }
    const binding: ArtifactBinding = { engagement_id: input.engagement_id, session_id: input.session_id, root: canonicalRequested, binding_id: uuidv7(), created_at: new Date().toISOString(), mode: input.mode, ...(input.work_run_id ? { work_run_id: input.work_run_id } : {}), ...(input.attempt_id ? { attempt_id: input.attempt_id } : {}), ...(input.generation !== undefined ? { generation: input.generation } : {}), ...(input.owner_host ? { owner_host: input.owner_host } : {}) };
    await this.#authority?.saveArtifactSession(binding);
    writeFileSync(join(canonicalRequested, "manifest.json"), JSON.stringify({ schema_version: "1.0.0", engagement_id: binding.engagement_id, session_id: binding.session_id, segments: [], watermarks: { catalog: 0, manifest: 0 } }) + "\n", { mode: 0o600 });
    this.#bindings.set(this.bindingKey(input.engagement_id, input.session_id), binding);
    await this.#authority?.recordArtifactEvent("artifact.session.bound", input.engagement_id, binding.binding_id, { session_id: input.session_id, mode: input.mode, work_run_id: input.work_run_id, attempt_id: input.attempt_id, generation: input.generation });
    this.saveCatalog();
    return binding;
  }
  async begin(input: ArtifactBeginInput, principal = "unknown"): Promise<Record<string, unknown>> {
    await this.initialize();
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > ARTIFACT_DEPLOYMENT_PROFILE.json_metadata_max_bytes) fail("validation_error", "Artifact transport metadata exceeds its 16 KiB bound");
    return this.artifactMutation(() => this.beginUpload(input, principal));
  }
  private async beginUpload(input: ArtifactBeginInput, principal: string): Promise<Record<string, unknown>> {
    const binding = await this.requireBinding(input.engagement_id, input.session_id); if (!input.media_type || !["text", "binary", "manifest"].includes(input.payload_kind)) fail("validation_error", "payload_kind and media_type are required");
    const beginHash = requestHash(input); const prior = await this.idempotentResult(input.idempotency_key, "artifact.store.begin", principal, input.engagement_id, beginHash); if (prior) return prior as Record<string, unknown>;
    if (input.expected_bytes !== undefined && (!Number.isSafeInteger(input.expected_bytes) || input.expected_bytes < 0)) fail("validation_error", "expected_bytes must be a nonnegative integer"); if (input.expected_hash) checkHash(input.expected_hash, "expected_hash");
    let artifactId = uuidv7();
    let version = 1;
    if (input.base_content_ref) {
      const base = await this.findRow(input.engagement_id, input.session_id, input.base_content_ref);
      if (!base) fail("authorization_error", "base Artifact reference is not in this task session");
      artifactId = base.artifact_id;
      version = base.version + 1;
    }
    safeSegment(artifactId, "artifact_id");
    await this.assertFence(input, principal);
    const storedInput: ArtifactBeginInput = binding.mode === "run-bound"
      ? { ...input, work_run_id: binding.work_run_id!, attempt_id: binding.attempt_id!, generation: binding.generation! }
      : input;
    if (input.summary && /(https?:\/\/|token|secret|cookie|authorization|bearer)/i.test(input.summary)) fail("validation_error", "summary contains host-only or sensitive metadata");
    const children = input.child_refs ?? [];
    if (new Set(children).size !== children.length || children.includes(artifactId)) fail("validation_error", "composite child references must be unique and cannot reference the parent");
    for (const child of children) { const row = await this.findRow(input.engagement_id, input.session_id, child); if (!row) fail("authorization_error", "composite child reference is not in this task session"); if (row.child_refs?.includes(artifactId)) fail("validation_error", "composite Artifact references cannot form a cycle"); }
    const derivedFrom = input.derived_from ?? input.parent_ref;
    if (derivedFrom) { const parent = await this.findRow(input.engagement_id, input.session_id, derivedFrom); if (!parent) fail("authorization_error", "derived Artifact parent is not in this task session"); if (parent.parent_ref === artifactId) fail("validation_error", "derived Artifact references cannot form a cycle"); }
    if ((input.storage_mode ?? "taric_stored") === "external") {
      if (!input.host_ref) fail("validation_error", "external Artifact requires host_ref");
      const row: ArtifactRow = { content_ref: `${artifactId}@v${version}`, artifact_id: artifactId, version, engagement_id: input.engagement_id, session_id: input.session_id, payload_kind: input.payload_kind, media_type: input.media_type, storage_mode: "external", category: input.category, summary_ref: input.summary_ref, captured_at: input.captured_at, host_ref: input.host_ref, byte_length: input.expected_bytes ?? 0, chunk_count: 0, content_hash: input.expected_hash, content_status: "external", integrity_status: "unverified", stored_at: new Date().toISOString(), work_run_id: storedInput.work_run_id, attempt_id: storedInput.attempt_id, generation: storedInput.generation, parent_ref: derivedFrom, child_refs: input.child_refs, relative_dir: "", manifest_path: "" };
      await this.#authority?.saveArtifactCatalogRow(row, [], undefined, undefined, principal); this.#rows.set(this.rowKey(row), row); this.saveCatalog(); const result = { artifact_id: artifactId, content_ref: row.content_ref, version, storage_mode: "external", content_status: "external" }; await this.saveIdempotentResult(input.idempotency_key, "artifact.store.begin", principal, input.engagement_id, beginHash, result); return result;
    }
    const uploadId = uuidv7(); const stagingDir = join(binding.root, ".staging", uploadId); mkdirSync(stagingDir, { recursive: true, mode: 0o700 }); const upload: Upload = { upload_id: uploadId, artifact_id: artifactId, version, binding, principal, input: { ...storedInput, parent_ref: derivedFrom }, staging_dir: stagingDir, chunks: [], total_bytes: 0 }; await this.persistUpload(upload); this.#uploads.set(uploadId, upload);
    const result = { upload_id: uploadId, artifact_id: artifactId, version, next_ordinal: 0, max_chunk_bytes: ARTIFACT_CHUNK_BYTES, deployment_profile: ARTIFACT_DEPLOYMENT_PROFILE, content_status: "pending" }; await this.saveIdempotentResult(input.idempotency_key, "artifact.store.begin", principal, input.engagement_id, beginHash, result); return result;
  }
  async append(input: ArtifactAppendInput, principal = "unknown"): Promise<Record<string, unknown>> {
    await this.initialize();
    return this.uploadOperation(input.upload_id, () => this.artifactMutation(() => this.appendUpload(input, principal)));
  }
  /** Append already-decoded bytes from the trusted content transport. This avoids a base64 copy. */
  async appendBinary(input: ArtifactBinaryAppendInput, principal = "unknown"): Promise<Record<string, unknown>> {
    await this.initialize();
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
    return this.uploadOperation(input.upload_id, () => this.artifactMutation(() => this.appendDecodedUpload(input, principal, bytes, false)));
  }
  async appendBinaryStream(input: ArtifactBinaryAppendStreamInput, principal: string, source: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
    await this.initialize();
    // 幂等短路先于活跃 upload 校验：对已完成上传的重放直接返回原结果。
    // 哈希基底与 appendBinaryStreamQueued 的内部 appendHash 一致（transport_hash 恒等于 chunk_hash）。
    const priorAppend = await this.idempotentResult(input.idempotency_key, "artifact.store.append", principal, input.engagement_id, requestHash({ engagement_id: input.engagement_id, session_id: input.session_id, upload_id: input.upload_id, ordinal: input.ordinal, chunk_hash: input.chunk_hash, transport_hash: input.chunk_hash }));
    if (priorAppend) return priorAppend as Record<string, unknown>;
    return this.uploadOperation(input.upload_id, () => this.artifactMutation(() => this.appendBinaryStreamQueued(input, principal, source)));
  }
  private async appendUpload(input: ArtifactAppendInput, principal: string): Promise<Record<string, unknown>> {
    const upload = await this.requireUpload(input, principal);
    await this.assertFence(upload.input, principal);
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > upload.chunks.length) fail("validation_error", "chunk ordinal must be ordered"); if (input.encoding !== undefined && input.encoding !== "base64") fail("validation_error", "encoding must be base64");
    if (typeof input.data !== "string" || input.data.length > MAX_BASE64_CHARS) fail("validation_error", "base64 transport envelope exceeds 64 MiB decoded chunk limit");
    const metadataBytes = Buffer.byteLength(JSON.stringify({ ...input, data: "" }), "utf8");
    if (metadataBytes > ARTIFACT_DEPLOYMENT_PROFILE.json_metadata_max_bytes) fail("validation_error", "Artifact transport metadata exceeds its envelope bound");
    if (!input.data || !isCanonicalBase64(input.data)) fail("validation_error", "data must be canonical base64 transport");
    const envelopeBytes = metadataBytes + input.data.length;
    if (envelopeBytes > ARTIFACT_DEPLOYMENT_PROFILE.transport_envelope_max_bytes) fail("validation_error", "Artifact transport envelope exceeds its bound");
    const bytes = Buffer.from(input.data, "base64"); if (bytes.length > ARTIFACT_CHUNK_BYTES) fail("validation_error", "chunk exceeds the decoded limit");
    return this.appendDecodedUpload(input, principal, bytes, true, upload);
  }
  private async appendDecodedUpload(input: ArtifactAppendInput | ArtifactBinaryAppendInput, principal: string, bytes: Buffer, base64Transport: boolean, knownUpload?: Upload): Promise<Record<string, unknown>> {
    if (bytes.length > ARTIFACT_CHUNK_BYTES) fail("validation_error", "chunk exceeds the decoded limit");
    checkHash(input.chunk_hash, "chunk_hash"); const decodedHash = hashBytes(bytes); if (decodedHash !== input.chunk_hash) fail("conflict", "chunk hash mismatch");
    const appendHash = requestHash({ engagement_id: input.engagement_id, session_id: input.session_id, upload_id: input.upload_id, ordinal: input.ordinal, chunk_hash: input.chunk_hash, transport_hash: decodedHash });
    const priorResult = await this.idempotentResult(input.idempotency_key, "artifact.store.append", principal, input.engagement_id, appendHash);
    if (priorResult) return priorResult as Record<string, unknown>;
    const upload = knownUpload ?? await this.requireUpload(input, principal);
    if (!knownUpload) await this.assertFence(upload.input, principal);
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > upload.chunks.length) fail("validation_error", "chunk ordinal must be ordered");
    if (!base64Transport) this.#options.measure?.("decode");
    const existing = upload.chunks[input.ordinal]; if (existing) { if (existing.hash !== input.chunk_hash || existing.bytes !== bytes.length) fail("idempotency_conflict", "chunk ordinal already contains different bytes"); const result = { upload_id: input.upload_id, ordinal: input.ordinal, next_ordinal: upload.chunks.length, idempotent: true }; await this.saveIdempotentResult(input.idempotency_key, "artifact.store.append", principal, input.engagement_id, appendHash, result); return result; }
    const path = join(upload.staging_dir, `chunk-${String(input.ordinal).padStart(8, "0")}.part`); writeFileSync(path, bytes, { mode: 0o600 }); upload.chunks.push({ ordinal: input.ordinal, bytes: bytes.length, hash: input.chunk_hash, path }); upload.total_bytes += bytes.length; await this.persistUpload(upload);
    this.#options.measure?.("append");
    const result = { upload_id: input.upload_id, ordinal: input.ordinal, next_ordinal: upload.chunks.length, bytes: bytes.length }; await this.saveIdempotentResult(input.idempotency_key, "artifact.store.append", principal, input.engagement_id, appendHash, result); return result;
  }
  private async appendBinaryStreamQueued(input: ArtifactBinaryAppendStreamInput, principal: string, source: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > ARTIFACT_DEPLOYMENT_PROFILE.json_metadata_max_bytes) fail("validation_error", "Artifact transport metadata exceeds its 16 KiB bound");
    const upload = await this.requireUpload(input, principal);
    await this.assertFence(upload.input, principal);
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > upload.chunks.length) fail("validation_error", "chunk ordinal must be ordered");
    if (!Number.isSafeInteger(input.byte_length) || input.byte_length < 1 || input.byte_length > ARTIFACT_CHUNK_BYTES) fail("validation_error", "binary chunk byte_length must be within the 64 MiB decoded limit");
    checkHash(input.chunk_hash, "chunk_hash");
    const stagingPath = join(upload.staging_dir, `chunk-${String(input.ordinal).padStart(8, "0")}.${uuidv7()}.receive`);
    const output = createWriteStream(stagingPath, { flags: "wx", mode: 0o600, highWaterMark: 64 * 1024 });
    const outputDone = finished(output); outputDone.catch(() => {});
    const digest = createHash("sha256"); let received = 0;
    try {
      for await (const part of source) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part.buffer, part.byteOffset, part.byteLength);
        if (received + bytes.length > input.byte_length || received + bytes.length > ARTIFACT_CHUNK_BYTES) fail("validation_error", "binary body exceeded its declared bound");
        digest.update(bytes); received += bytes.length;
        if (!output.write(bytes)) await once(output, "drain");
      }
      output.end(); await outputDone;
      if (received !== input.byte_length) fail("validation_error", "binary body ended before its declared byte_length");
      const receivedHash = `sha256:${digest.digest("hex")}`;
      if (receivedHash !== input.chunk_hash) fail("conflict", "chunk hash mismatch");
      const appendHash = requestHash({ engagement_id: input.engagement_id, session_id: input.session_id, upload_id: input.upload_id, ordinal: input.ordinal, chunk_hash: input.chunk_hash, transport_hash: receivedHash });
      const priorResult = await this.idempotentResult(input.idempotency_key, "artifact.store.append", principal, input.engagement_id, appendHash);
      if (priorResult) { rmSync(stagingPath, { force: true }); return priorResult as Record<string, unknown>; }
      const existing = upload.chunks[input.ordinal];
      if (existing) {
        if (existing.hash !== input.chunk_hash || existing.bytes !== received) fail("idempotency_conflict", "chunk ordinal already contains different bytes");
        rmSync(stagingPath, { force: true });
        const result = { upload_id: input.upload_id, ordinal: input.ordinal, next_ordinal: upload.chunks.length, idempotent: true };
        await this.saveIdempotentResult(input.idempotency_key, "artifact.store.append", principal, input.engagement_id, appendHash, result);
        return result;
      }
      const path = join(upload.staging_dir, `chunk-${String(input.ordinal).padStart(8, "0")}.part`);
      renameSync(stagingPath, path);
      upload.chunks.push({ ordinal: input.ordinal, bytes: received, hash: receivedHash, path }); upload.total_bytes += received; await this.persistUpload(upload);
      this.#options.measure?.("append");
      const result = { upload_id: input.upload_id, ordinal: input.ordinal, next_ordinal: upload.chunks.length, bytes: received };
      await this.saveIdempotentResult(input.idempotency_key, "artifact.store.append", principal, input.engagement_id, appendHash, result);
      return result;
    } catch (cause) {
      output.destroy(); await outputDone.catch(() => {}); rmSync(stagingPath, { force: true }); throw cause;
    }
  }
  async commit(input: ArtifactCommitInput, principal = "unknown"): Promise<ArtifactRow> {
    await this.initialize();
    // 幂等短路先于活跃 upload 校验（与 begin 一致）：整流程重放依赖于此。
    const priorCommit = await this.idempotentResult(input.idempotency_key, "artifact.store.commit", principal, input.engagement_id, requestHash(input));
    if (priorCommit) return priorCommit as ArtifactRow;
    return this.uploadOperation(input.upload_id, () => this.commitUpload(input, principal));
  }
  private async commitUpload(input: ArtifactCommitInput, principal: string): Promise<ArtifactRow> {
    await this.initialize();
    const commitHash = requestHash(input); const prior = await this.idempotentResult(input.idempotency_key, "artifact.store.commit", principal, input.engagement_id, commitHash); if (prior) return prior as ArtifactRow;
    const upload = await this.requireUpload(input, principal); checkHash(input.content_hash, "content_hash");
    await this.assertFence(upload.input, principal);
    if (upload.total_bytes !== input.total_bytes || upload.chunks.length !== (input.chunk_count ?? upload.chunks.length)) fail("conflict", "upload byte or chunk count mismatch"); const fullHash = createHash("sha256"); for (const chunk of upload.chunks.sort((a, b) => a.ordinal - b.ordinal)) { if (statSync(chunk.path).size !== chunk.bytes || hashFile(chunk.path, fullHash) !== chunk.hash) fail("conflict", "staged chunk failed integrity verification"); }
    if (`sha256:${fullHash.digest("hex")}` !== input.content_hash) fail("conflict", "content hash mismatch"); if (upload.input.expected_bytes !== undefined && upload.input.expected_bytes !== input.total_bytes) fail("conflict", "expected byte count mismatch"); if (upload.input.expected_hash && upload.input.expected_hash !== input.content_hash) fail("conflict", "expected content hash mismatch");
    const storedAt = new Date().toISOString(); const parts = storedAt.slice(0, 10).split("-"); const relDir = join("artifacts", ...parts, upload.artifact_id.slice(0, 2), upload.artifact_id, `v${String(upload.version).padStart(6, "0")}`); const dir = join(upload.binding.root, relDir); const publishDir = `${dir}.publishing-${input.upload_id}`;
    const manifestChunks: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }> = []; let offset = 0; for (const chunk of upload.chunks) { const filename = `payload-${String(chunk.ordinal + 1).padStart(6, "0")}.part`; manifestChunks.push({ ordinal: chunk.ordinal, offset, bytes: chunk.bytes, hash: chunk.hash, path: relative(upload.binding.root, join(dir, filename)).split(sep).join("/") }); offset += chunk.bytes; }
    const manifest = { schema_version: "1.0.0", artifact_id: upload.artifact_id, version: upload.version, payload_kind: upload.input.payload_kind, media_type: upload.input.media_type, charset: upload.input.charset, content_encoding: upload.input.content_encoding, transfer_encoding: upload.input.transfer_encoding, total_bytes: input.total_bytes, chunk_size: ARTIFACT_CHUNK_BYTES, chunk_count: manifestChunks.length, content_hash: input.content_hash, publication_state: "available", chunks: manifestChunks }; const manifestPath = join(publishDir, "content.manifest.json"); const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"); const manifestHash = hashBytes(manifestBytes);
    const row: ArtifactRow = { content_ref: `${upload.artifact_id}@v${upload.version}`, artifact_id: upload.artifact_id, version: upload.version, engagement_id: input.engagement_id, session_id: input.session_id, payload_kind: upload.input.payload_kind, media_type: upload.input.media_type, charset: upload.input.charset, content_encoding: upload.input.content_encoding, transfer_encoding: upload.input.transfer_encoding, storage_mode: "taric_stored", category: upload.input.category, summary_ref: upload.input.summary_ref, captured_at: upload.input.captured_at, host_ref: upload.input.host_ref, byte_length: input.total_bytes, chunk_count: manifestChunks.length, content_hash: input.content_hash, manifest_hash: manifestHash, content_status: "available", integrity_status: "verified", stored_at: storedAt, work_run_id: upload.input.work_run_id, attempt_id: upload.input.attempt_id, generation: upload.input.generation, parent_ref: upload.input.parent_ref, child_refs: upload.input.child_refs, relative_dir: relDir.split(sep).join("/"), manifest_path: relative(upload.binding.root, join(dir, "content.manifest.json")).split(sep).join("/") };
    if (this.#authority?.startArtifactPublication) await this.#authority.startArtifactPublication(input.upload_id, input.engagement_id, input.session_id, row.content_ref, dir);
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 }); mkdirSync(publishDir, { recursive: true, mode: 0o700 }); writeFileSync(join(publishDir, ".operation.json"), JSON.stringify({ upload_id: input.upload_id, phase: "publishing", content_hash: input.content_hash, chunk_count: upload.chunks.length, created_at: storedAt }) + "\n", { mode: 0o600 });
    for (const chunk of upload.chunks) { const filename = `payload-${String(chunk.ordinal + 1).padStart(6, "0")}.part`; copyFileSync(chunk.path, join(publishDir, filename)); }
    this.#options.measure?.("copy");
    this.#options.fault?.("before_manifest");
    writeFileSync(manifestPath, manifestBytes, { mode: 0o600 }); writeFileSync(join(publishDir, "metadata.md"), `# Artifact ${upload.artifact_id}\n\n- Content reference: ${upload.artifact_id}@v${upload.version}\n- Media type: ${upload.input.media_type}\n- Bytes: ${input.total_bytes}\n- Hash: ${input.content_hash}\n`, { mode: 0o600 });
    const segmentDir = join(upload.binding.root, "manifest", "segments", ...parts, upload.artifact_id.slice(0, 2));
    mkdirSync(segmentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(segmentDir, `${upload.artifact_id}-v${String(upload.version).padStart(6, "0")}.ndjson`), `${JSON.stringify({ content_ref: row.content_ref, stored_at: storedAt, manifest_hash: manifestHash, content_hash: input.content_hash, byte_length: input.total_bytes, chunk_count: manifestChunks.length })}\n`, { mode: 0o600 });
    if (this.#authority?.prepareArtifactPublication) await this.#authority.prepareArtifactPublication(input.upload_id, row, manifestChunks, dir, input.idempotency_key ? { key: input.idempotency_key, principal, request_hash: commitHash, result: row } : undefined);
    this.#options.fault?.("before_rename");
    renameSync(publishDir, dir);
    this.#options.fault?.("after_rename");
    if (this.#authority?.markArtifactPublication) await this.#authority.markArtifactPublication(input.upload_id, "published");
    this.#options.fault?.("after_publication_marker");
    const idem = input.idempotency_key ? { key: input.idempotency_key, principal, request_hash: commitHash, result: row } : undefined;
    try {
      this.#options.fault?.("before_catalog_commit");
      // The backend validates the fence in the completion transaction, or
      // accepts the exact publication already committed by another consumer.
      if (this.#authority?.completeArtifactPublication) await this.#authority.completeArtifactPublication(input.upload_id, row, manifestChunks, idem); else await this.#authority?.saveArtifactCatalogRow(row, manifestChunks, input.upload_id, idem, principal);
    } catch (error) {
      await this.#authority?.failArtifactPublication?.(input.upload_id, error instanceof Error ? error.message : "authority publication failed");
      throw error;
    }
    this.#options.fault?.("after_catalog_commit");
    this.#options.measure?.("publish");
    this.#rows.set(this.rowKey(row), row); this.#uploads.delete(input.upload_id); rmSync(upload.staging_dir, { recursive: true, force: true }); rmSync(join(dir, ".operation.json"), { force: true }); this.saveCatalog(); return row;
  }
  private async artifactMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.#authority ? this.#authority.artifactMutation(operation) : operation();
  }
  /** Serializes this consumer's ordered upload; filesystem sharing is not an authority lock. */
  private async uploadOperation<T>(uploadId: string, operation: () => Promise<T>): Promise<T> {
    const current = this.#uploadOperations.get(uploadId);
    const prior = current?.tail ?? Promise.resolve();
    const state = current ?? { tail: Promise.resolve(), depth: 0 };
    state.depth += 1;
    const result = prior.then(operation);
    state.tail = result.then(() => {}, () => {});
    this.#uploadOperations.set(uploadId, state);
    try { return await result; }
    finally {
      const active = this.#uploadOperations.get(uploadId);
      if (active === state) {
        state.depth -= 1;
        if (state.depth === 0) this.#uploadOperations.delete(uploadId);
      }
    }
  }
  async read(input: { engagement_id: string; session_id: string; content_ref: string; offset?: number; length?: number; chunk_cursor?: string; principal_id?: string }): Promise<Record<string, unknown>> {
    await this.initialize();
    const row = await this.requireRow(input); if (row.content_status !== "available") fail("unavailable_host", "content is unavailable"); const binding = await this.requireBinding(input.engagement_id, input.session_id); let manifestBytes: Buffer; try { const manifestPath = realpathSync(join(binding.root, row.manifest_path)); if (manifestPath !== binding.root && !manifestPath.startsWith(`${binding.root}${sep}`)) fail("authorization_error", "manifest escaped the task session"); manifestBytes = readFileSync(manifestPath); } catch { row.content_status = "unavailable"; row.integrity_status = "missing"; fail("unavailable_host", "content is unavailable"); } if (!row.manifest_hash || hashBytes(manifestBytes) !== row.manifest_hash) { row.content_status = "integrity_failed"; row.integrity_status = "mismatch"; fail("conflict", "stored manifest failed integrity verification"); } const manifest = JSON.parse(manifestBytes.toString("utf8")) as { chunks: Array<{ ordinal: number; offset: number; bytes: number; hash: string; path: string }> };
    if (row.byte_length === 0 && manifest.chunks.length === 0) return { content_ref: row.content_ref, artifact_id: row.artifact_id, version: row.version, payload_kind: row.payload_kind, media_type: row.media_type, byte_offset: 0, byte_length: 0, data: "", encoding: "base64", content_hash: row.content_hash, chunk_verified: true, integrity_status: row.integrity_status, max_response_bytes: ARTIFACT_CHUNK_BYTES };
    const cursor = input.chunk_cursor?.split(":"); const cursorOrdinal = cursor ? Number(cursor[0]) : undefined; const cursorOffset = cursor?.[1] === undefined ? undefined : Number(cursor[1]); const byteOffset = input.offset ?? (cursorOffset !== undefined ? cursorOffset : 0); if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset >= row.byte_length) fail("validation_error", "offset is outside the Artifact"); const ordinal = cursorOrdinal ?? manifest.chunks.findIndex((item) => byteOffset >= item.offset && byteOffset < item.offset + item.bytes); if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= manifest.chunks.length) fail("validation_error", "invalid chunk cursor");
    const chunk = manifest.chunks[ordinal]; let bytes: Buffer; try { const chunkPath = realpathSync(join(binding.root, chunk.path)); if (chunkPath !== binding.root && !chunkPath.startsWith(`${binding.root}${sep}`)) fail("authorization_error", "payload escaped the task session"); bytes = readFileSync(chunkPath); } catch { row.content_status = "unavailable"; row.integrity_status = "missing"; fail("unavailable_host", "content is unavailable"); } if (bytes.length !== chunk.bytes || hashBytes(bytes) !== chunk.hash) { row.content_status = "integrity_failed"; row.integrity_status = "mismatch"; fail("conflict", "stored content failed integrity verification"); }
    const start = Math.max(0, byteOffset - chunk.offset); const length = input.length ?? Math.min(ARTIFACT_CHUNK_BYTES, bytes.length - start); if (!Number.isSafeInteger(length) || length < 1 || length > ARTIFACT_CHUNK_BYTES) fail("validation_error", "read length must be bounded"); const slice = bytes.subarray(start, Math.min(bytes.length, start + length)); const absoluteEnd = chunk.offset + start + slice.length; const nextChunk = absoluteEnd < chunk.offset + chunk.bytes ? `${ordinal}:${absoluteEnd}` : absoluteEnd < row.byte_length ? `${ordinal + 1}:${absoluteEnd}` : undefined;
    await this.#authority?.recordArtifactEvent("artifact.content.read", input.engagement_id, row.content_ref, { session_id: input.session_id, principal_id: input.principal_id, content_ref: row.content_ref, byte_offset: chunk.offset + start, byte_length: slice.length, content_hash: row.content_hash, chunk_hash: chunk.hash, integrity_status: row.integrity_status });
    return { content_ref: row.content_ref, artifact_id: row.artifact_id, version: row.version, payload_kind: row.payload_kind, media_type: row.media_type, charset: row.charset, content_encoding: row.content_encoding, byte_offset: chunk.offset + start, byte_length: slice.length, data: slice.toString("base64"), encoding: "base64", content_hash: row.content_hash, chunk_hash: chunk.hash, chunk_verified: true, integrity_status: row.integrity_status, next_cursor: nextChunk, max_response_bytes: ARTIFACT_CHUNK_BYTES };
  }
  async readBounded(input: { engagement_id: string; session_id: string; content_ref: string; offset?: number; length?: number; chunk_cursor?: string; max_response_bytes?: number; principal_id?: string }): Promise<Record<string, unknown>> {
    const max = input.max_response_bytes ?? ARTIFACT_CHUNK_BYTES; if (!Number.isSafeInteger(max) || max < 1 || max > ARTIFACT_CHUNK_BYTES) fail("validation_error", "max_response_bytes must be bounded");
    const requested = input.length ?? max;
    if (!Number.isSafeInteger(requested) || requested < 1) fail("validation_error", "read length must be bounded");
    return { ...await this.read({ ...input, length: Math.min(requested, max) }), max_response_bytes: max };
  }
  async metadata(input: { engagement_id: string; session_id: string; content_ref: string }): Promise<Record<string, unknown>> { await this.initialize(); const row = await this.requireRow(input); const { relative_dir: _dir, manifest_path: _manifest, host_ref: _hostRef, ...safe } = row; return safe; }
  async list(input: { engagement_id: string; session_id: string; cursor?: string; page_size?: number; category?: string; media_type?: string; work_run_id?: string; include_content?: boolean; max_response_bytes?: number; principal_id?: string }): Promise<Record<string, unknown>> {
    await this.initialize();
    const pageSize = input.page_size ?? 100; if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) fail("validation_error", "page_size must be bounded"); await this.requireBinding(input.engagement_id, input.session_id);
    const cursor = input.cursor ? cursorDecode(input.cursor) : undefined;
    if (cursor && (cursor.engagement_id !== input.engagement_id || cursor.session_id !== input.session_id || cursor.principal_id !== (input.principal_id ?? null) || cursor.category !== (input.category ?? null) || cursor.media_type !== (input.media_type ?? null) || cursor.work_run_id !== (input.work_run_id ?? null))) fail("validation_error", "catalog cursor is bound to another request");
    let rows: ArtifactRow[]; let hasMore = false; let watermark = { catalog_watermark: this.#rows.size, index_watermark: this.#rows.size, index_status: "current" };
    if (this.#authority?.queryArtifactCatalog) {
      const page = await this.#authority.queryArtifactCatalog({ engagement_id: input.engagement_id, session_id: input.session_id, category: input.category, media_type: input.media_type, work_run_id: input.work_run_id, after: cursor && typeof cursor.stored_at === "string" && typeof cursor.content_ref === "string" ? { stored_at: cursor.stored_at, content_ref: cursor.content_ref } : undefined, limit: pageSize });
      rows = page.items as unknown as ArtifactRow[]; hasMore = page.has_more; watermark = page.watermark;
    } else {
      const catalog = this.#authority ? await this.#authority.artifactCatalogRows(input) as unknown as ArtifactRow[] : [...this.#rows.values()];
      rows = catalog.filter((row) => row.engagement_id === input.engagement_id && row.session_id === input.session_id && (!input.category || row.category === input.category) && (!input.media_type || row.media_type === input.media_type) && (!input.work_run_id || row.work_run_id === input.work_run_id)).sort((a, b) => a.stored_at.localeCompare(b.stored_at) || a.content_ref.localeCompare(b.content_ref));
      if (cursor?.content_ref) { const index = rows.findIndex((row) => row.stored_at === cursor.stored_at && row.content_ref === cursor.content_ref); if (index < 0) fail("validation_error", "invalid list cursor"); rows = rows.slice(index + 1); }
      hasMore = rows.length > pageSize; rows = rows.slice(0, pageSize);
    }
    const pageItems = rows.map(({ relative_dir: _dir, manifest_path: _manifest, host_ref: _hostRef, ...row }) => row);
    let next_cursor: string | undefined;
    const metadata = () => {
      const last = rows.at(-1);
      next_cursor = hasMore && last ? cursorEncode({ engagement_id: input.engagement_id, session_id: input.session_id, principal_id: input.principal_id ?? null, category: input.category ?? null, media_type: input.media_type ?? null, work_run_id: input.work_run_id ?? null, stored_at: last.stored_at, content_ref: last.content_ref }) : undefined;
      return { items: pageItems, next_cursor, catalog_watermark: watermark.catalog_watermark, index_watermark: watermark.index_watermark, index_status: watermark.index_status };
    };
    let pageMetadata = metadata();
    while (jsonBytes(pageMetadata) > ARTIFACT_DEPLOYMENT_PROFILE.metadata_page_bytes_max) {
      if (pageItems.length <= 1) fail("validation_error", "Artifact metadata page exceeds its 1 MiB bound");
      pageItems.pop(); rows.pop(); hasMore = true; pageMetadata = metadata();
    }
    const max = input.max_response_bytes ?? ARTIFACT_CHUNK_BYTES;
    if (!Number.isSafeInteger(max) || max < 1 || max > ARTIFACT_CHUNK_BYTES) fail("validation_error", "max_response_bytes must be bounded");
    const content = input.include_content && rows[0] ? await this.readBounded({ engagement_id: input.engagement_id, session_id: input.session_id, content_ref: rows[0].content_ref, max_response_bytes: max, principal_id: input.principal_id }) : undefined;
    return { ...pageMetadata, content, max_response_bytes: input.include_content ? max : undefined };
  }
  async output(input: { engagement_id: string; session_id: string; cursor?: string; execution_cursor?: string; page_size?: number; include_content?: boolean; max_response_bytes?: number; work_run_id?: string; attempt_id?: string; principal_id?: string }): Promise<Record<string, unknown>> {
    const max = input.max_response_bytes ?? ARTIFACT_CHUNK_BYTES; if (!Number.isSafeInteger(max) || max < 1 || max > ARTIFACT_CHUNK_BYTES) fail("validation_error", "max_response_bytes must be bounded");
    let pageSize = Math.min(input.page_size ?? 100, MAX_PAGE_SIZE);
    let page: Record<string, unknown>; let executionPage: { items: Array<Record<string, unknown>>; index_watermark: number; next_cursor?: string };
    let result: Record<string, unknown>;
    while (true) {
      page = await this.list({ ...input, page_size: pageSize, include_content: false });
      executionPage = this.#authority?.executionCatalogPage ? await this.#authority.executionCatalogPage({ engagement_id: input.engagement_id, session_id: input.session_id, work_run_id: input.work_run_id, attempt_id: input.attempt_id, cursor: input.execution_cursor, page_size: pageSize }) : { items: await this.#authority?.executionCatalogRows({ engagement_id: input.engagement_id, session_id: input.session_id, work_run_id: input.work_run_id, attempt_id: input.attempt_id }) ?? [], index_watermark: 0, next_cursor: undefined };
      result = { ...page, execution: executionPage.items, execution_next_cursor: executionPage.next_cursor, execution_index_watermark: executionPage.index_watermark };
      if (jsonBytes(result) <= ARTIFACT_DEPLOYMENT_PROFILE.metadata_page_bytes_max) break;
      if (pageSize <= 1) fail("validation_error", "Artifact session output page exceeds its 1 MiB bound");
      pageSize = Math.max(1, Math.floor(pageSize / 2));
    }
    const first = (page.items as Array<{ content_ref: string }>)[0]; const content = input.include_content && first ? await this.readBounded({ engagement_id: input.engagement_id, session_id: input.session_id, content_ref: first.content_ref, max_response_bytes: max, principal_id: input.principal_id }) : undefined;
    return { ...result, include_content: Boolean(input.include_content), max_response_bytes: max, content };
  }
  async reconcile(input: { cursor?: string; page_size?: number; engagement_id?: string; session_id?: string; read_only?: boolean } = {}): Promise<{ valid: boolean; pending_publications: Array<Record<string, unknown>>; unavailable: string[]; integrity_failed: string[]; checked: number; next_cursor?: string }> {
    await this.initialize();
    await this.refreshBindings(input);
    const pending_publications = (await this.#authority?.artifactPublications?.(input) ?? []).filter((marker) => this.matchesScope(marker, input) && this.#bindings.has(this.bindingKey(marker.engagement_id, marker.session_id))).map((marker) => {
      const row = marker.body.row as ArtifactRow | undefined; const binding = this.#bindings.get(this.bindingKey(marker.engagement_id, marker.session_id));
      const checked = row && binding ? this.checkArtifactFiles(binding, row, [], []) : undefined;
      return { upload_id: marker.upload_id, content_ref: marker.content_ref, phase: marker.phase, content_status: checked?.content_status ?? "pending", integrity_status: checked?.integrity_status ?? "unverified", content_hash: row?.content_hash };
    });
    const unavailable: string[] = []; const integrity_failed: string[] = []; let checked = 0;
    const limit = input.page_size ?? 100; if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) fail("validation_error", "page_size must be bounded");
    const bindings = [...this.#bindings.values()].filter((binding) => this.matchesScope(binding, input)).sort((a, b) => this.bindingKey(a.engagement_id, a.session_id).localeCompare(this.bindingKey(b.engagement_id, b.session_id)));
    let sessionIndex = 0; let after: { stored_at: string; content_ref: string } | undefined;
    if (input.cursor) { const cursor = cursorDecode(input.cursor); if (cursor.engagement_id !== (input.engagement_id ?? null) || cursor.session_id !== (input.session_id ?? null) || typeof cursor.session_index !== "number" || !Number.isSafeInteger(cursor.session_index) || cursor.session_index < 0 || cursor.session_index > bindings.length) fail("validation_error", "reconcile cursor is bound to another request"); sessionIndex = cursor.session_index; if (typeof cursor.stored_at === "string" && typeof cursor.content_ref === "string") after = { stored_at: cursor.stored_at, content_ref: cursor.content_ref }; }
    let next_cursor: string | undefined;
    if (this.#authority?.queryArtifactCatalog) {
      for (; sessionIndex < bindings.length && checked < limit; sessionIndex++) {
        const binding = bindings[sessionIndex];
        const page = await this.#authority.queryArtifactCatalog({ engagement_id: binding.engagement_id, session_id: binding.session_id, after, limit: limit - checked });
        for (const raw of page.items) {
          const row = raw as unknown as ArtifactRow; checked++; const updated = this.checkArtifactFiles(binding, row, unavailable, integrity_failed);
          if (updated !== row && !input.read_only) { await this.#authority.updateArtifactCatalogRow?.(updated, updated.content_status === "unavailable" ? "artifact.content.unavailable" : "artifact.content.integrity_failed"); this.#rows.set(this.rowKey(updated), updated); }
          after = { stored_at: row.stored_at, content_ref: row.content_ref };
        }
        if (page.has_more) { next_cursor = cursorEncode({ engagement_id: input.engagement_id ?? null, session_id: input.session_id ?? null, session_index: sessionIndex, stored_at: after?.stored_at, content_ref: after?.content_ref }); break; }
        after = undefined;
      }
      if (!next_cursor && sessionIndex < bindings.length) next_cursor = cursorEncode({ engagement_id: input.engagement_id ?? null, session_id: input.session_id ?? null, session_index: sessionIndex });
    } else {
      for (const row of this.#rows.values()) { if (checked >= limit) break; if (!this.matchesScope(row, input)) continue; const binding = this.#bindings.get(this.bindingKey(row.engagement_id,row.session_id)); if (!binding) continue; checked++; const updated = this.checkArtifactFiles(binding,row,unavailable,integrity_failed); if (updated !== row && !input.read_only) this.#rows.set(this.rowKey(updated), updated); }
    }
    return { valid: pending_publications.length === 0 && unavailable.length === 0 && integrity_failed.length === 0, pending_publications, unavailable, integrity_failed, checked, next_cursor };
  }
  private checkArtifactFiles(binding: ArtifactBinding, row: ArtifactRow, unavailable: string[], integrityFailed: string[]): ArtifactRow {
    if (row.storage_mode !== "taric_stored") return row;
    try {
      const manifestPath = canonicalWithin(binding.root, join(binding.root, row.manifest_path)); const bytes = readFileSync(manifestPath);
      if (!row.manifest_hash || hashBytes(bytes) !== row.manifest_hash) { integrityFailed.push(row.content_ref); return { ...row, content_status: "integrity_failed", integrity_status: "mismatch" }; }
      const manifest = JSON.parse(bytes.toString("utf8")) as { chunks?: Array<{ path?: string; bytes?: number; hash?: string; offset?: number }> };
      if (!Array.isArray(manifest.chunks) || manifest.chunks.length !== row.chunk_count || manifest.chunks.some((chunk) => { try { return typeof chunk.path !== "string" || !Number.isSafeInteger(chunk.bytes) || !existsSync(canonicalWithin(binding.root, join(binding.root, chunk.path))); } catch { return true; } })) { unavailable.push(row.content_ref); return { ...row, content_status: "unavailable", integrity_status: "missing" }; }
      const fullHash = createHash("sha256"); let offset = 0;
      for (const chunk of manifest.chunks) {
        const payload = readFileSync(canonicalWithin(binding.root, join(binding.root, chunk.path!)));
        if (payload.length !== chunk.bytes || hashBytes(payload) !== chunk.hash || chunk.offset !== offset) { integrityFailed.push(row.content_ref); return { ...row, content_status: "integrity_failed", integrity_status: "mismatch" }; }
        offset += payload.length; fullHash.update(payload);
      }
      if (offset !== row.byte_length || `sha256:${fullHash.digest("hex")}` !== row.content_hash) { integrityFailed.push(row.content_ref); return { ...row, content_status: "integrity_failed", integrity_status: "mismatch" }; }
      return row;
    } catch { unavailable.push(row.content_ref); return { ...row, content_status: "unavailable", integrity_status: "missing" }; }
  }
  private bindingKey(engagementId: string, sessionId: string): string { return `${engagementId}\0${sessionId}`; }
  private matchesScope(value: { engagement_id: string; session_id: string }, scope: ArtifactScope): boolean { return (scope.engagement_id === undefined || value.engagement_id === scope.engagement_id) && (scope.session_id === undefined || value.session_id === scope.session_id); }
  private localBinding(binding: ArtifactBinding): boolean {
    if (typeof binding.root !== "string" || !isAbsolute(binding.root)) return false;
    const requested = resolve(binding.root);
    // Never follow paths owned by another spool, including during startup/reconcile.
    if (!isWithin(this.#configuredRoot, requested) && !isWithin(this.#root, requested)) return false;
    try { return isWithin(this.#root, realpathSync(requested)); } catch { return isWithin(this.#root, requested); }
  }
  private async refreshBindings(scope: ArtifactScope = {}): Promise<void> {
    if (!this.#authority) return;
    const bindings = await this.#authority.artifactSessions(scope.engagement_id === undefined && scope.session_id === undefined ? undefined : scope);
    for (const [key, binding] of this.#bindings) if (this.matchesScope(binding, scope)) this.#bindings.delete(key);
    for (const binding of bindings) if (this.matchesScope(binding, scope) && this.localBinding(binding)) this.#bindings.set(this.bindingKey(binding.engagement_id, binding.session_id), binding);
  }
  private async refreshUploads(scope: ArtifactScope = {}): Promise<void> {
    if (!this.#authority) return;
    const uploads = await this.#authority.artifactUploads(scope.engagement_id === undefined && scope.session_id === undefined ? undefined : scope);
    for (const [key, upload] of this.#uploads) if (this.matchesScope(upload.binding, scope)) this.#uploads.delete(key);
    for (const saved of uploads) {
      if (!this.matchesScope(saved, scope)) continue;
      const binding = this.#bindings.get(this.bindingKey(saved.engagement_id, saved.session_id));
      const upload = saved.body as unknown as Upload;
      if (!binding || !this.localBinding(binding) || upload.upload_id !== saved.upload_id || upload.binding?.root !== binding.root || upload.binding.engagement_id !== saved.engagement_id || upload.binding.session_id !== saved.session_id || upload.input?.engagement_id !== saved.engagement_id || upload.input.session_id !== saved.session_id || typeof upload.principal !== "string" || !Array.isArray(upload.chunks)) continue;
      const stagingDir = join(binding.root, ".staging", saved.upload_id);
      if (upload.staging_dir !== stagingDir) continue;
      try {
        canonicalWithin(binding.root, stagingDir);
        if (upload.chunks.some((chunk, ordinal) => chunk.ordinal !== ordinal || chunk.path !== join(stagingDir, `chunk-${String(ordinal).padStart(8, "0")}.part`) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > ARTIFACT_CHUNK_BYTES)) continue;
        this.#uploads.set(saved.upload_id, { ...upload, binding });
      } catch { /* Missing or escaped private staging data stays unavailable. */ }
    }
  }
  private async requireBinding(engagementId: string, sessionId: string): Promise<ArtifactBinding> {
    await this.refreshBindings({ engagement_id: engagementId, session_id: sessionId });
    const binding = this.#bindings.get(this.bindingKey(engagementId, sessionId));
    if (!binding) fail("authorization_error", "task session is not registered for this content host");
    let root: string; try { root = realpathSync(binding.root); } catch { fail("unavailable_host", "task session is unavailable"); }
    if (!isWithin(this.#root, root)) fail("authorization_error", "task session root escaped configured content root");
    if (binding.mode !== "host-session" && binding.mode !== "run-bound") fail("validation_error", "task session binding mode is invalid");
    return binding;
  }
  private async requireUpload(input: { engagement_id: string; session_id: string; upload_id: string }, principal: string): Promise<Upload> {
    safeSegment(input.upload_id, "upload_id");
    await this.requireBinding(input.engagement_id, input.session_id);
    await this.refreshUploads(input);
    const upload = this.#uploads.get(input.upload_id);
    if (!upload || upload.binding.engagement_id !== input.engagement_id || upload.binding.session_id !== input.session_id || upload.principal !== principal) fail("authorization_error", "upload is not registered for this session and principal");
    canonicalWithin(upload.binding.root, upload.staging_dir);
    for (const chunk of upload.chunks) canonicalWithin(upload.staging_dir, chunk.path);
    return upload;
  }
  private async findRow(engagementId: string, sessionId: string, contentRef: string): Promise<ArtifactRow | undefined> {
    const key = `${engagementId}\0${sessionId}\0${contentRef}`;
    if (!this.#authority) return this.#rows.get(key);
    const remote = this.#authority.artifactCatalogRow ? await this.#authority.artifactCatalogRow(engagementId, sessionId, contentRef) : (await this.#authority.artifactCatalogRows({ engagement_id: engagementId, session_id: sessionId })).find((row) => row.content_ref === contentRef);
    if (!remote) { this.#rows.delete(key); return undefined; }
    const row = remote as unknown as ArtifactRow;
    if (row.engagement_id !== engagementId || row.session_id !== sessionId || row.content_ref !== contentRef) fail("authorization_error", "Artifact catalog row is outside this task session");
    this.#rows.set(key, row);
    return row;
  }
  private async requireRow(input: { engagement_id: string; session_id: string; content_ref: string }): Promise<ArtifactRow> { safeSegment(input.content_ref, "content_ref"); const row = await this.findRow(input.engagement_id, input.session_id, input.content_ref); if (!row) fail("unavailable_host", "content is unavailable"); return row; }
  private rowKey(row: ArtifactRow): string { return `${row.engagement_id}\0${row.session_id}\0${row.content_ref}`; }
  private saveCatalog(): void { if (this.#authority) return; const path = join(this.#root, ".catalog.json.tmp"); writeFileSync(path, JSON.stringify({ schema_version: "1.0.0", bindings: [...this.#bindings.values()], rows: [...this.#rows.values()] }) + "\n", { mode: 0o600 }); renameSync(path, join(this.#root, ".catalog.json")); }
  private async persistUpload(upload: Upload): Promise<void> { await this.#authority?.saveArtifactUpload(upload.upload_id, upload.binding.engagement_id, upload.binding.session_id, upload as unknown as Record<string, unknown>); }
  private async assertFence(input: ArtifactBeginInput, principal: string): Promise<void> {
    const hasAny = Boolean(input.work_run_id || input.attempt_id || input.generation !== undefined);
    const binding = this.#bindings.get(this.bindingKey(input.engagement_id, input.session_id));
    if (binding?.mode === "run-bound") {
      if (hasAny && (input.work_run_id !== binding.work_run_id || input.attempt_id !== binding.attempt_id || input.generation !== binding.generation)) fail("validation_error", "run-bound Artifact attribution conflicts with the registered session");
      if (!this.#authority || !binding.work_run_id || !binding.attempt_id || !Number.isSafeInteger(binding.generation)) fail("stale_version", "run-bound Artifact session has no durable fence");
      await this.#authority.validateArtifactFence({ engagement_id: input.engagement_id, session_id: input.session_id, work_run_id: binding.work_run_id, attempt_id: binding.attempt_id, generation: binding.generation!, principal });
      return;
    }
    if (!hasAny) return;
    if (!input.work_run_id || !input.attempt_id || !Number.isSafeInteger(input.generation) || input.generation! < 1) fail("validation_error", "run-scoped Artifact writes require WorkRun, Attempt, and generation");
    if (!this.#authority) fail("stale_version", "run-scoped Artifact writes require an authority fence");
    await this.#authority.validateArtifactFence({ engagement_id: input.engagement_id, session_id: input.session_id, work_run_id: input.work_run_id, attempt_id: input.attempt_id, generation: input.generation!, principal });
  }
  private async idempotentResult(key: string | undefined, operation: string, principal: string, engagementId: string, requestHash_: string): Promise<unknown | undefined> {
    if (!key) return undefined; const prior = this.#authority ? await this.#authority.artifactIdempotencyResult(key, operation, principal, engagementId, requestHash_) : this.#idempotency.get(key);
    if (prior === undefined) return undefined;
    if (prior && typeof prior === "object" && "operation" in prior) { const stored = prior as { operation: string; principal: string; engagement_id: string; request_hash: string; result: unknown }; if (stored.operation !== operation || stored.principal !== principal || stored.engagement_id !== engagementId || stored.request_hash !== requestHash_) fail("idempotency_conflict", "idempotency key is bound to another Artifact request"); return stored.result; }
    return prior;
  }
  private async saveIdempotentResult(key: string | undefined, operation: string, principal: string, engagementId: string, requestHash_: string, result: unknown): Promise<void> {
    if (!key) return; await this.#authority?.saveArtifactIdempotency(key, operation, principal, engagementId, requestHash_, result); if (!this.#authority) this.#idempotency.set(key, { operation, principal, engagement_id: engagementId, request_hash: requestHash_, result });
  }
}
