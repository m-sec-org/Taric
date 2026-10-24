import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityStore, AUTHORITY_RUNTIME_SCENARIOS, createAuthorityRuntimeScenarios, runAuthorityRuntimeConformance } from "@taric/core";
import { BunSqliteAuthorityDriver } from "../src/index.js";

type Fixture = Awaited<ReturnType<typeof bunSqliteFixture>>;

async function bunSqliteFixture(directory: string, label: string) {
  const filename = join(directory, `${label}.sqlite`);
  let store = new AuthorityStore(new BunSqliteAuthorityDriver(filename));
  let closed = false;
  return {
    get store() { return store; },
    async restart(current: AuthorityStore) {
      await current.close();
      store = new AuthorityStore(new BunSqliteAuthorityDriver(filename));
      closed = false;
      return store;
    },
    async withAuditFailure(eventType: string, operation: () => Promise<void>) {
      const connection = new Database(filename);
      try {
        connection.exec(`CREATE TRIGGER conformance_event_failure BEFORE INSERT ON events WHEN NEW.event_type='${eventType}' BEGIN SELECT RAISE(ABORT, 'conformance event failure'); END`);
        await operation();
      } finally {
        connection.exec("DROP TRIGGER IF EXISTS conformance_event_failure");
        connection.close();
      }
    },
    async close() { if (!closed) { closed = true; await store.close(); } },
  };
}

/** 12 场景 + backend 方法面一致性；通过即 `runtimeConformancePassed` 为真。 */
test("Bun driver passes all twelve authority runtime conformance domains", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-conformance-"));
  const source = await bunSqliteFixture(directory, "source");
  let destination: Fixture | undefined;
  try {
    const checks = createAuthorityRuntimeScenarios(source.store, join(directory, "content"), async () => {
      destination = await bunSqliteFixture(directory, "destination");
      return destination;
    }, { isolated: true, restart: source.restart, withAuditFailure: source.withAuditFailure });
    const evidence: Record<string, readonly string[]> = {};
    for (const id of AUTHORITY_RUNTIME_SCENARIOS) {
      evidence[id] = await checks[id]();
      if (evidence[id].length === 0) throw new Error(`scenario ${id} returned no evidence`);
    }
    const report = await runAuthorityRuntimeConformance(source.store, Object.fromEntries(
      AUTHORITY_RUNTIME_SCENARIOS.map((id) => [id, () => evidence[id] ?? []]),
    ));
    if (!report.passed) throw new Error(JSON.stringify(report));
    // 存档钩子：TARIC_CONFORMANCE_REPORT=<path> 时写出可提交的验收报告（scripts/benchmark-bun-driver.mjs 消费）。
    if (process.env.TARIC_CONFORMANCE_REPORT) {
      await writeFile(process.env.TARIC_CONFORMANCE_REPORT, `${JSON.stringify({ version: "bun-driver-conformance/1", runtime: `bun ${Bun.version}`, generated_at: new Date().toISOString(), report }, null, 2)}\n`);
    }
  } finally {
    await source.close();
    if (destination) await destination.close();
    await rm(directory, { recursive: true, force: true });
  }
});
