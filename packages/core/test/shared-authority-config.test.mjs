import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AUTHORITY_STORAGE_CONTRACT,
  AuthorityConfigurationError,
  AuthorityStore,
  MULTI_HOST_AUTHORITY_PROFILE,
  POSTGRESQL_SUPPORTED_MAJOR_VERSIONS,
  SHARED_AUTHORITY_BACKEND_MANIFEST,
  SINGLE_HOST_SQLITE_PROFILE,
  authorityStartupDiagnostics,
  resolveAuthorityConfiguration,
  sqliteStorageContract,
  uuidv7,
} from "../dist/index.js";

test("default config selects SQLite without PostgreSQL dependency or configuration", () => {
  const config = resolveAuthorityConfiguration();
  assert.deepEqual(config, {
    profile: SINGLE_HOST_SQLITE_PROFILE,
    backend: "sqlite",
    enabled: true,
    sqlite: { path: ":memory:" },
    host_id: null,
    lease_mode: "local",
  });
  assert.equal(SHARED_AUTHORITY_BACKEND_MANIFEST.profiles.single_host_sqlite.postgres_dependency, false);
  assert.deepEqual(SHARED_AUTHORITY_BACKEND_MANIFEST.postgresql.supported_majors, POSTGRESQL_SUPPORTED_MAJOR_VERSIONS);
  assert.equal(authorityStartupDiagnostics(config).code, "ready");
});

test("default core package does not declare a PostgreSQL driver dependency", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const dependencies = { ...packageJson.dependencies, ...packageJson.optionalDependencies };
  assert.equal(Object.keys(dependencies).some((name) => /^(pg|postgres|postgresql|@neondatabase\/serverless)$/.test(name)), false);
});

test("multi-host authority requires explicit PostgreSQL service and server-side fencing config", () => {
  assert.throws(() => resolveAuthorityConfiguration({ profile: MULTI_HOST_AUTHORITY_PROFILE }), AuthorityConfigurationError);
  const config = resolveAuthorityConfiguration({ profile: MULTI_HOST_AUTHORITY_PROFILE, postgresql: { connection_string: "postgres://authority/db" }, host_id: "host-a", lease_mode: "server_side" });
  assert.equal(config.backend, "postgresql");
  assert.equal(authorityStartupDiagnostics(config).code, "postgresql_unavailable");
  assert.equal(authorityStartupDiagnostics(config).enabled, false);
  assert.equal(authorityStartupDiagnostics(config, true).code, "ready");
  assert.throws(() => resolveAuthorityConfiguration({ profile: SINGLE_HOST_SQLITE_PROFILE, postgresql: { connection_string: "postgres://authority/db" } }), AuthorityConfigurationError);
});

test("SQLite store structurally implements the published authority storage contract", () => {
  const store = new AuthorityStore();
  const contract = sqliteStorageContract(store);
  const engagementId = uuidv7();
  const record = contract.commit({ id: uuidv7(), engagement_id: engagementId, kind: "claim", proposition: "contract" });
  const old = contract.snapshot(engagementId, { asOf: record.commit_seq, includeCandidates: true });
  assert.equal(old.records.length, 1);
  assert.equal(contract.exportSnapshot(engagementId, old.read_seq).records.length, 1);
  assert.equal(contract.verifyAudit().valid, true);
  assert.deepEqual(AUTHORITY_STORAGE_CONTRACT.invariants, [
    "atomic_record_event_idempotency_outbox_commit",
    "expected_version_compare_and_set",
    "uuidv7_primary_identity_and_global_display_sequence",
    "strictly_ordered_audit_event_sequence",
    "pinned_snapshot_read_sequence_and_watermarks",
    "integrity_checked_snapshot_backup_and_atomic_restore",
    "lease_expiry_heartbeat_reclaim_and_fencing_generation",
  ]);
  store.close();
});
