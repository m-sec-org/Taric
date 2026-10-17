import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { AuthorityStore, ARTIFACT_CHUNK_BYTES, ARTIFACT_DEPLOYMENT_PROFILE, createCoreService, createPrincipal, listenAdapterRpc, listenArtifactBinaryRpc, uuidv7 } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const waitFor = (eventTarget, eventName, timeoutMs = 30_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${eventName}`)), timeoutMs);
  eventTarget.once(eventName, (value) => { clearTimeout(timer); resolve(value); });
  eventTarget.once("error", (error) => { clearTimeout(timer); reject(error); });
});

if (args.includes("--server")) {
  const root = option("--root"); const database = option("--database"); const token = option("--token"); const engagementId = option("--engagement");
  const jsonSocket = option("--json-socket"); const binarySocket = option("--binary-socket");
  const authority = new AuthorityStore(database);
  const service = await createCoreService(authority, root);
  const principal = createPrincipal("host", "artifact-benchmark-host", engagementId, ["content_read"]);
  const jsonListener = await listenAdapterRpc(service, { socket_path: jsonSocket, token, principal });
  const binaryListener = await listenArtifactBinaryRpc(service, { socket_path: binarySocket, token, principal });
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  let peakRssBytes = process.memoryUsage().rss; let rssSamples = 0;
  const sample = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); rssSamples++; }, 20);
  process.on("message", (message) => {
    if (message === "metrics") process.send?.({ type: "metrics", rss_bytes: process.memoryUsage().rss, peak_rss_bytes: Math.max(peakRssBytes, process.resourceUsage().maxRSS * 1024), process_max_rss_bytes: process.resourceUsage().maxRSS * 1024, rss_samples: rssSamples, event_loop_delay_max_ms: lag.max / 1e6, event_loop_delay_mean_ms: lag.mean / 1e6 });
  });
  process.stdout.write("READY\n");
  const stop = async () => { clearInterval(sample); lag.disable(); await binaryListener.close(); await jsonListener.close(); await service.close(); process.exit(0); };
  process.on("SIGTERM", () => { void stop(); });
} else {
  const bytes = Number(option("--bytes") ?? 1024 ** 2);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ARTIFACT_CHUNK_BYTES) throw new Error("--bytes must be within the 64 MiB decoded chunk bound");
  const concurrencyArg = option("--concurrency");
  const concurrencies = concurrencyArg ? concurrencyArg.split(",").map(Number) : [1, 2];
  if (concurrencies.some((value) => !Number.isSafeInteger(value) || value < 1 || value > ARTIFACT_DEPLOYMENT_PROFILE.active_uploads_max)) throw new Error("--concurrency must be 1 or 2");
  const directory = await mkdtemp(join(tmpdir(), "taric-artifact-transport-benchmark-"));
  const cases = [];
  try {
    for (const concurrency of concurrencies) {
      for (const kind of ["text", "binary"]) cases.push(await measureCase(directory, kind, bytes, concurrency));
    }
    const executable = process.execPath; const script = fileURLToPath(import.meta.url); const outputPath = option("--output");
    const commandArguments = ["--bytes", String(bytes), "--concurrency", concurrencies.join(","), ...(outputPath ? ["--output", outputPath] : [])];
    const hash = createHash("sha256");
    for (const source of [script, new URL("../packages/core/src/artifact-content-store.ts", import.meta.url), new URL("../packages/core/src/adapter-rpc.ts", import.meta.url), new URL("../packages/core/src/service.ts", import.meta.url), new URL("../packages/cli/src/cli.ts", import.meta.url)]) hash.update(readFileSync(source));
    const report = { version: "artifact-transport-benchmark/1", measured_at: new Date().toISOString(), node: process.version, platform: process.platform, arch: arch(), cpu_model: cpus()[0]?.model, cpu_count: cpus().length, total_memory_bytes: totalmem(), command: { executable, script, arguments: commandArguments }, source_digest: `sha256:${hash.digest("hex")}`, profile: ARTIFACT_DEPLOYMENT_PROFILE, requested_decoded_chunk_bytes: bytes, sample_count: cases.reduce((count, item) => count + item.p95_sample_count, 0), results: cases };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) { const absolutePath = resolve(outputPath); await mkdir(dirname(absolutePath), { recursive: true }); await writeFile(absolutePath, serialized); process.stdout.write(`Wrote ${absolutePath}\n`); }
    else process.stdout.write(serialized);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function measureCase(directory, kind, bytes, concurrency) {
  const root = join(directory, `${kind}-${concurrency}`, "content"); const database = join(directory, `${kind}-${concurrency}`, "authority.sqlite");
  await mkdir(root, { recursive: true });
  const engagement_id = uuidv7(); const token = `${kind}${concurrency}`.padEnd(48, "x");
  // macOS limits Unix-domain socket paths to a short pathname; keep sockets
  // outside the long fixture directory while retaining per-process isolation.
  const socketPrefix = join(tmpdir(), `ta-${process.pid}-${kind[0]}${concurrency}`);
  const jsonSocket = `${socketPrefix}.j`; const binarySocket = `${socketPrefix}.b`;
  const child = fork(fileURLToPath(import.meta.url), ["--server", "--root", root, "--database", database, "--token", token, "--engagement", engagement_id, "--json-socket", jsonSocket, "--binary-socket", binarySocket], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
  let stdout = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Artifact Core subprocess did not become ready")), 30_000);
    const check = () => { if (stdout.includes("READY\n")) { clearTimeout(timeout); resolve(); } };
    child.stdout.on("data", check); child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  const clientLag = monitorEventLoopDelay({ resolution: 10 }); clientLag.enable();
  const clientStartRssBytes = process.memoryUsage().rss; let clientPeakRssBytes = clientStartRssBytes; let clientRssSamples = 0;
  const sample = setInterval(() => { clientPeakRssBytes = Math.max(clientPeakRssBytes, process.memoryUsage().rss); clientRssSamples++; }, 20);
  const samples = []; let transportBytes = 0; let failures = 0;
  try {
    await ready;
    const fixtureHash = contentHash(kind, bytes);
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
      const uploadStarted = performance.now(); const session_id = `upload-${index}`;
      const bound = await rpc(jsonSocket, token, "artifact.session.bind", { engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
      if (!bound.result.ok) throw new Error(`session bind failed: ${bound.result.error?.code}`);
      const begun = await rpc(jsonSocket, token, "artifact.store.begin", { engagement_id, session_id, payload_kind: kind, media_type: kind === "text" ? "text/plain" : "application/octet-stream", expected_bytes: bytes, expected_hash: fixtureHash });
      if (!begun.result.ok) throw new Error(`upload begin failed: ${begun.result.error?.code}`);
      const request = { engagement_id, session_id, upload_id: begun.result.data.upload_id, ordinal: 0, byte_length: bytes, chunk_hash: fixtureHash };
      const header = Buffer.from(JSON.stringify({ token, operation: "artifact.store.append.binary", request }));
      try {
        const append = await sendBinary(binarySocket, header, kind, bytes);
        transportBytes += 4 + header.length + bytes;
        if (!append.ok) throw new Error(`binary append failed: ${append.error?.code}`);
        const committed = await rpc(jsonSocket, token, "artifact.store.commit", { engagement_id, session_id, upload_id: begun.result.data.upload_id, total_bytes: bytes, chunk_count: 1, content_hash: fixtureHash });
        if (!committed.result.ok || committed.result.data.content_hash !== fixtureHash) throw new Error(`publication failed: ${committed.result.error?.code ?? "hash_mismatch"}`);
        samples.push({ index, status: "published", content_hash: committed.result.data.content_hash, append_hash: fixtureHash, elapsed_ms: performance.now() - uploadStarted });
      } catch (error) { failures++; samples.push({ index, status: "failed", code: error instanceof Error ? error.message : "unknown", elapsed_ms: performance.now() - uploadStarted }); }
    }));
    const elapsed = performance.now() - started;
    const limits = await measureTransportLimits(jsonSocket, binarySocket, token, engagement_id, root);
    const jsonBoundary = kind === "text" ? await measureJsonTextPath(jsonSocket, token, engagement_id, root, concurrency) : undefined;
    const metricsPromise = new Promise((resolve) => { const timer = setTimeout(() => resolve(undefined), 2_000); child.on("message", function listener(message) { if (message?.type === "metrics") { clearTimeout(timer); child.off("message", listener); resolve(message); } }); });
    child.send("metrics");
    const metricsMessage = await metricsPromise;
    samples.sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    return { kind, fixture_version: "artifact-pattern/1", decoded_chunk_bytes: bytes, decoded_total_bytes: bytes * concurrency, raw_transport_envelope_bytes: transportBytes, concurrent_uploads: concurrency, transport: "authenticated_unix_socket_child_process_raw_append", client_pacing: "1 ms per 64 KiB", benchmark_arguments_for_case: ["--bytes", String(bytes), "--concurrency", String(concurrency)], elapsed_ms: elapsed, throughput_bytes_per_second: bytes * concurrency / (elapsed / 1000), p95_upload_latency_ms: samples[Math.ceil(samples.length * .95) - 1]?.elapsed_ms ?? 0, p95_sample_count: samples.length, client_rss_start_bytes: clientStartRssBytes, client_peak_rss_bytes: clientPeakRssBytes, client_process_cumulative_max_rss_bytes: process.resourceUsage().maxRSS * 1024, client_rss_samples: clientRssSamples, server_rss_bytes: metricsMessage?.rss_bytes, server_peak_rss_bytes: metricsMessage?.peak_rss_bytes, server_rss_samples: metricsMessage?.rss_samples, server_process_max_rss_bytes: metricsMessage?.process_max_rss_bytes, client_event_loop_delay_max_ms: clientLag.max / 1e6, client_event_loop_delay_mean_ms: clientLag.mean / 1e6, server_event_loop_delay_max_ms: metricsMessage?.event_loop_delay_max_ms, server_event_loop_delay_mean_ms: metricsMessage?.event_loop_delay_mean_ms, publication_failures: failures, upload_samples: samples, transport_limit_samples: limits, json_base64_text_boundary: jsonBoundary, bounded_receive: { chunk_bytes: ARTIFACT_DEPLOYMENT_PROFILE.receive_chunk_bytes, queued_chunks_max: ARTIFACT_DEPLOYMENT_PROFILE.receive_queue_chunks, queued_bytes_max: ARTIFACT_DEPLOYMENT_PROFILE.receive_queue_bytes_max, active_uploads_max: ARTIFACT_DEPLOYMENT_PROFILE.active_uploads_max }, durability: ARTIFACT_DEPLOYMENT_PROFILE.id };
  } finally {
    clearInterval(sample); clientLag.disable(); child.kill("SIGTERM");
    await waitFor(child, "exit", 10_000).catch(() => undefined);
  }
}

function contentHash(kind, byteLength) {
  const digest = createHash("sha256");
  for (let offset = 0; offset < byteLength; offset += 64 * 1024) digest.update(fixtureChunk(kind, offset, Math.min(64 * 1024, byteLength - offset)));
  return `sha256:${digest.digest("hex")}`;
}

function fixtureChunk(kind, offset, length) {
  if (kind === "text") return Buffer.alloc(length, 65);
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++) bytes[index] = (offset + index) % 251;
  return bytes;
}

async function sendBinary(socketPath, header, kind, byteLength) {
  const socket = createConnection(socketPath); let responseText = "";
  const response = new Promise((resolve, reject) => {
    socket.setEncoding("utf8"); socket.on("error", reject);
    socket.on("data", (chunk) => { responseText += chunk; const newline = responseText.indexOf("\n"); if (newline >= 0) resolve(JSON.parse(responseText.slice(0, newline))); });
  });
  await waitFor(socket, "connect");
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(header.length); await writeSocket(socket, prefix); await writeSocket(socket, header);
  for (let offset = 0; offset < byteLength; offset += 64 * 1024) {
    await writeSocket(socket, fixtureChunk(kind, offset, Math.min(64 * 1024, byteLength - offset)));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  socket.end();
  return await response;
}

async function sendBinaryHeaderOnly(socketPath, header) {
  const socket = createConnection(socketPath); let responseText = "";
  const response = new Promise((resolve, reject) => {
    socket.setEncoding("utf8"); socket.on("error", reject);
    socket.on("close", () => reject(new Error("binary Artifact limit probe closed before its response")));
    socket.on("data", (chunk) => { responseText += chunk; const newline = responseText.indexOf("\n"); if (newline >= 0) resolve(JSON.parse(responseText.slice(0, newline))); });
  });
  await waitFor(socket, "connect"); const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(header.length); await writeSocket(socket, prefix); await writeSocket(socket, header);
  socket.end();
  return await response;
}

async function measureTransportLimits(jsonSocket, binarySocket, token, engagement_id, root) {
  const session_id = "limit-check";
  const bound = await rpc(jsonSocket, token, "artifact.session.bind", { engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
  if (!bound.result.ok) throw new Error(`limit-check session bind failed: ${bound.result.error?.code}`);
  const before = await rpc(jsonSocket, token, "artifact.content.list", { engagement_id, session_id, page_size: 10 });
  if (!before.result.ok) throw new Error(`limit-check catalog read failed: ${before.result.error?.code}`);
  const begun = await rpc(jsonSocket, token, "artifact.store.begin", { engagement_id, session_id, payload_kind: "binary", media_type: "application/octet-stream" });
  if (!begun.result.ok) throw new Error(`limit-check upload begin failed: ${begun.result.error?.code}`);
  const binary = await sendBinaryHeaderOnly(binarySocket, Buffer.from(JSON.stringify({ token, operation: "artifact.store.append.binary", request: { engagement_id, session_id, upload_id: begun.result.data.upload_id, ordinal: 0, byte_length: ARTIFACT_CHUNK_BYTES + 1, chunk_hash: `sha256:${"0".repeat(64)}` } })));
  const after = await rpc(jsonSocket, token, "artifact.content.list", { engagement_id, session_id, page_size: 10 });
  if (!after.result.ok) throw new Error(`limit-check catalog verification failed: ${after.result.error?.code}`);
  const socket = createConnection(jsonSocket);
  await waitFor(socket, "connect");
  const closed = waitFor(socket, "close", 5_000);
  socket.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
  await closed;
  const beforeCount = before.result.data.items.length; const afterCount = after.result.data.items.length;
  const noPublication = afterCount === beforeCount;
  if (binary.error?.code !== "validation_error" || !noPublication) throw new Error("decoded over-limit upload was not rejected without publication");
  return { decoded_over_limit_attempt: "artifact.store.append.binary", decoded_over_limit_bytes: ARTIFACT_CHUNK_BYTES + 1, decoded_over_limit_rejected: binary.error.code === "validation_error", catalog_rows_before: beforeCount, catalog_rows_after: afterCount, decoded_over_limit_no_publication: noPublication, ordinary_json_line_over_limit_bytes: 1024 * 1024 + 1, ordinary_json_line_over_limit_closed: true, ordinary_json_close_wait_timeout_ms: 5_000, limit_upload_id: begun.result.data.upload_id };
}

async function measureJsonTextPath(socketPath, token, engagement_id, root, concurrency) {
  const byteLength = 512 * 1024; const bytes = Buffer.alloc(byteLength, 65); const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const cases = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    const session_id = `json-text-${index}`;
    const bound = await rpc(socketPath, token, "artifact.session.bind", { engagement_id, session_id, root: join(root, session_id), mode: "host-session" });
    const begun = await rpc(socketPath, token, "artifact.store.begin", { engagement_id, session_id, payload_kind: "text", media_type: "text/plain", expected_bytes: byteLength, expected_hash: hash });
    const request = { engagement_id, session_id, upload_id: begun.result.data.upload_id, ordinal: 0, data: bytes.toString("base64"), encoding: "base64", chunk_hash: hash };
    const requestEnvelopeBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "taric.dispatch", params: { token, operation: "artifact.store.append", request } }) + "\n");
    const started = performance.now(); const appended = await rpc(socketPath, token, "artifact.store.append", request);
    const committed = await rpc(socketPath, token, "artifact.store.commit", { engagement_id, session_id, upload_id: begun.result.data.upload_id, total_bytes: byteLength, chunk_count: 1, content_hash: hash });
    const read = await rpc(socketPath, token, "artifact.content.read", { engagement_id, session_id, content_ref: committed.result.data.content_ref, length: byteLength, max_response_bytes: byteLength });
    const returnedBytes = Buffer.from(read.result.data.data, "base64");
    return { status: appended.result.ok && committed.result.ok && returnedBytes.length === byteLength ? "published_and_read" : "failed", decoded_chunk_bytes: byteLength, request_envelope_bytes: requestEnvelopeBytes, response_envelope_bytes: Buffer.byteLength(JSON.stringify(read) + "\n"), content_hash: hash, returned_hash: `sha256:${createHash("sha256").update(returnedBytes).digest("hex")}`, elapsed_ms: performance.now() - started, rpc_response_cap_bytes: 1024 * 1024 };
  }));
  return { transport: "authenticated_unix_socket_json_rpc_base64", decoded_chunk_bytes: byteLength, concurrent_uploads: concurrency, cases };
}

async function writeSocket(socket, bytes) {
  if (!socket.write(bytes)) await waitFor(socket, "drain");
}

async function rpc(socketPath, token, operation, request) {
  const socket = createConnection(socketPath); let responseText = "";
  const response = new Promise((resolve, reject) => {
    socket.setEncoding("utf8"); socket.on("error", reject);
    socket.on("data", (chunk) => { responseText += chunk; const newline = responseText.indexOf("\n"); if (newline >= 0) { const response = JSON.parse(responseText.slice(0, newline)); socket.end(); resolve(response); } });
  });
  await waitFor(socket, "connect");
  await writeSocket(socket, Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "taric.dispatch", params: { token, operation, request } })}\n`));
  return await response;
}
