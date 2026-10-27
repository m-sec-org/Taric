import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { SCHEMA_VERSION } from "@taric/schemas";
import { compatibilityDiagnosticDetails, ContractValidationError, AUTHORITY_SQL_TABLES, AUTHORITY_SQL_INDEXES, AUTHORITY_SQL_INITIAL_METADATA, AUTHORITY_SQL_SCHEMA_VERSION, type AuthoritySqlDriver, type SqlMetrics, type SqlMetricsSnapshot, type SqlRunResult, type SqlTransactionMode } from "@taric/core";

function statementCount(sql: string): number {
  return Math.max(1, sql.split(";").map((part) => part.trim()).filter(Boolean).length);
}

class ConnectionQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  drain(): Promise<void> { return this.tail; }
}
const sqliteQueues = new Map<string, ConnectionQueue>();
interface BunSqliteScope { driver: BunSqliteAuthorityDriver; mode: SqlTransactionMode; active: boolean; savepoints: { next: number }; children: ConnectionQueue; }
const sqliteScope = new AsyncLocalStorage<BunSqliteScope>();

/**
 * `bun:sqlite` 参考驱动：与 Core 自带的 node:sqlite 驱动同构（WAL、
 * busy_timeout=5000、savepoint 嵌套事务、AsyncLocalStorage 作用域、
 * `PRAGMA data_version` + `total_changes()` 水位），仅替换数据库构造与
 * 类型适配。方言声明为 "sqlite"，Core 的 SQL 不感知驱动差异。
 */
export class BunSqliteAuthorityDriver implements AuthoritySqlDriver {
  readonly backend = "sqlite" as const;
  readonly filename: string;
  readonly authorityId: string;
  private readonly db: Database;
  private readonly queue: ConnectionQueue;
  private readonly sqlMetrics: SqlMetrics = { statements: 0, rows_returned: 0, rows_affected: 0, queue_wait_ms: 0, sql_elapsed_ms: 0 };
  private initialization?: Promise<void>;
  private closed = false;
  constructor(filename = ":memory:") {
    this.filename = filename;
    this.authorityId = filename === ":memory:" ? `memory:${randomUUID()}` : `sqlite:${resolve(filename)}`;
    this.db = new Database(filename);
    if (filename === ":memory:") this.queue = new ConnectionQueue();
    else {
      const key = resolve(filename);
      this.queue = sqliteQueues.get(key) ?? new ConnectionQueue();
      sqliteQueues.set(key, this.queue);
    }
  }
  get ready(): Promise<void> {
    return this.initialization ??= this.queue.run(() => {
      const hasMetadata = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get());
      const hasRecords = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").get());
      const schema = hasMetadata ? this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as { value?: string } | undefined : undefined;
      if ((hasMetadata || hasRecords) && schema?.value !== SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "authority schema version is incompatible", compatibilityDiagnosticDetails({ backend: "sqlite", expected: { schema_version: SCHEMA_VERSION }, ...(schema?.value ? { observed: { schema_version: schema.value } } : {}), failed_marker: "metadata.schema_version" }));
      const storageFormat = hasMetadata ? this.db.prepare("SELECT value FROM metadata WHERE key='storage_format'").get() as { value?: string } | undefined : undefined;
      if (hasMetadata && storageFormat?.value !== AUTHORITY_SQL_SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "authority storage format is incompatible", compatibilityDiagnosticDetails({ backend: "sqlite", expected: { storage_format: AUTHORITY_SQL_SCHEMA_VERSION }, ...(storageFormat?.value ? { observed: { storage_format: storageFormat.value } } : {}), failed_marker: "metadata.storage_format" }));
      const proposals = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='proposals'").get();
      if (proposals) {
        const columns = new Set((this.db.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string }>).map((column) => column.name));
        const required = ["expected_version", "target_id", "client_request_id", "canonical_id", "canonical_version"];
        const missing = required.filter((field) => !columns.has(field));
        if (missing.length) throw new ContractValidationError("unsupported_schema_version", "authority proposal identity format is incompatible", compatibilityDiagnosticDetails({ backend: "sqlite", expected: { proposal_identity: "v1" }, observed: { proposal_identity: "legacy" }, failed_marker: "proposals.identity", missing }));
      }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(AUTHORITY_SQL_TABLES);
        const columns = this.db.prepare("PRAGMA table_info(artifact_catalog)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "media_type")) this.db.exec("ALTER TABLE artifact_catalog ADD COLUMN media_type TEXT");
        this.db.exec(AUTHORITY_SQL_INDEXES);
        for (const [key, value] of AUTHORITY_SQL_INITIAL_METADATA) this.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(key, value);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
  }
  private async access<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new ContractValidationError("conflict", "authority store is closed");
    const scope = sqliteScope.getStore();
    if (scope?.driver === this && scope.active) {
      const started = performance.now();
      try { return await operation(); } finally { this.sqlMetrics.sql_elapsed_ms += performance.now() - started; }
    }
    await this.ready;
    const queued = performance.now();
    return this.queue.run(async () => {
      this.sqlMetrics.queue_wait_ms += performance.now() - queued;
      const started = performance.now();
      try { return await operation(); } finally { this.sqlMetrics.sql_elapsed_ms += performance.now() - started; }
    });
  }
  async get<Row = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<Row | undefined> {
    return this.access(() => { this.sqlMetrics.statements += statementCount(sql); const row = this.db.prepare(sql).get(...values as SQLQueryBindings[]) as Row | undefined; if (row) this.sqlMetrics.rows_returned++; return row; });
  }
  async all<Row = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<Row[]> {
    return this.access(() => { this.sqlMetrics.statements += statementCount(sql); const rows = this.db.prepare(sql).all(...values as SQLQueryBindings[]) as Row[]; this.sqlMetrics.rows_returned += rows.length; return rows; });
  }
  async run(sql: string, ...values: unknown[]): Promise<SqlRunResult> {
    return this.access(() => { this.sqlMetrics.statements += statementCount(sql); const result = this.db.prepare(sql).run(...values as SQLQueryBindings[]); const changes = Number(result.changes); this.sqlMetrics.rows_affected += changes; return { changes, lastInsertRowid: result.lastInsertRowid }; });
  }
  async exec(sql: string): Promise<void> { await this.access(() => { this.sqlMetrics.statements += statementCount(sql); this.db.exec(sql); }); }
  async transaction<T>(mode: SqlTransactionMode, operation: () => T | Promise<T>): Promise<T> {
    const parent = sqliteScope.getStore();
    if (parent?.driver === this && parent.active) {
      if (mode === "write" && parent.mode === "read") throw new ContractValidationError("conflict", "authority read transaction cannot become a write transaction");
      if (mode === "read") return operation();
      return parent.children.run(async () => {
        if (!parent.active) throw new ContractValidationError("conflict", "authority transaction scope is closed");
        const savepoint = `authority_nested_${parent.savepoints.next++}`;
        const child: BunSqliteScope = { ...parent, active: true, children: new ConnectionQueue() };
        this.db.exec(`SAVEPOINT ${savepoint}`);
        try { const value = await sqliteScope.run(child, operation); await child.children.drain(); this.db.exec(`RELEASE ${savepoint}`); return value; }
        catch (error) { await child.children.drain(); this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
        finally { child.active = false; }
      });
    }
    await this.ready;
    const queued = performance.now();
    return this.queue.run(async () => {
      this.sqlMetrics.queue_wait_ms += performance.now() - queued;
      const scope: BunSqliteScope = { driver: this, mode, active: true, savepoints: { next: 0 }, children: new ConnectionQueue() };
      this.db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
      try { const value = await sqliteScope.run(scope, operation); await scope.children.drain(); this.db.exec("COMMIT"); return value; }
      catch (error) { await scope.children.drain(); this.db.exec("ROLLBACK"); throw error; }
      finally { scope.active = false; }
    });
  }
  async now(): Promise<string> { return new Date().toISOString(); }
  async dataVersion(): Promise<string> {
    const version = Number((await this.get<{ data_version: number }>("PRAGMA data_version"))?.data_version ?? -1);
    const changes = Number((await this.get<{ total_changes: number }>("SELECT total_changes() AS total_changes"))?.total_changes ?? -1);
    return `${version}:${changes}`;
  }
  jsonValue(column: string, field: string): string { return `json_extract(${column},'$.${field}')`; }
  dateValue(expression: string): string { return `julianday(${expression})`; }
  metrics(): SqlMetricsSnapshot { return { ...this.sqlMetrics }; }
  async close(): Promise<void> { await this.queue.run(() => { if (!this.closed) { this.db.close(); this.closed = true; } }); }
}
