import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AUTHORITY_STORAGE_CONTRACT,
  API_CONTRACT_VERSION,
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
  assert.equal(SHARED_AUTHORITY_BACKEND_MANIFEST.api_version, API_CONTRACT_VERSION);
  assert.deepEqual(SHARED_AUTHORITY_BACKEND_MANIFEST.postgresql.supported_majors, POSTGRESQL_SUPPORTED_MAJOR_VERSIONS);
  assert.equal(authorityStartupDiagnostics(config).code, "ready");
});

test("single-host service does not load the PostgreSQL driver", async () => {
  const service = await readFile(new URL("../dist/service.js", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../dist/runtime-service.js", import.meta.url), "utf8");
  assert.doesNotMatch(service, /(?:from|import\()\s*["']pg["']/);
  assert.match(runtime, /import\(["']pg["']\)/, "multi-host selection loads the installed driver lazily");
});

test("multi-host authority requires explicit PostgreSQL service and server-side fencing config", () => {
  assert.throws(() => resolveAuthorityConfiguration({ profile: MULTI_HOST_AUTHORITY_PROFILE }), AuthorityConfigurationError);
  const config = resolveAuthorityConfiguration({ profile: MULTI_HOST_AUTHORITY_PROFILE, postgresql: { connection_string: "postgres://authority/db" }, host_id: "host-a", lease_mode: "server_side" });
  assert.equal(config.backend, "postgresql");
  assert.equal(authorityStartupDiagnostics(config).code, "postgresql_unavailable");
  assert.equal(authorityStartupDiagnostics(config).enabled, false);
  assert.equal(authorityStartupDiagnostics(config, true).code, "backend_conformance_failed");
  assert.equal(authorityStartupDiagnostics(config, true).runtime_state, "disabled");
  assert.equal(authorityStartupDiagnostics(config, true).implementation_state, "available");
  assert.throws(() => resolveAuthorityConfiguration({ profile: SINGLE_HOST_SQLITE_PROFILE, postgresql: { connection_string: "postgres://authority/db" } }), AuthorityConfigurationError);
});

test("SQLite store structurally implements the published authority storage contract", async () => {
  const store = new AuthorityStore();
  const contract = sqliteStorageContract(store);
  const engagementId = uuidv7();
  const record = (await contract.commit({ id: uuidv7(), engagement_id: engagementId, kind: "claim", proposition: "contract" }));
  const old = (await contract.snapshot(engagementId, { asOf: record.commit_seq, includeCandidates: true }));
  assert.equal(old.records.length, 1);
  assert.equal((await contract.exportSnapshot(engagementId, old.read_seq)).records.length, 1);
  assert.equal((await contract.verifyAudit()).valid, true);
  assert.deepEqual(AUTHORITY_STORAGE_CONTRACT.invariants, [
    "atomic_record_event_idempotency_outbox_commit",
    "expected_version_compare_and_set",
    "uuidv7_primary_identity_and_global_display_sequence",
    "strictly_ordered_audit_event_sequence",
    "pinned_snapshot_read_sequence_and_watermarks",
    "integrity_checked_snapshot_backup_and_atomic_restore",
    "lease_expiry_heartbeat_reclaim_and_fencing_generation",
    "atomic_admission_bound_review_snapshot_and_policy_binding",
  ]);
  (await store.close());
});
