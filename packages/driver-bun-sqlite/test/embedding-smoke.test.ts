import { test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, createCoreService, createPrincipal } from "@taric/core";
import { BunSqliteAuthorityDriver } from "../src/index.js";

/**
 * Bun 宿主进程内嵌入冒烟：直接以注入驱动构造 authority（openRuntimeService
 * 的 sqlite 路径固定构造 node:sqlite 驱动，Bun 宿主走本测试所示的直连形态），
 * 跑通 init → status → audit.verify 的最小 A/B 路径。
 */
test("Bun host embeds Core in-process over the injected driver", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-smoke-"));
  const store = new AuthorityStore(new BunSqliteAuthorityDriver(join(directory, "authority.sqlite")));
  const service = await createCoreService(store, join(directory, "content"));
  try {
    const operator = createPrincipal("operator", "bun-host");
    const initialized = await service.dispatch("engagement.init", operator, { name: "bun-smoke", scope: { allowed_targets: ["https://smoke.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:bun-smoke" } });
    if (!initialized.ok) throw new Error(JSON.stringify(initialized));
    const engagementId = (initialized.data as { id: string }).id;
    const host = createPrincipal("host", "bun-host", engagementId);
    const status = await service.dispatch("engagement.status", host, { engagement_id: engagementId });
    if (!status.ok) throw new Error(JSON.stringify(status));
    const verified = await service.dispatch("audit.verify", operator, {});
    if (!verified.ok) throw new Error(JSON.stringify(verified));
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bun embedding ingests one explicitly authorized opaque spool file and verifies identical bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-ingest-"));
  const contentRoot = join(directory, "content");
  const sessionRoot = join(contentRoot, "session");
  const source = join(sessionRoot, "opaque.bin");
  const bytes = Buffer.from([0, 255, 1, 254, 13, 10, 0, 42]);
  const store = new AuthorityStore(new BunSqliteAuthorityDriver(join(directory, "authority.sqlite")));
  const service = await createCoreService(store, contentRoot);
  try {
    const operator = createPrincipal("operator", "bun-ingest-host");
    const initialized = await service.dispatch("engagement.init", operator, { name: "bun-ingest", scope: { allowed_targets: ["https://spool.invalid"], excluded_targets: [], rules_of_engagement_ref: "roe:bun-ingest" } });
    if (!initialized.ok) throw new Error(JSON.stringify(initialized));
    const engagementId = (initialized.data as { id: string }).id;
    const host = createPrincipal("host", "bun-ingest-host", engagementId, ["content_read"]);
    const binding = await service.dispatch("artifact.session.bind", host, { engagement_id: engagementId, session_id: "bun-task", root: sessionRoot, mode: "host-session" });
    if (!binding.ok) throw new Error(JSON.stringify(binding));
    await writeFile(source, bytes);
    const request = { engagement_id: engagementId, session_id: "bun-task", path: source, authorize_spool_access: true as const, payload_kind: "binary" as const, media_type: "application/octet-stream", delete_source: true, idempotency_key: "bun-ingest-retry" };
    const ingested = await service.dispatch("artifact.ingest_file", host, request);
    if (!ingested.ok) throw new Error(JSON.stringify(ingested));
    const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (ingested.data.content_hash !== expectedHash) throw new Error(`Bun ingest hash differs from source bytes: ${String(ingested.data.content_hash)}`);
    if (ingested.data.source_deleted !== false) throw new Error(`Bun runtime reported an unsupported identity-safe deletion: ${JSON.stringify(ingested.data)}`);
    const retry = await service.dispatch("artifact.ingest_file", host, request);
    if (!retry.ok || retry.data.content_ref !== ingested.data.content_ref) throw new Error(`idempotent ingest changed its content reference: ${JSON.stringify(retry)}`);
    const result = await service.dispatch("artifact.content.read", host, { engagement_id: engagementId, session_id: "bun-task", content_ref: String(ingested.data.content_ref), offset: 0, length: bytes.length });
    if (!result.ok) throw new Error(JSON.stringify(result));
    if (!Buffer.from(String(result.data.data), "base64").equals(bytes)) throw new Error("Bun ingested payload differs from the authorized source bytes");
    if (!(await readFile(source)).equals(bytes)) throw new Error("Taric changed or deleted the source bytes");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
