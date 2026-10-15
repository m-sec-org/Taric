import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { ArtifactContentStore, AuthorityStore, ARTIFACT_DEPLOYMENT_PROFILE, uuidv7 } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const value = (flag, fallback) => { const index = args.indexOf(flag); return index < 0 ? fallback : Number(args[index + 1]); };
const bytes = value("--bytes", 1024 ** 2); const concurrency = value("--concurrency", 2);
if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ARTIFACT_DEPLOYMENT_PROFILE.decoded_chunk_bytes || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("invalid benchmark bytes or concurrency");

if (!args.includes("--worker")) {
  const results = ["text", "binary"].map((kind) => JSON.parse(execFileSync(process.execPath, [import.meta.filename, "--worker", kind, "--bytes", String(bytes), "--concurrency", String(concurrency)], { encoding: "utf8", maxBuffer: 1024 ** 2 })));
  const sourceHash = createHash("sha256");
  for (const file of [import.meta.url, ...["artifact-content-store.ts", "store.ts", "sql-driver.ts", "sql-schema.ts"].map((name) => new URL(`../packages/core/src/${name}`, import.meta.url))]) sourceHash.update(readFileSync(typeof file === "string" ? new URL(file) : file));
  process.stdout.write(`${JSON.stringify({ version: "artifact-benchmark/1", measured_at: new Date().toISOString(), source_digest: `sha256:${sourceHash.digest("hex")}`, node: process.version, platform: process.platform, profile: ARTIFACT_DEPLOYMENT_PROFILE, results }, null, 2)}\n`);
} else {
  const kind = args[args.indexOf("--worker") + 1];
  const directory = mkdtempSync(join(tmpdir(), "taric-artifact-benchmark-")); const root = join(directory, "content"); const authority = new AuthorityStore(join(directory, "authority.sqlite"));
  let sampledPeak = process.memoryUsage().rss;
  const measure = () => { sampledPeak = Math.max(sampledPeak, process.memoryUsage().rss); };
  const artifacts = new ArtifactContentStore(root, authority, { measure });
  await artifacts.initialize();
  const engagement_id = uuidv7(); const latencies = []; let transportBytes = 0; let failures = 0;
  const rssStart = process.memoryUsage().rss;
  const started = performance.now();
  try {
    // Uploads are simultaneously in progress. Synchronous decode/copy/publication
    // phases run serially, matching the current single-process deployment.
    await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
      const uploadStarted = performance.now(); const session_id = `upload-${index}`;
      await artifacts.bind({ engagement_id, session_id, root: join(root, session_id) });
      const body = Buffer.alloc(bytes, kind === "text" ? 65 : 0);
      if (kind === "binary") for (let offset = 0; offset < body.length; offset++) body[offset] = offset % 251;
      const content_hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      const upload = await artifacts.begin({ engagement_id, session_id, payload_kind: kind, media_type: kind === "text" ? "text/plain" : "application/octet-stream", expected_bytes: bytes, expected_hash: content_hash });
      const envelope = JSON.stringify({ engagement_id, session_id, upload_id: upload.upload_id, ordinal: 0, data: body.toString("base64"), chunk_hash: content_hash });
      transportBytes += Buffer.byteLength(envelope); measure();
      await setImmediate();
      try {
        await artifacts.append(JSON.parse(envelope)); measure(); await setImmediate();
        await artifacts.commit({ engagement_id, session_id, upload_id: upload.upload_id, total_bytes: bytes, content_hash }); measure();
      } catch { failures++; }
      latencies.push(performance.now() - uploadStarted);
    }));
    const elapsed = performance.now() - started; latencies.sort((a, b) => a - b);
    const source_sequence = (await authority.doctor()).committed_seq;
    process.stdout.write(`${JSON.stringify({ kind, fixture_version: "artifact-pattern/1", decoded_chunk_bytes: bytes, decoded_total_bytes: bytes * concurrency, transport_envelope_bytes: transportBytes, concurrent_uploads: concurrency, execution: "interleaved_uploads_serial_synchronous_phases", elapsed_ms: elapsed, throughput_bytes_per_second: bytes * concurrency / (elapsed / 1000), p95_latency_ms: latencies[Math.ceil(latencies.length * .95) - 1], rss_start_bytes: rssStart, peak_rss_bytes: Math.max(sampledPeak, process.resourceUsage().maxRSS * 1024), publication_failures: failures, source_sequence, durability: ARTIFACT_DEPLOYMENT_PROFILE.id })}\n`);
  } finally { await authority.close(); rmSync(directory, { recursive: true, force: true }); }
}
