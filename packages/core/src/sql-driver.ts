import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { uuidv7 } from "./identity.js";
import { SCHEMA_VERSION } from "@taric/schemas";
import { ContractValidationError } from "./validation.js";
import { AUTHORITY_SQL_TABLES, AUTHORITY_SQL_INDEXES, AUTHORITY_SQL_INITIAL_METADATA, AUTHORITY_SQL_SCHEMA_VERSION } from "./sql-schema.js";

export type SqlTransactionMode = "read" | "write";
export interface SqlRunResult { changes: number; lastInsertRowid?: number | bigint; }
/** Core owns all transitions. Drivers own connections, clocks and SQL dialects. */
export interface AuthoritySqlDriver {
  readonly backend: "sqlite" | "postgresql";
  readonly filename: string;
  readonly authorityId: string;
  readonly ready: Promise<void>;
  get<Row = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<Row | undefined>;
  all<Row = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<Row[]>;
  run(sql: string, ...values: unknown[]): Promise<SqlRunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(mode: SqlTransactionMode, operation: () => T | Promise<T>): Promise<T>;
  now(): Promise<string>;
  dataVersion(): Promise<number | string>;
  jsonValue(column: string, field: string, type?: "text" | "number" | "boolean"): string;
  dateValue(expression: string): string;
  close(): Promise<void>;
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
interface SqliteScope { driver: SqliteAuthorityDriver; mode: SqlTransactionMode; active: boolean; savepoints: { next: number }; children: ConnectionQueue; }
const sqliteScope = new AsyncLocalStorage<SqliteScope>();

export class SqliteAuthorityDriver implements AuthoritySqlDriver {
  readonly backend = "sqlite" as const;
  readonly filename: string;
  readonly authorityId: string;
  private readonly db: DatabaseSync;
  private readonly queue: ConnectionQueue;
  private initialization?: Promise<void>;
  private closed = false;
  constructor(filename = ":memory:") {
    this.filename = filename;
    this.authorityId = filename === ":memory:" ? `memory:${randomUUID()}` : `sqlite:${resolve(filename)}`;
    this.db = new DatabaseSync(filename);
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
      if ((hasMetadata || hasRecords) && schema?.value !== SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "authority schema version is incompatible");
      const proposals = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='proposals'").get();
      if (proposals) {
        const columns = new Set((this.db.prepare("PRAGMA table_info(proposals)").all() as Array<{ name: string }>).map((column) => column.name));
        if (!["expected_version", "target_id", "client_request_id", "canonical_id", "canonical_version"].every((field) => columns.has(field))) throw new ContractValidationError("unsupported_schema_version", "authority proposal identity format is incompatible");
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
    if (scope?.driver === this && scope.active) return operation();
    await this.ready;
    return this.queue.run(operation);
  }
  async get<Row = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<Row | undefined> { return this.access(() => this.db.prepare(sql).get(...values as SQLInputValue[]) as Row | undefined); }
  async all<Row = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<Row[]> { return this.access(() => this.db.prepare(sql).all(...values as SQLInputValue[]) as Row[]); }
  async run(sql: string, ...values: unknown[]): Promise<SqlRunResult> { return this.access(() => { const result = this.db.prepare(sql).run(...values as SQLInputValue[]); return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }; }); }
  async exec(sql: string): Promise<void> { await this.access(() => this.db.exec(sql)); }
  async transaction<T>(mode: SqlTransactionMode, operation: () => T | Promise<T>): Promise<T> {
    const parent = sqliteScope.getStore();
    if (parent?.driver === this && parent.active) {
      if (mode === "write" && parent.mode === "read") throw new ContractValidationError("conflict", "authority read transaction cannot become a write transaction");
      if (mode === "read") return operation();
      return parent.children.run(async () => {
        if (!parent.active) throw new ContractValidationError("conflict", "authority transaction scope is closed");
        const savepoint = `authority_nested_${parent.savepoints.next++}`;
        const child: SqliteScope = { ...parent, active: true, children: new ConnectionQueue() };
        this.db.exec(`SAVEPOINT ${savepoint}`);
        try { const value = await sqliteScope.run(child, operation); await child.children.drain(); this.db.exec(`RELEASE ${savepoint}`); return value; }
        catch (error) { await child.children.drain(); this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
        finally { child.active = false; }
      });
    }
    await this.ready;
    return this.queue.run(async () => {
      const scope: SqliteScope = { driver: this, mode, active: true, savepoints: { next: 0 }, children: new ConnectionQueue() };
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
  async close(): Promise<void> { await this.queue.run(() => { if (!this.closed) { this.db.close(); this.closed = true; } }); }
}

/** Operator-owned Pool/Client subset: Core never closes the supplied connection. */
export interface PostgresQueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount?: number | null; }
export interface PostgresQueryable {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
  connect?: () => Promise<PostgresQueryable & { release?: () => void }>;
}
interface PostgresScope { driver: PostgresAuthorityDriver; client: PostgresQueryable; mode: SqlTransactionMode; active: boolean; savepoints: { next: number }; children: ConnectionQueue; queries: ConnectionQueue; }
const postgresScope = new AsyncLocalStorage<PostgresScope>();
const postgresClientQueues = new WeakMap<object, ConnectionQueue>();
export function quotePostgresSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new ContractValidationError("validation_error", "invalid PostgreSQL schema name");
  return `"${schema}"`;
}
/** Only parameter markers are adapted; dialect expressions are explicit in Core. */
function postgresParameters(sql: string): string {
  let count = 0; let quoted = false;
  return sql.replace(/''|'|\?/g, (token) => {
    if (token === "''") return token;
    if (token === "'") { quoted = !quoted; return token; }
    return quoted ? token : `$${++count}`;
  });
}
function numericRows<Row>(result: PostgresQueryResult<Row>): PostgresQueryResult<Row> {
  return { ...result, rows: result.rows.map((value) => {
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" && /^(?:seq|count|distinct_count|next|version|generation|commit_seq|read_seq|committed_seq|projected_seq|indexed_seq|id|ordinal|byte_offset|byte_count|sequence|catalog_watermark|index_watermark|canonical_version)$/.test(key) && /^\d+$/.test(item) ? Number(item) : item])) as Row;
  }) };
}
export class PostgresAuthorityDriver implements AuthoritySqlDriver {
  readonly backend = "postgresql" as const;
  readonly filename = ":postgresql:";
  private identity?: string;
  readonly schema: string;
  private readonly quotedSchema: string;
  private readonly clientQueue?: ConnectionQueue;
  private initialization?: Promise<void>;
  private closed = false;
  private initialized = false;
  constructor(readonly queryable: PostgresQueryable, schema = "taric", private readonly migrateSchema = true) {
    this.schema = schema;
    this.quotedSchema = quotePostgresSchema(schema);
    const client = "connection" in queryable || !queryable.connect;
    if (client) { this.clientQueue = postgresClientQueues.get(queryable) ?? new ConnectionQueue(); postgresClientQueues.set(queryable, this.clientQueue); }
  }
  get ready(): Promise<void> { return this.initialization ??= this.initialize(); }
  get authorityId(): string {
    if (!this.identity) throw new ContractValidationError("conflict", "authority identity requires completed initialization");
    return `postgresql:${this.identity}`;
  }
  get migrated(): boolean { return this.initialized; }
  private async acquire(): Promise<PostgresQueryable & { release?: () => void }> {
    if (!this.clientQueue && this.queryable.connect) return this.queryable.connect();
    return this.queryable;
  }
  private async initialize(): Promise<void> {
    await this.inspect(async (client) => {
      if (this.migrateSchema) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`taric-authority:${this.schema}`]);
        const prior = await client.query<{ table_name: string; column_name: string; data_type: string }>("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1", [this.schema]);
        if (prior.rows.length) {
          const metadata = prior.rows.some((row) => row.table_name === "metadata" && row.column_name === "value" && row.data_type === "text");
          const proposals = prior.rows.some((row) => row.table_name === "proposals" && row.column_name === "expected_version");
          if (!metadata || !proposals) throw new ContractValidationError("unsupported_schema_version", "PostgreSQL authority storage format is incompatible");
          const version = (await client.query<{ value: string }>(`SELECT value FROM ${this.quotedSchema}.metadata WHERE key='schema_version'`)).rows[0]?.value;
          const format = (await client.query<{ value: string }>(`SELECT value FROM ${this.quotedSchema}.metadata WHERE key='storage_format'`)).rows[0]?.value;
          if (version !== SCHEMA_VERSION || format !== AUTHORITY_SQL_SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "PostgreSQL authority schema version is incompatible");
        }
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.quotedSchema}`);
        await client.query(`SET LOCAL search_path TO ${this.quotedSchema},pg_catalog`);
        await client.query(AUTHORITY_SQL_TABLES.replace("commit_seq INTEGER PRIMARY KEY AUTOINCREMENT", "commit_seq BIGINT PRIMARY KEY").replace("id INTEGER PRIMARY KEY AUTOINCREMENT", "id BIGSERIAL PRIMARY KEY"));
        await client.query(AUTHORITY_SQL_INDEXES);
        for (const [key, value] of AUTHORITY_SQL_INITIAL_METADATA) await client.query("INSERT INTO metadata(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING", [key, value]);
        await client.query("INSERT INTO metadata(key,value) VALUES('authority_id',$1) ON CONFLICT(key) DO NOTHING", [uuidv7()]);
      } else {
        const schema = (await client.query<{ value: string }>(`SELECT value FROM ${this.quotedSchema}.metadata WHERE key='schema_version'`)).rows[0]?.value;
        const format = (await client.query<{ value: string }>(`SELECT value FROM ${this.quotedSchema}.metadata WHERE key='storage_format'`)).rows[0]?.value;
        if (schema !== SCHEMA_VERSION || format !== AUTHORITY_SQL_SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "PostgreSQL authority schema version is incompatible");
      }
      this.identity = (await client.query<{ value: string }>(`SELECT value FROM ${this.quotedSchema}.metadata WHERE key='authority_id'`)).rows[0]?.value;
      if (!this.identity || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(this.identity)) throw new ContractValidationError("unsupported_schema_version", "PostgreSQL authority identity is missing or incompatible");
    }, "write");
    this.initialized = true;
  }
  /** Readiness can inspect an empty/incompatible schema without migrating it. */
  async inspect<T>(operation: (client: PostgresQueryable) => T | Promise<T>, mode: SqlTransactionMode = "read"): Promise<T> {
    const run = async () => {
      const client = await this.acquire();
      try {
        await client.query(mode === "write" ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const value = await operation(client);
        await client.query("COMMIT");
        return value;
      } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
      finally { client.release?.(); }
    };
    return this.clientQueue ? this.clientQueue.run(run) : run();
  }
  async transaction<T>(mode: SqlTransactionMode, operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new ContractValidationError("conflict", "authority store is closed");
    const parent = postgresScope.getStore();
    if (parent?.driver === this && parent.active) {
      if (mode === "write" && parent.mode === "read") throw new ContractValidationError("conflict", "authority read transaction cannot become a write transaction");
      if (mode === "read") return operation();
      return parent.children.run(async () => {
        if (!parent.active) throw new ContractValidationError("conflict", "authority transaction scope is closed");
        const savepoint = `authority_nested_${parent.savepoints.next++}`;
        const child: PostgresScope = { ...parent, active: true, children: new ConnectionQueue() };
        await parent.queries.run(() => parent.client.query(`SAVEPOINT ${savepoint}`));
        try { const value = await postgresScope.run(child, operation); await child.children.drain(); await parent.queries.drain(); await parent.queries.run(() => parent.client.query(`RELEASE ${savepoint}`)); return value; }
        catch (error) { await child.children.drain(); await parent.queries.drain(); await parent.queries.run(() => parent.client.query(`ROLLBACK TO ${savepoint}`)); await parent.queries.run(() => parent.client.query(`RELEASE ${savepoint}`)); throw error; }
        finally { child.active = false; }
      });
    }
    await this.ready;
    return this.inspect(async (client) => {
      await client.query(`SET LOCAL search_path TO ${this.quotedSchema},pg_catalog`);
      if (mode === "write") await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`taric-authority:${this.schema}`]);
      const scope: PostgresScope = { driver: this, client, mode, active: true, savepoints: { next: 0 }, children: new ConnectionQueue(), queries: new ConnectionQueue() };
      try { return await postgresScope.run(scope, operation); } finally { await scope.children.drain(); await scope.queries.drain(); scope.active = false; }
    }, mode);
  }
  private async query<Row>(sql: string, values: unknown[]): Promise<PostgresQueryResult<Row>> {
    const scope = postgresScope.getStore();
    if (scope?.driver === this && scope.active) return numericRows(await scope.queries.run(() => scope.client.query<Row>(postgresParameters(sql), values)));
    return this.transaction("read", () => this.query<Row>(sql, values));
  }
  async get<Row = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<Row | undefined> { return (await this.query<Row>(sql, values)).rows[0]; }
  async all<Row = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<Row[]> { return (await this.query<Row>(sql, values)).rows; }
  async run(sql: string, ...values: unknown[]): Promise<SqlRunResult> {
    const scope = postgresScope.getStore();
    if (!scope || scope.driver !== this || !scope.active) return this.transaction("write", () => this.run(sql, ...values));
    const result = await this.query(sql, values);
    return { changes: result.rowCount ?? 0 };
  }
  async exec(sql: string): Promise<void> { await this.run(sql); }
  async now(): Promise<string> { const row = await this.get<{ now: Date }>("SELECT clock_timestamp() AS now"); return new Date(row!.now).toISOString(); }
  /** PG must revalidate writer drift: SQL clients may mutate rows outside Core. */
  async dataVersion(): Promise<number | string> { return Number.NaN; }
  jsonValue(column: string, field: string, type: "text" | "number" | "boolean" = "text"): string {
    const value = `(${column}::jsonb->>'${field}')`;
    return type === "number" ? `CAST(${value} AS BIGINT)` : type === "boolean" ? `(CASE ${value} WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE NULL END)` : value;
  }
  dateValue(expression: string): string { return `CAST(${expression} AS TIMESTAMPTZ)`; }
  async close(): Promise<void> { this.closed = true; }
}
