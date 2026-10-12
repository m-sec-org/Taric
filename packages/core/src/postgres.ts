import { createHash } from "node:crypto";
import { uuidv7 } from "./identity.js";
import { ContractValidationError, validateAuthorityReferences, validateCanonicalRecord } from "./validation.js";
import type { CanonicalRecord, DoctorReport, ReadSnapshot, TrustLevel } from "./store.js";
import { SCHEMA_VERSION } from "@taric/schemas";

/**
 * A deliberately small subset of the node-postgres API.  Keeping this type in
 * Core means the default SQLite installation does not load or depend on `pg`.
 * Pool and Client both satisfy this interface.
 */
export interface PostgresQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface PostgresQueryable {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
  connect?: () => Promise<PostgresQueryable & { release?: () => void }>;
}

export type PostgresBackendProfile = "single_host_sqlite" | "multi_host_authority";

export interface PostgresAuthorityOptions {
  profile?: PostgresBackendProfile;
  schema?: string;
  policyDigest?: string;
  leaseMode?: "server_expiry_fencing";
  /** Set false only for a caller that has already run migrations. */
  migrate?: boolean;
}

export interface PostgresLease {
  run_id: string;
  work_item_id: string;
  engagement_id: string;
  status: string;
  owner: { host_id: string; agent_id: string };
  generation: number;
  attempt_ref: string;
  lease_expires_at: string;
  heartbeat_at: string;
  read_seq: number;
}

export interface PostgresPinnedSnapshot extends ReadSnapshot {
  generation: number;
  indexed_seq: number;
  watermark: { committed_seq: number; projected_seq: number; indexed_seq: number };
  snapshot_id: string;
}

export interface PostgresBackendManifest {
  backend: "postgresql";
  profile: "multi_host_authority";
  enabled: boolean;
  schema_version: string;
  supported_postgres: { minimum: string; maximum: string };
  policy_digest?: string;
  lease_mode: "server_expiry_fencing";
}

export const POSTGRES_SCHEMA_VERSION = "1.0.0" as const;
export const POSTGRES_SUPPORTED_VERSIONS = Object.freeze({ minimum: "14", maximum: "18" });
export const POSTGRES_SCHEMA_NAME = "taric";

/** Migrations are plain SQL so operators can review and run them offline. */
export const POSTGRES_MIGRATIONS: readonly { version: string; sql: string }[] = Object.freeze([
  {
    version: POSTGRES_SCHEMA_VERSION,
    sql: `
CREATE SCHEMA IF NOT EXISTS taric;
CREATE SEQUENCE IF NOT EXISTS taric.display_sequence AS bigint START WITH 1 INCREMENT BY 1;
CREATE TABLE IF NOT EXISTS taric.metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO taric.metadata(key, value) VALUES ('schema_version', '"1.0.0"'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO taric.metadata(key, value) VALUES ('indexed_seq', '0'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO taric.metadata(key, value) VALUES ('commit_sequence', '0'::jsonb)
  ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS taric.records (
  id text PRIMARY KEY,
  engagement_id text NOT NULL,
  kind text NOT NULL,
  trust_level text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  display_id text UNIQUE,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS records_engagement_idx ON taric.records(engagement_id, id);
CREATE TABLE IF NOT EXISTS taric.record_versions (
  id text NOT NULL,
  commit_seq bigint NOT NULL,
  engagement_id text NOT NULL,
  trust_level text NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (id, commit_seq)
);
CREATE INDEX IF NOT EXISTS record_versions_engagement_idx ON taric.record_versions(engagement_id, commit_seq, id);
CREATE TABLE IF NOT EXISTS taric.events (
  commit_seq bigint PRIMARY KEY CHECK (commit_seq > 0),
  event_id text UNIQUE NOT NULL,
  event_type text NOT NULL,
  subject_id text,
  payload jsonb NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS taric.outbox (
  commit_seq bigint PRIMARY KEY REFERENCES taric.events(commit_seq),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS taric.idempotency (
  key text PRIMARY KEY,
  operation text NOT NULL,
  principal text NOT NULL,
  engagement_id text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS taric.operation_markers (
  operation_id text PRIMARY KEY,
  event_id text UNIQUE NOT NULL REFERENCES taric.events(event_id),
  engagement_id text,
  commit_seq bigint UNIQUE NOT NULL REFERENCES taric.events(commit_seq),
  kind text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS taric.work_leases (
  run_id text PRIMARY KEY,
  work_item_id text NOT NULL,
  engagement_id text NOT NULL,
  status text NOT NULL,
  owner_host text NOT NULL,
  owner_agent text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  attempt_ref text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  read_seq bigint NOT NULL DEFAULT 0,
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS work_leases_active_item_idx
  ON taric.work_leases(work_item_id)
  WHERE status NOT IN ('completed', 'failed', 'cancelled', 'lost');
CREATE TABLE IF NOT EXISTS taric.attempts (
  attempt_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES taric.work_leases(run_id),
  generation bigint NOT NULL,
  owner_host text NOT NULL,
  owner_agent text NOT NULL,
  status text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_run_generation_idx ON taric.attempts(run_id, generation);
CREATE TABLE IF NOT EXISTS taric.reader_pins (
  snapshot_id text PRIMARY KEY,
  engagement_id text NOT NULL,
  generation bigint NOT NULL,
  read_seq bigint NOT NULL,
  committed_seq bigint NOT NULL,
  projected_seq bigint NOT NULL,
  indexed_seq bigint NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL
);`,
  },
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function asNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function isoTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function quoteSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new ContractValidationError("validation_error", "invalid PostgreSQL schema name");
  return `"${schema}"`;
}

/**
 * PostgreSQL authority implementation.  It intentionally owns only storage
 * invariants; admission and domain policy remain in Core's shared code.
 */
export class PostgresAuthorityStore {
  readonly #queryable: PostgresQueryable;
  readonly #options: Required<Pick<PostgresAuthorityOptions, "profile" | "schema" | "leaseMode" | "migrate">> & Pick<PostgresAuthorityOptions, "policyDigest">;
  readonly #schema: string;
  #migrated = false;

  constructor(queryable: PostgresQueryable, options: PostgresAuthorityOptions = {}) {
    if (!queryable || typeof queryable.query !== "function") throw new ContractValidationError("validation_error", "a PostgreSQL query client is required");
    if (options.profile !== "multi_host_authority") throw new ContractValidationError("conflict", "PostgreSQL backend requires the explicit multi_host_authority profile");
    this.#queryable = queryable;
    this.#options = { profile: options.profile, schema: options.schema ?? POSTGRES_SCHEMA_NAME, leaseMode: options.leaseMode ?? "server_expiry_fencing", migrate: options.migrate ?? true, policyDigest: options.policyDigest };
    this.#schema = quoteSchema(this.#options.schema);
    if (!this.#options.migrate) this.#migrated = true;
  }

  manifest(): PostgresBackendManifest {
    return { backend: "postgresql", profile: "multi_host_authority", enabled: this.#migrated, schema_version: POSTGRES_SCHEMA_VERSION, supported_postgres: POSTGRES_SUPPORTED_VERSIONS, policy_digest: this.#options.policyDigest, lease_mode: this.#options.leaseMode };
  }

  private async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = [], client: PostgresQueryable = this.#queryable): Promise<PostgresQueryResult<Row>> {
    const scoped = text.replaceAll("CREATE SCHEMA IF NOT EXISTS taric;", `CREATE SCHEMA IF NOT EXISTS ${this.#schema};`).replaceAll("taric.", `${this.#schema}.`);
    return client.query<Row>(scoped, values);
  }

  private async withTransaction<T>(operation: (client: PostgresQueryable) => Promise<T>): Promise<T> {
    const owned = this.#queryable.connect ? await this.#queryable.connect() : this.#queryable;
    try {
      await owned.query("BEGIN");
      // This lock serializes hash-chain construction and gives all hosts one
      // authority commit order while identity/display sequences remain server side.
      await owned.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["taric:authority"]);
      const result = await operation({ query: (text, values) => this.query(text, values, owned) });
      await owned.query("COMMIT");
      return result;
    } catch (error) {
      try { await owned.query("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    } finally {
      if (owned !== this.#queryable) (owned as PostgresQueryable & { release?: () => void }).release?.();
    }
  }

  private async appendEvent(client: PostgresQueryable, eventType: string, subjectId: string, payload: Record<string, unknown>): Promise<number> {
    const previous = await client.query<{ hash: string }>(`SELECT hash FROM taric.events ORDER BY commit_seq DESC LIMIT 1`);
    const prevHash = previous.rows[0]?.hash ?? null;
    const eventId = uuidv7();
    const createdAt = new Date().toISOString();
    const eventHash = digest({ event_id: eventId, event_type: eventType, subject_id: subjectId, payload, prev_hash: prevHash, created_at: createdAt });
    const sequence = await client.query<{ value: unknown }>(`UPDATE taric.metadata SET value=to_jsonb((value #>> '{}')::bigint + 1) WHERE key='commit_sequence' RETURNING value`);
    const commitSeq = asNumber(sequence.rows[0]?.value);
    await client.query(`INSERT INTO taric.events(commit_seq,event_id,event_type,subject_id,payload,prev_hash,hash,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, [commitSeq, eventId, eventType, subjectId, JSON.stringify(payload), prevHash, eventHash, createdAt]);
    await client.query(`INSERT INTO taric.outbox(commit_seq,status,updated_at) VALUES($1,'pending',$2)`, [commitSeq, createdAt]);
    await client.query(`INSERT INTO taric.operation_markers(operation_id,event_id,engagement_id,commit_seq,kind,input_hash,status,updated_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7)`, [`operation:${eventId}`, eventId, typeof payload.engagement_id === "string" ? payload.engagement_id : null, commitSeq, eventType, digest({ event_type: eventType, subject_id: subjectId, payload }), createdAt]);
    return commitSeq;
  }

  async migrate(): Promise<void> {
    if (this.#migrated) return;
    for (const migration of POSTGRES_MIGRATIONS) {
      await this.query(migration.sql);
    }
    const current = await this.query<{ value: unknown }>(`SELECT value FROM taric.metadata WHERE key='schema_version'`);
    const version = parseJson(current.rows[0]?.value);
    if (version !== POSTGRES_SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", `unsupported PostgreSQL authority schema version: ${String(version)}`);
    this.#migrated = true;
  }

  async close(): Promise<void> {
    const candidate = this.#queryable as PostgresQueryable & { end?: () => Promise<void> };
    if (candidate.end) await candidate.end();
  }

  async health(): Promise<{ available: true; backend: "postgresql"; schema_version: string; committed_seq: number; projected_seq: number; indexed_seq: number }> {
    await this.migrate();
    const rows = await this.query<{ committed_seq: unknown; projected_seq: unknown; indexed_seq: unknown }>(`
      SELECT
        COALESCE((SELECT max(commit_seq) FROM taric.events), 0) AS committed_seq,
        COALESCE((SELECT min(commit_seq) - 1 FROM taric.outbox WHERE status <> 'applied'), COALESCE((SELECT max(commit_seq) FROM taric.events), 0)) AS projected_seq,
        COALESCE((SELECT (value #>> '{}')::bigint FROM taric.metadata WHERE key='indexed_seq'), 0) AS indexed_seq`);
    const row = rows.rows[0] ?? {};
    return { available: true, backend: "postgresql", schema_version: POSTGRES_SCHEMA_VERSION, committed_seq: asNumber(row.committed_seq), projected_seq: asNumber(row.projected_seq), indexed_seq: asNumber(row.indexed_seq) };
  }

  /** Atomically commit a canonical record, audit event, outbox row and marker. */
  async commit(record: CanonicalRecord, trustLevel: TrustLevel = "L1", idempotencyKey?: string, context: { operation?: string; principal?: string; engagement_id?: string; expected_version?: number } = {}): Promise<CanonicalRecord> {
    await this.migrate();
    if (!record || typeof record.id !== "string" || typeof record.engagement_id !== "string") throw new ContractValidationError("validation_error", "canonical record requires id and engagement_id");
    if (record.display_id !== undefined || record.trust_level !== undefined) throw new ContractValidationError("validation_error", "caller cannot set PostgreSQL-managed display_id or trust_level");
    const operation = context.operation ?? "record.commit";
    const principal = context.principal ?? "core";
    const engagementId = context.engagement_id ?? record.engagement_id;
    const requestHash = digest(record);
    return this.withTransaction(async (client) => {
      if (idempotencyKey) {
        const prior = await client.query<{ result: unknown; operation: string; principal: string; engagement_id: string; request_hash: string }>(`SELECT result,operation,principal,engagement_id,request_hash FROM taric.idempotency WHERE key=$1`, [idempotencyKey]);
        const row = prior.rows[0];
        if (row) {
          if (row.request_hash !== requestHash || row.operation !== operation || row.principal !== principal || row.engagement_id !== engagementId) throw new ContractValidationError("idempotency_conflict", "idempotency key is bound to another request");
          return parseJson(row.result) as CanonicalRecord;
        }
      }
      const existingResult = await client.query<{ version: unknown; display_id: string | null; body: unknown }>(`SELECT version,display_id,body FROM taric.records WHERE id=$1 FOR UPDATE`, [record.id]);
      const existing = existingResult.rows[0];
      const expected = context.expected_version;
      if (existing && (expected === undefined || asNumber(existing.version) !== expected)) throw new ContractValidationError("stale_version", "canonical update requires the current expected version");
      if (!existing && expected !== undefined && expected !== 0) throw new ContractValidationError("stale_version", "canonical create expected version must be zero");
      if (existing) {
        const previous = parseJson(existing.body) as CanonicalRecord;
        if (previous.engagement_id !== record.engagement_id || String(previous.kind ?? "record") !== String(record.kind ?? "record")) throw new ContractValidationError("conflict", "canonical engagement ownership and kind are immutable");
      }
      const version = asNumber(existing?.version) + 1;
      const display = existing?.display_id ?? `TAR-${String(asNumber((await client.query<{ value: unknown }>(`SELECT nextval('${this.#schema}.display_sequence') AS value`)).rows[0]?.value)).padStart(6, "0")}`;
      const now = new Date().toISOString();
      if (record.schema_version !== undefined && record.schema_version !== SCHEMA_VERSION) throw new ContractValidationError("unsupported_schema_version", "record schema version is not supported");
      const normalized = { schema_version: SCHEMA_VERSION, created_at: now, provenance: { host_id: "taric-postgresql", producer_id: principal, source_kind: "host" }, ...record } as CanonicalRecord;
      validateCanonicalRecord(normalized, trustLevel);
      const committed = { ...normalized, version, trust_level: trustLevel, display_id: display } as CanonicalRecord;
      await client.query(`INSERT INTO taric.records(id,engagement_id,kind,trust_level,version,display_id,body,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
        ON CONFLICT(id) DO UPDATE SET body=excluded.body,trust_level=excluded.trust_level,version=excluded.version,updated_at=excluded.updated_at`,
        [record.id, record.engagement_id, String(record.kind ?? "record"), trustLevel, version, display, JSON.stringify(committed), now]);
      const payload = { engagement_id: record.engagement_id, version, trust_level: trustLevel, before_hash: existing ? digest(parseJson(existing.body)) : null, after_hash: digest(committed), actor_id: principal };
      const commitSeq = await this.appendEvent(client, "record.commit", record.id, payload);
      await client.query(`INSERT INTO taric.record_versions(id,commit_seq,engagement_id,trust_level,body) VALUES($1,$2,$3,$4,$5::jsonb)`, [record.id, commitSeq, record.engagement_id, trustLevel, JSON.stringify(committed)]);
      const result = { ...committed, commit_seq: commitSeq };
      if (idempotencyKey) await client.query(`INSERT INTO taric.idempotency(key,operation,principal,engagement_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [idempotencyKey, operation, principal, engagementId, requestHash, JSON.stringify(result)]);
      return result;
    });
  }

  async compareAndSet(id: string, expectedVersion: number, patch: Record<string, unknown>, trustLevel: TrustLevel = "L1"): Promise<CanonicalRecord> {
    await this.migrate();
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new ContractValidationError("validation_error", "expected version must be a positive integer");
    const result = await this.query<{ version: unknown; body: unknown }>(`SELECT version,body FROM taric.records WHERE id=$1`, [id]);
    const row = result.rows[0];
    if (!row || asNumber(row.version) !== expectedVersion) throw new ContractValidationError("stale_version", "canonical update requires the current expected version");
    const current = parseJson(row.body) as CanonicalRecord;
    const forbidden = ["id", "engagement_id", "kind", "version", "trust_level", "display_id", "commit_seq"];
    if (forbidden.some((field) => field in patch)) throw new ContractValidationError("validation_error", "compare-and-set patch cannot change Core-managed identity fields");
    const candidate = { ...current, ...patch };
    delete candidate.version;
    delete candidate.trust_level;
    delete candidate.display_id;
    delete candidate.commit_seq;
    return this.commit(candidate, trustLevel, undefined, { expected_version: expectedVersion, engagement_id: current.engagement_id });
  }

  async consumeOutbox(limit = 100): Promise<Array<{ commit_seq: number; status: "applied" }>> {
    await this.migrate();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new ContractValidationError("validation_error", "outbox limit must be between 1 and 10000");
    return this.withTransaction(async (client) => {
      const pending = await client.query<{ commit_seq: unknown }>(`SELECT commit_seq FROM taric.outbox WHERE status='pending' ORDER BY commit_seq FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
      const applied: Array<{ commit_seq: number; status: "applied" }> = [];
      for (const row of pending.rows) {
        const seq = asNumber(row.commit_seq);
        await client.query(`UPDATE taric.outbox SET status='applied',updated_at=now() WHERE commit_seq=$1 AND status='pending'`, [seq]);
        await client.query(`UPDATE taric.operation_markers SET status='applied',updated_at=now() WHERE commit_seq=$1 AND status='pending'`, [seq]);
        applied.push({ commit_seq: seq, status: "applied" });
      }
      return applied;
    });
  }

  async pinSnapshot(engagementId: string, options: { asOf?: number; ttlMs?: number; trustLevel?: TrustLevel; includeCandidates?: boolean } = {}): Promise<PostgresPinnedSnapshot> {
    await this.migrate();
    return this.withTransaction(async (client) => {
      const current = asNumber((await client.query<{ seq: unknown }>(`SELECT COALESCE(max(commit_seq),0) AS seq FROM taric.events`)).rows[0]?.seq);
      const readSeq = options.asOf ?? current;
      if (!Number.isSafeInteger(readSeq) || readSeq < 0 || readSeq > current) throw new ContractValidationError("conflict", `unsupported authority sequence: ${readSeq}`);
      const watermarks = await this.watermarks(client, current);
      const rows = await client.query<{ body: unknown; trust_level: TrustLevel }>(`SELECT DISTINCT ON (id) body,trust_level FROM taric.record_versions WHERE engagement_id=$1 AND commit_seq <= $2 ORDER BY id,commit_seq DESC`, [engagementId, readSeq]);
      const records = rows.rows.map((row) => parseJson(row.body) as CanonicalRecord).filter((record) => record.trust_level !== "L0" && (options.includeCandidates || record.trust_level !== "L1")).filter((record) => !options.trustLevel || record.trust_level === options.trustLevel).filter((record) => !["stale", "retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(String(record.status ?? "active"))).sort((a, b) => a.id.localeCompare(b.id));
      const snapshotId = uuidv7();
      const now = new Date().toISOString();
      const expires = options.ttlMs === undefined ? null : new Date(Date.now() + options.ttlMs).toISOString();
      await client.query(`INSERT INTO taric.reader_pins(snapshot_id,engagement_id,generation,read_seq,committed_seq,projected_seq,indexed_seq,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [snapshotId, engagementId, readSeq, readSeq, current, Math.min(watermarks.projected_seq, readSeq), Math.min(watermarks.indexed_seq, readSeq), expires, now]);
      return { read_seq: readSeq, committed_seq: current, projected_seq: Math.min(watermarks.projected_seq, readSeq), indexed_seq: Math.min(watermarks.indexed_seq, readSeq), generation: readSeq, watermark: { committed_seq: current, projected_seq: Math.min(watermarks.projected_seq, readSeq), indexed_seq: Math.min(watermarks.indexed_seq, readSeq) }, snapshot_id: snapshotId, records };
    });
  }

  async snapshot(engagementId: string, options: { asOf?: number; trustLevel?: TrustLevel; includeCandidates?: boolean; snapshotId?: string } = {}): Promise<PostgresPinnedSnapshot> {
    await this.migrate();
    if (options.snapshotId) {
      const pin = await this.query<{ snapshot_id: string; engagement_id: string; generation: unknown; read_seq: unknown; committed_seq: unknown; projected_seq: unknown; indexed_seq: unknown; expires_at: string | Date | null }>(`SELECT * FROM taric.reader_pins WHERE snapshot_id=$1`, [options.snapshotId]);
      const row = pin.rows[0];
      if (!row || row.engagement_id !== engagementId || (row.expires_at !== null && Date.parse(String(row.expires_at)) <= Date.now())) throw new ContractValidationError("stale_version", "reader snapshot pin is unavailable or expired");
      const records = await this.query<{ body: unknown; trust_level: TrustLevel }>(`SELECT DISTINCT ON (id) body,trust_level FROM taric.record_versions WHERE engagement_id=$1 AND commit_seq <= $2 ORDER BY id,commit_seq DESC`, [engagementId, asNumber(row.read_seq)]);
      const selected = records.rows.map((entry) => parseJson(entry.body) as CanonicalRecord).filter((record) => record.trust_level !== "L0" && (options.includeCandidates || record.trust_level !== "L1")).filter((record) => !options.trustLevel || record.trust_level === options.trustLevel).filter((record) => !["stale", "retracted", "superseded", "archived", "expired", "inconclusive", "contradicted"].includes(String(record.status ?? "active"))).sort((a, b) => a.id.localeCompare(b.id));
      return { read_seq: asNumber(row.read_seq), committed_seq: asNumber(row.committed_seq), projected_seq: asNumber(row.projected_seq), indexed_seq: asNumber(row.indexed_seq), generation: asNumber(row.generation), watermark: { committed_seq: asNumber(row.committed_seq), projected_seq: asNumber(row.projected_seq), indexed_seq: asNumber(row.indexed_seq) }, snapshot_id: row.snapshot_id, records: selected };
    }
    const result = await this.pinSnapshot(engagementId, { ...options, ttlMs: undefined });
    return result;
  }

  private async watermarks(client: PostgresQueryable, current?: number): Promise<{ projected_seq: number; indexed_seq: number }> {
    const rows = await client.query<{ projected_seq: unknown; indexed_seq: unknown }>(`
      SELECT COALESCE((SELECT min(commit_seq)-1 FROM taric.outbox WHERE status <> 'applied'), COALESCE($1, (SELECT max(commit_seq) FROM taric.events), 0)) AS projected_seq,
        COALESCE((SELECT (value #>> '{}')::bigint FROM taric.metadata WHERE key='indexed_seq'), 0) AS indexed_seq`, [current ?? null]);
    return { projected_seq: asNumber(rows.rows[0]?.projected_seq), indexed_seq: asNumber(rows.rows[0]?.indexed_seq) };
  }

  async updateIndexedWatermark(sequence: number): Promise<void> {
    await this.migrate();
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new ContractValidationError("validation_error", "indexed watermark must be a non-negative integer");
    const updated = await this.query(`UPDATE taric.metadata SET value=to_jsonb($1::bigint) WHERE key='indexed_seq' AND (value #>> '{}')::bigint <= $1 AND $1 <= COALESCE((SELECT min(commit_seq)-1 FROM taric.outbox WHERE status <> 'applied'), (SELECT COALESCE(max(commit_seq),0) FROM taric.events))`, [sequence]);
    if ((updated.rowCount ?? updated.rows.length) === 0) throw new ContractValidationError("stale_version", "indexed watermark cannot move backwards or exceed the projected sequence");
  }

  async claimWorkRun(input: { run_id?: string; work_item_id: string; engagement_id: string; host_id: string; agent_id: string; ttl_ms?: number }): Promise<PostgresLease> {
    await this.migrate();
    const ttl = input.ttl_ms ?? 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw new ContractValidationError("validation_error", "lease ttl must be a positive integer");
    return this.withTransaction(async (client) => {
      const runId = input.run_id ?? uuidv7();
      await client.query(`UPDATE taric.work_leases SET status='lost',updated_at=now(),body=jsonb_set(body,'{status}','"lost"'::jsonb) WHERE work_item_id=$1 AND lease_expires_at <= now() AND status NOT IN ('completed','failed','cancelled','lost')`, [input.work_item_id]);
      const existing = (await client.query<Record<string, unknown>>(`SELECT * FROM taric.work_leases WHERE run_id=$1 FOR UPDATE`, [runId])).rows[0];
      const active = await client.query<{ run_id: string }>(`SELECT run_id FROM taric.work_leases WHERE work_item_id=$1 AND lease_expires_at > now() AND status NOT IN ('completed','failed','cancelled','lost') AND run_id <> $2 FOR UPDATE`, [input.work_item_id, runId]);
      if (active.rows[0]) throw new ContractValidationError("conflict", "WorkItem already has an active leased WorkRun");
      const expires = await client.query<{ active: boolean }>(`SELECT lease_expires_at > now() AS active FROM taric.work_leases WHERE run_id=$1`, [runId]);
      if (existing && expires.rows[0]?.active && !["lost", "completed", "failed", "cancelled"].includes(String(existing.status))) throw new ContractValidationError("conflict", "work run lease is still active");
      const generation = asNumber(existing?.generation) + 1 || 1;
      const attemptRef = uuidv7();
      if (existing) await client.query(`UPDATE taric.attempts SET status='lost',updated_at=now() WHERE run_id=$1 AND generation=$2 AND status NOT IN ('completed','failed','cancelled','lost')`, [runId, asNumber(existing.generation)]);
      const leaseTimes = await client.query<{ now: string | Date; expires_at: string | Date }>(`SELECT now() AS now, now() + ($1::bigint * interval '1 millisecond') AS expires_at`, [ttl]);
      const now = new Date(leaseTimes.rows[0]?.now ?? Date.now());
      const expiry = isoTimestamp(leaseTimes.rows[0]?.expires_at ?? now.getTime() + ttl);
      const readSeq = asNumber((await client.query<{ seq: unknown }>(`SELECT COALESCE(max(commit_seq),0) AS seq FROM taric.events`)).rows[0]?.seq);
      const body = { run_id: runId, work_item_id: input.work_item_id, engagement_id: input.engagement_id, owner: { host_id: input.host_id, agent_id: input.agent_id }, generation, attempt_ref: attemptRef, lease_expires_at: expiry, heartbeat_at: now.toISOString(), read_seq: readSeq };
      await client.query(`INSERT INTO taric.work_leases(run_id,work_item_id,engagement_id,status,owner_host,owner_agent,generation,attempt_ref,lease_expires_at,heartbeat_at,read_seq,body,created_at,updated_at) VALUES($1,$2,$3,'claimed',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$9,$9)
        ON CONFLICT(run_id) DO UPDATE SET work_item_id=excluded.work_item_id,engagement_id=excluded.engagement_id,status='claimed',owner_host=excluded.owner_host,owner_agent=excluded.owner_agent,generation=excluded.generation,attempt_ref=excluded.attempt_ref,lease_expires_at=excluded.lease_expires_at,heartbeat_at=excluded.heartbeat_at,read_seq=excluded.read_seq,body=excluded.body,updated_at=excluded.updated_at`, [runId, input.work_item_id, input.engagement_id, input.host_id, input.agent_id, generation, attemptRef, expiry, now.toISOString(), readSeq, JSON.stringify(body)]);
      await client.query(`INSERT INTO taric.attempts(attempt_id,run_id,generation,owner_host,owner_agent,status,lease_expires_at,heartbeat_at,body,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'claimed',$6,$7,$8::jsonb,$7,$7)`, [attemptRef, runId, generation, input.host_id, input.agent_id, expiry, now.toISOString(), JSON.stringify(body)]);
      await this.appendEvent(client, "work_run.claim", runId, { engagement_id: input.engagement_id, work_item_id: input.work_item_id, host_id: input.host_id, worker_id: input.agent_id, attempt_id: attemptRef, generation });
      return { run_id: runId, work_item_id: input.work_item_id, engagement_id: input.engagement_id, status: "claimed", owner: { host_id: input.host_id, agent_id: input.agent_id }, generation, attempt_ref: attemptRef, lease_expires_at: expiry, heartbeat_at: now.toISOString(), read_seq: readSeq };
    });
  }

  async renewWorkRun(runId: string, generation: number, hostId: string, ttlMs = 60_000): Promise<PostgresLease> {
    await this.migrate();
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ContractValidationError("validation_error", "lease ttl must be a positive integer");
    return this.withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(`UPDATE taric.work_leases SET lease_expires_at=now() + ($1::bigint * interval '1 millisecond'),heartbeat_at=now(),updated_at=now(),body=jsonb_set(jsonb_set(body,'{lease_expires_at}',to_jsonb((now() + ($1::bigint * interval '1 millisecond'))::text)),'{heartbeat_at}',to_jsonb(now()::text)) WHERE run_id=$2 AND generation=$3 AND owner_host=$4 AND lease_expires_at > now() AND status NOT IN ('completed','failed','cancelled','lost') RETURNING *`, [ttlMs, runId, generation, hostId]);
      const row = result.rows[0];
      if (!row) throw new ContractValidationError("stale_version", "work run lease is expired or fenced");
      await client.query(`UPDATE taric.attempts SET lease_expires_at=$1,heartbeat_at=$2,updated_at=now() WHERE run_id=$3 AND generation=$4 AND owner_host=$5`, [row.lease_expires_at, row.heartbeat_at, runId, generation, hostId]);
      await this.appendEvent(client, "work_run.renew", runId, { engagement_id: row.engagement_id, host_id: hostId, attempt_id: row.attempt_ref, generation, lease_expires_at: isoTimestamp(row.lease_expires_at) });
      return this.leaseFromRow(row);
    });
  }

  async reclaimWorkRun(runId: string, hostId: string, agentId: string, ttlMs = 60_000): Promise<PostgresLease> {
    await this.migrate();
    const row = (await this.query<Record<string, unknown>>(`SELECT * FROM taric.work_leases WHERE run_id=$1`, [runId])).rows[0];
    if (!row) throw new ContractValidationError("conflict", "work run not found");
    const expired = await this.query<{ expired: boolean }>(`SELECT $1::timestamptz <= now() AS expired`, [row.lease_expires_at]);
    if (!expired.rows[0]?.expired) throw new ContractValidationError("conflict", "work run lease is still active");
    return this.claimWorkRun({ run_id: runId, work_item_id: String(row.work_item_id), engagement_id: String(row.engagement_id), host_id: hostId, agent_id: agentId, ttl_ms: ttlMs });
  }

  async events(): Promise<Array<{ commit_seq: number; event_id: string; event_type: string; subject_id?: string; payload: Record<string, unknown>; prev_hash: string | null; hash: string; created_at: string }>> {
    await this.migrate();
    const result = await this.query<{ commit_seq: unknown; event_id: string; event_type: string; subject_id: string | null; payload: unknown; prev_hash: string | null; hash: string; created_at: string | Date }>(`SELECT commit_seq,event_id,event_type,subject_id,payload,prev_hash,hash,created_at FROM taric.events ORDER BY commit_seq`);
    return result.rows.map((row) => ({ commit_seq: asNumber(row.commit_seq), event_id: row.event_id, event_type: row.event_type, subject_id: row.subject_id ?? undefined, payload: (parseJson(row.payload) ?? {}) as Record<string, unknown>, prev_hash: row.prev_hash, hash: row.hash, created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString() }));
  }

  async verifyAudit(): Promise<{ valid: boolean; errors: string[] }> {
    const rows = await this.events();
    const errors: string[] = [];
    let previous: string | null = null;
    rows.forEach((event, index) => {
      if (event.commit_seq !== index + 1) errors.push(`event ${event.event_id}: sequence gap`);
      if (event.prev_hash !== previous) errors.push(`event ${event.event_id}: previous hash mismatch`);
      const expected = digest({ event_id: event.event_id, event_type: event.event_type, subject_id: event.subject_id, payload: event.payload, prev_hash: event.prev_hash, created_at: event.created_at });
      if (expected !== event.hash) errors.push(`event ${event.event_id}: hash mismatch`);
      previous = event.hash;
    });
    return { valid: errors.length === 0, errors };
  }

  async doctor(): Promise<DoctorReport> {
    await this.migrate();
    const health = await this.health();
    const pending = await this.query<{ count: unknown }>(`SELECT count(*) AS count FROM taric.outbox WHERE status <> 'applied'`);
    const markerRows = await this.query<{ status: string; count: unknown }>(`SELECT status,count(*) AS count FROM taric.operation_markers GROUP BY status`);
    const audit = await this.verifyAudit();
    const count = asNumber(pending.rows[0]?.count);
    const operation_markers = { pending: 0, applied: 0, indexed: 0, failed: 0, recovered: 0 } as Record<"pending" | "applied" | "indexed" | "failed" | "recovered", number>;
    for (const row of markerRows.rows) if (row.status in operation_markers) operation_markers[row.status as keyof typeof operation_markers] = asNumber(row.count);
    const errors = [...audit.errors];
    if (count > 0) errors.push(`${count} operation(s) remain pending in the outbox`);
    return {
      valid: errors.length === 0,
      schema_version: health.schema_version,
      committed_seq: health.committed_seq,
      projected_seq: health.projected_seq,
      pending_outbox: count,
      operation_markers,
      authority: { valid: audit.valid, errors: audit.errors },
      derived: { valid: count === 0, errors: count === 0 ? [] : [`${count} operation(s) remain pending in the outbox`], repair_actions: count === 0 ? [] : ["consume the PostgreSQL outbox and rerun doctor"] },
      audit,
      errors,
    };
  }

  async exportSnapshot(engagementId: string, asOf?: number): Promise<{ format: "taric-postgresql-json"; schema_version: string; core_version: string; engagement_id: string; source_sequence: number; read_seq: number; committed_seq: number; projected_seq: number; backup_timestamp: string; provenance: { backend: "postgresql"; schema: string }; records: CanonicalRecord[]; hash: string }> {
    const snapshot = await this.snapshot(engagementId, { asOf, includeCandidates: true });
    const payload = { format: "taric-postgresql-json" as const, schema_version: POSTGRES_SCHEMA_VERSION, core_version: SCHEMA_VERSION, engagement_id: engagementId, source_sequence: snapshot.read_seq, read_seq: snapshot.read_seq, committed_seq: snapshot.committed_seq, projected_seq: snapshot.projected_seq, backup_timestamp: new Date().toISOString(), provenance: { backend: "postgresql" as const, schema: this.#options.schema }, records: snapshot.records };
    return { ...payload, hash: digest(payload) };
  }

  async importSnapshot(snapshotInput: unknown): Promise<{ engagement_id: string; recovered_sequence: number; imported_records: number; integrity_verified: true; display_sequence: number }> {
    let snapshot: Record<string, unknown>;
    try { snapshot = typeof snapshotInput === "string" ? JSON.parse(snapshotInput) as Record<string, unknown> : snapshotInput as Record<string, unknown>; }
    catch { throw new ContractValidationError("validation_error", "PostgreSQL backup must be valid JSON"); }
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new ContractValidationError("validation_error", "PostgreSQL backup must be an object");
    const { hash: suppliedHash, records, ...payload } = snapshot;
    if (payload.format !== "taric-postgresql-json" || payload.schema_version !== POSTGRES_SCHEMA_VERSION || payload.core_version !== SCHEMA_VERSION || typeof payload.engagement_id !== "string" || !Number.isSafeInteger(payload.source_sequence) || !Array.isArray(records) || typeof suppliedHash !== "string") {
      throw new ContractValidationError("unsupported_schema_version", "PostgreSQL backup metadata is incomplete or incompatible");
    }
    if (digest({ ...payload, records }) !== suppliedHash) throw new ContractValidationError("validation_error", "PostgreSQL backup integrity hash mismatch");
    if (typeof payload.backup_timestamp !== "string" || Number.isNaN(Date.parse(payload.backup_timestamp))) throw new ContractValidationError("validation_error", "PostgreSQL backup timestamp is invalid");
    const engagementId = payload.engagement_id;
    const candidates = records as CanonicalRecord[];
    if (!candidates.length || !candidates.some((record) => record.id === engagementId && String(record.kind) === "engagement")) throw new ContractValidationError("validation_error", "PostgreSQL backup must contain its Engagement record");
    const ids = new Set<string>();
    const aliases = new Set<string>();
    let maxAlias = 0;
    const owners = new Map<string, string>();
    const kinds = new Map<string, string>();
    const statuses = new Map<string, string>();
    for (const record of candidates) {
      if (!record || typeof record.id !== "string" || record.engagement_id !== engagementId || typeof record.display_id !== "string" || !/^TAR-[0-9]{6,}$/.test(record.display_id)) throw new ContractValidationError("validation_error", "PostgreSQL backup record ownership or display identity is invalid");
      if (ids.has(record.id) || aliases.has(record.display_id)) throw new ContractValidationError("conflict", "PostgreSQL backup contains duplicate record or display identity");
      ids.add(record.id); aliases.add(record.display_id); owners.set(record.id, engagementId); kinds.set(record.id, String(record.kind ?? "record")); statuses.set(record.id, String(record.status ?? "active"));
      maxAlias = Math.max(maxAlias, Number(record.display_id.slice(4)));
      validateCanonicalRecord(record, record.trust_level);
    }
    for (const record of candidates) validateAuthorityReferences(record, { engagement: owners, kind: kinds, status: statuses }, engagementId);
    await this.migrate();
    return this.withTransaction(async (client) => {
      const existing = await client.query(`SELECT 1 FROM taric.records WHERE engagement_id=$1 LIMIT 1`, [engagementId]);
      if (existing.rows[0]) throw new ContractValidationError("conflict", "PostgreSQL backup destination Engagement already contains records");
      for (const record of candidates) {
        const now = typeof record.updated_at === "string" ? record.updated_at : new Date().toISOString();
        const version = Number.isSafeInteger(record.version) && Number(record.version) > 0 ? Number(record.version) : 1;
        const trust = record.trust_level === "L0" || record.trust_level === "L1" || record.trust_level === "L2" ? record.trust_level : "L1";
        const eventPayload = { engagement_id: engagementId, version, trust_level: trust, source_sequence: payload.source_sequence, backup_hash: suppliedHash };
        const commitSeq = await this.appendEvent(client, "snapshot.import.record", record.id, eventPayload);
        await client.query(`INSERT INTO taric.records(id,engagement_id,kind,trust_level,version,display_id,body,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [record.id, engagementId, String(record.kind ?? "record"), trust, version, record.display_id, JSON.stringify(record), record.created_at ?? now, now]);
        await client.query(`INSERT INTO taric.record_versions(id,commit_seq,engagement_id,trust_level,body) VALUES($1,$2,$3,$4,$5::jsonb)`, [record.id, commitSeq, engagementId, trust, JSON.stringify(record)]);
      }
      if (maxAlias > 0) await client.query(`SELECT setval('${this.#schema}.display_sequence', GREATEST(last_value, $1::bigint), true) FROM ${this.#schema}.display_sequence`, [maxAlias]);
      const recoveredSequence = await this.appendEvent(client, "snapshot.import", engagementId, { engagement_id: engagementId, source_sequence: payload.source_sequence, imported_count: candidates.length, backup_hash: suppliedHash });
      return { engagement_id: engagementId, recovered_sequence: recoveredSequence, imported_records: candidates.length, integrity_verified: true as const, display_sequence: maxAlias + 1 };
    });
  }

  async backup(engagementId: string, asOf?: number): ReturnType<PostgresAuthorityStore["exportSnapshot"]> { return this.exportSnapshot(engagementId, asOf); }
  async restore(snapshot: unknown): ReturnType<PostgresAuthorityStore["importSnapshot"]> { return this.importSnapshot(snapshot); }

  /** Stable operator-facing diagnostics; no connection details are returned. */
  async diagnostics(): Promise<PostgresBackendManifest & { available: true; committed_seq: number; projected_seq: number; indexed_seq: number; backup_format: string; restore_mode: "atomic_verified_target" }> {
    const health = await this.health();
    return { ...this.manifest(), ...health, backup_format: "taric-postgresql-json", restore_mode: "atomic_verified_target" };
  }

  async assertLease(runId: string, generation: number, hostId: string): Promise<PostgresLease> {
    await this.migrate();
    const result = await this.query<Record<string, unknown>>(`SELECT * FROM taric.work_leases WHERE run_id=$1 AND generation=$2 AND owner_host=$3 AND lease_expires_at > now() AND status NOT IN ('completed','failed','cancelled','lost')`, [runId, generation, hostId]);
    const row = result.rows[0];
    if (!row) throw new ContractValidationError("stale_version", "write is fenced by an expired lease or generation");
    return this.leaseFromRow(row);
  }

  private leaseFromRow(row: Record<string, unknown>): PostgresLease {
    const body = (parseJson(row.body) ?? {}) as Record<string, unknown>;
    const owner = (body.owner && typeof body.owner === "object" ? body.owner : { host_id: row.owner_host, agent_id: row.owner_agent }) as Record<string, unknown>;
    return { run_id: String(row.run_id), work_item_id: String(row.work_item_id), engagement_id: String(row.engagement_id), status: String(row.status), owner: { host_id: String(owner.host_id), agent_id: String(owner.agent_id) }, generation: asNumber(row.generation), attempt_ref: String(row.attempt_ref), lease_expires_at: isoTimestamp(row.lease_expires_at), heartbeat_at: isoTimestamp(row.heartbeat_at), read_seq: asNumber(row.read_seq) };
  }
}

export function createPostgresAuthorityStore(client: PostgresQueryable, options?: PostgresAuthorityOptions): PostgresAuthorityStore {
  return new PostgresAuthorityStore(client, options);
}

