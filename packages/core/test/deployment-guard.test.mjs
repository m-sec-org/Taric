import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDeploymentSupported,
  checkDeploymentGuard,
  UNSUPPORTED_DEPLOYMENT_CODE,
  UnsupportedDeploymentError,
} from "../dist/deployment-guard.js";

test("default single-host SQLite is supported without PostgreSQL", () => {
  const result = checkDeploymentGuard();
  assert.equal(result.supported, true);
  assert.equal(result.diagnostics.profile, "single_host_sqlite");
  assert.equal(result.diagnostics.backend, "sqlite");
  assert.equal(result.diagnostics.lease_mode, "local_process");
  assert.equal(result.diagnostics.authority_service.configured, false);
});

test("explicit multi-host profile requires one healthy shared PostgreSQL service", () => {
  const missing = checkDeploymentGuard({ profile: "multi_host_authority", backend: "postgresql", host_count: 2 });
  assert.equal(missing.supported, false);
  assert.equal(missing.code, UNSUPPORTED_DEPLOYMENT_CODE);
  assert.ok(missing.reasons.some((reason) => /requires a configured PostgreSQL service/.test(reason)));
  assert.ok(missing.reasons.some((reason) => /unavailable/.test(reason)));

  const ready = assertDeploymentSupported({
    profile: "multi_host_authority",
    backend: "postgresql",
    host_count: 3,
    authority_service: { configured: true, available: true, shared: true, count: 1, endpoint: "postgres://authority" },
  });
  assert.equal(ready.enabled, true);
  assert.equal(ready.lease_mode, "server_fenced");
  assert.equal(ready.authority_service.count, 1);
});

test("pseudo multi-host SQLite, NFS, Git, and replica deployments fail with stable code", () => {
  const cases = [
    [{ multi_host: true, backend: "sqlite" }, /shared or replicated SQLite/],
    [{ shared_sqlite_path: true }, /shared SQLite paths/],
    [{ nfs_lock: true }, /NFS or network filesystem locks/],
    [{ sqlite_replica_count: 2 }, /independent SQLite replicas/],
    [{ shared_git_clone: true }, /shared Git clones/],
    [{ git_authority: true }, /Git\/Markdown cannot be declared/],
  ];
  for (const [input, expected] of cases) {
    const result = checkDeploymentGuard(input);
    assert.equal(result.supported, false, JSON.stringify(input));
    assert.equal(result.code, UNSUPPORTED_DEPLOYMENT_CODE);
    assert.ok(result.reasons.some((reason) => expected.test(reason)), `${JSON.stringify(input)}: ${result.reasons.join("; ")}`);
  }
});

test("assertion throws a structured stable unsupported deployment error", () => {
  assert.throws(
    () => assertDeploymentSupported({ profile: "multi_host_authority", backend: "sqlite" }),
    (error) => error instanceof UnsupportedDeploymentError
      && error.code === "unsupported_deployment"
      && error.diagnostics.enabled === false
      && error.reasons.length > 0,
  );
});

