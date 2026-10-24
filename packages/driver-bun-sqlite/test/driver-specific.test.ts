import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqliteAuthorityDriver } from "../src/index.js";

const incompatible = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "unsupported_schema_version");
const conflict = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "conflict");

/** 驱动层专项（能力提升提案 RM-1 裁决：12 场景是必要条件，不是驱动认证）。 */

test("driver: write inside an active read transaction fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-driver-"));
  const driver = new BunSqliteAuthorityDriver(join(directory, "nested.sqlite"));
  try {
    let rejected = false;
    await driver.transaction("read", async () => {
      try { await driver.transaction("write", async () => "must not happen"); }
      catch (error) { if (!conflict(error)) throw error; rejected = true; }
    });
    if (!rejected) throw new Error("nested write inside read was not rejected");
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});

test("driver: savepoint rollback undoes only the nested scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-driver-"));
  const driver = new BunSqliteAuthorityDriver(join(directory, "savepoint.sqlite"));
  try {
    await driver.ready;
    await driver.transaction("write", async () => {
      await driver.run("INSERT INTO metadata(key,value) VALUES('drv_outer','kept')");
      try {
        await driver.transaction("write", async () => {
          await driver.run("INSERT INTO metadata(key,value) VALUES('drv_inner','rolled-back')");
          throw new Error("intentional inner failure");
        });
      } catch { /* 预期回滚 */ }
    });
    const outer = await driver.get<{ value: string }>("SELECT value FROM metadata WHERE key='drv_outer'");
    const inner = await driver.get<{ value: string }>("SELECT value FROM metadata WHERE key='drv_inner'");
    if (outer?.value !== "kept") throw new Error("outer write lost after inner rollback");
    if (inner) throw new Error("inner write survived its savepoint rollback");
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});

test("driver: now() returns a parseable ISO timestamp", async () => {
  const driver = new BunSqliteAuthorityDriver();
  try {
    const now = await driver.now();
    if (Number.isNaN(Date.parse(now))) throw new Error(`now() is not ISO: ${now}`);
  } finally { await driver.close(); }
});

test("driver: initialization creates the authority schema and metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-driver-"));
  const driver = new BunSqliteAuthorityDriver(join(directory, "init.sqlite"));
  try {
    await driver.ready;
    const format = await driver.get<{ value: string }>("SELECT value FROM metadata WHERE key='storage_format'");
    if (!format?.value?.startsWith("authority-sql/")) throw new Error(`unexpected storage format: ${format?.value}`);
    const records = await driver.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='records'");
    if (!records) throw new Error("records table missing after initialization");
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});

test("driver: incompatible persisted schema version fails closed on open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-driver-"));
  const filename = join(directory, "stale.sqlite");
  const setup = new BunSqliteAuthorityDriver(filename);
  await setup.ready;
  await setup.close();
  const connection = new Database(filename);
  connection.exec("UPDATE metadata SET value='0.0.0' WHERE key='schema_version'");
  connection.close();
  const stale = new BunSqliteAuthorityDriver(filename);
  try {
    let rejected = false;
    try { await stale.ready; } catch (error) { if (!incompatible(error)) throw error; rejected = true; }
    if (!rejected) throw new Error("incompatible schema version was not rejected");
  } finally { await stale.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
});

test("driver: state survives close and reopen on the same file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-driver-"));
  const filename = join(directory, "restart.sqlite");
  const first = new BunSqliteAuthorityDriver(filename);
  await first.ready;
  await first.run("INSERT INTO metadata(key,value) VALUES('drv_restart','survives')");
  await first.close();
  const second = new BunSqliteAuthorityDriver(filename);
  try {
    await second.ready;
    const row = await second.get<{ value: string }>("SELECT value FROM metadata WHERE key='drv_restart'");
    if (row?.value !== "survives") throw new Error("state lost across restart");
  } finally { await second.close(); await rm(directory, { recursive: true, force: true }); }
});

test("driver: dataVersion watermark advances across commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-driver-"));
  const driver = new BunSqliteAuthorityDriver(join(directory, "watermark.sqlite"));
  try {
    await driver.ready;
    const before = await driver.dataVersion();
    await driver.run("INSERT INTO metadata(key,value) VALUES('drv_watermark','1')");
    const after = await driver.dataVersion();
    if (before === after) throw new Error(`dataVersion did not advance: ${before}`);
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});

test("driver: two file-mode instances serialize through the shared queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-bun-driver-"));
  const filename = join(directory, "shared.sqlite");
  const a = new BunSqliteAuthorityDriver(filename);
  const b = new BunSqliteAuthorityDriver(filename);
  try {
    await Promise.all([
      a.ready.then(() => a.run("INSERT INTO metadata(key,value) VALUES('drv_shared_a','1')")),
      b.ready.then(() => b.run("INSERT INTO metadata(key,value) VALUES('drv_shared_b','1')")),
    ]);
    const count = await a.get<{ n: number }>("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'drv_shared_%'");
    if (count?.n !== 2) throw new Error(`shared-file writes lost: ${count?.n}`);
  } finally { await a.close(); await b.close(); await rm(directory, { recursive: true, force: true }); }
});
