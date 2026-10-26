import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AuthorityStore, createCoreService, createPrincipal } from "../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);
const phase = process.argv.find((value) => value.startsWith("--phase="))?.slice("--phase=".length);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = "node:22-alpine";
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function runContainerPhase() {
  const spool = "/spool";
  const dbPath = `${spool}/authority.sqlite`;
  const contentRoot = `${spool}/content`;
  const statePath = `${spool}/verification-state.json`;
  if (phase === "write") {
    const store = new AuthorityStore(dbPath);
    const service = await createCoreService(store, contentRoot);
    const operator = createPrincipal("operator", "container-spool-verifier");
    const initialized = await service.dispatch("engagement.init", operator, {
      name: "container spool bind-mount verification",
      scope: { allowed_targets: ["https://container-spool.invalid"], excluded_targets: [], rules_of_engagement_ref: "test:container-spool" },
    });
    assert.equal(initialized.ok, true);
    const engagement_id = initialized.data.id;
    const session_id = "container-session";
    const sessionRoot = `${contentRoot}/${session_id}`;
    await mkdir(sessionRoot, { recursive: true });
    const host = createPrincipal("host", "container-spool-host", engagement_id);
    const binding = await service.dispatch("artifact.session.bind", host, { engagement_id, session_id, root: sessionRoot, mode: "host-session" });
    assert.equal(binding.ok, true);
    const bytes = Buffer.from([0, 255, 1, 13, 10, 128, 84, 97, 114, 105, 99]);
    const source = `${sessionRoot}/tool-output.bin`;
    await writeFile(source, bytes);
    const ingested = await service.dispatch("artifact.ingest_file", host, {
      engagement_id, session_id, path: source, authorize_spool_access: true, delete_source: true,
      payload_kind: "binary", media_type: "application/octet-stream", idempotency_key: "container-bind-mount-ingest",
    });
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.equal(ingested.data.content_hash, digest(bytes));
    await service.close();
    await writeFile(statePath, `${JSON.stringify({ engagement_id, session_id, content_ref: ingested.data.content_ref, content_hash: digest(bytes), byte_length: bytes.length })}\n`, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ phase, node: process.version, content_hash: digest(bytes) }) + "\n");
    return;
  }
  if (phase === "read") {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const store = new AuthorityStore(dbPath);
    const service = await createCoreService(store, contentRoot);
    const host = createPrincipal("host", "container-spool-host", state.engagement_id, ["content_read"]);
    const metadata = await service.dispatch("artifact.metadata", host, { engagement_id: state.engagement_id, session_id: state.session_id, content_ref: state.content_ref });
    assert.equal(metadata.ok, true, JSON.stringify(metadata));
    assert.equal(metadata.data.integrity_status, "verified");
    const content = await service.dispatch("artifact.content.read", host, { engagement_id: state.engagement_id, session_id: state.session_id, content_ref: state.content_ref, offset: 0, length: state.byte_length });
    assert.equal(content.ok, true, JSON.stringify(content));
    const bytes = Buffer.from(content.data.data, "base64");
    assert.equal(bytes.length, state.byte_length);
    assert.equal(digest(bytes), state.content_hash);
    await service.close();
    await writeFile(statePath, `${JSON.stringify({ ...state, metadata_verified: true, content_bytes_verified: true, read_container_node: process.version })}\n`, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ phase, node: process.version, content_hash: digest(bytes), integrity_status: metadata.data.integrity_status }) + "\n");
    return;
  }
  throw new Error("container phase must be write or read");
}

async function runIsolatedContainer(spool, phaseName, uid, gid) {
  const args = [
    "--context", process.env.TARIC_DOCKER_CONTEXT ?? "orbstack",
    "run", "--rm", "--network", "none", "--user", `${uid}:${gid}`,
    "--volume", `${repoRoot}:/workspace:ro`,
    "--volume", `${spool}:/spool:rw`,
    "--workdir", "/workspace",
    image, "node", "scripts/verify-container-spool.mjs", `--phase=${phaseName}`,
  ];
  try {
    const result = await execFileAsync("docker", args, { cwd: repoRoot, maxBuffer: 1024 * 1024, timeout: 60_000 });
    const line = result.stdout.trim().split("\n").at(-1);
    return JSON.parse(line);
  } catch {
    throw new Error(`Node container spool ${phaseName} phase failed`);
  }
}

async function runHostVerification() {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("--output <report.json> is required");
  const outputPath = resolve(process.argv[outputIndex + 1]);
  const directory = await mkdtemp(`${tmpdir()}/taric-container-spool-`);
  const spool = resolve(directory, "spool");
  await mkdir(spool, { mode: 0o700 });
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  try {
    const writer = await runIsolatedContainer(spool, "write", uid, gid);
    const reader = await runIsolatedContainer(spool, "read", uid, gid);
    const state = JSON.parse(await readFile(resolve(spool, "verification-state.json"), "utf8"));
    assert.equal(writer.content_hash, reader.content_hash);
    assert.equal(state.metadata_verified, true);
    assert.equal(state.content_bytes_verified, true);
    const report = {
      version: "taric-container-spool-verification/1",
      generated_at: new Date().toISOString(),
      container_image: image,
      container_runtime: reader.node,
      host_uid_gid: `${uid}:${gid}`,
      checks: [
        { id: "bind_mounted_spool_writable_by_container_uid", passed: true },
        { id: "artifact_ingest_hash_verified_in_writer_container", passed: true },
        { id: "authority_and_payload_survive_container_replacement", passed: true },
        { id: "artifact_metadata_and_bytes_verified_in_reader_container", passed: true, content_hash: state.content_hash },
      ],
      limitations: ["Two containers ran sequentially on one workstation using one bind mount; this does not test a third-party host runtime, separate hosts sharing a writable spool, storage-node failure, or power-loss durability."],
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ output: outputPath, passed: true, checks: report.checks.length, container_runtime: report.container_runtime })}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (phase) await runContainerPhase();
else await runHostVerification();
