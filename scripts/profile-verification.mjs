const profileState = (passed) => passed ? "verified" : "not_verified";

/** Machine-readable evidence scoped to the exact deployment topologies tested. */
export function buildProfileVerificationManifest({ checks, runtimeVerified, sourceDigest, postgresHostCount = 0 }) {
  const gates = new Map(checks.map((check) => [check.id, check.passed === true]));
  const sqliteConsumer = gates.get("clean-consumer") === true;
  const localBridge = gates.get("proxy-restart-replay") === true;
  const postgres = gates.get("postgresql-runtime") === true && runtimeVerified === true;
  const profiles = [
    { id: "single-host-node-core", state: profileState(sqliteConsumer), evidence: ["clean-consumer"], detail: "Local tarball install, Core migration, close, restart and read through the public Core package." },
    { id: "single-host-cli", state: profileState(sqliteConsumer), evidence: ["clean-consumer"], detail: "Packed CLI binary operates on a persistent isolated SQLite authority." },
    { id: "single-host-bun-sqlite-driver", state: profileState(sqliteConsumer), evidence: ["clean-consumer"], detail: "Packed Bun SQLite driver imports and executes a live in-memory query." },
    { id: "local-node-cli-bun-rpc-bridge", state: profileState(localBridge), evidence: ["proxy-restart-replay"], detail: "Local Unix socket bridge survives two proxy restarts with query/read recovery and idempotent replay." },
    { id: "postgresql-single-authority", state: profileState(postgres), evidence: ["postgresql-runtime"], host_count: postgresHostCount, detail: "OrbStack PostgreSQL live runtime conformance and independent backup/restore; this run used one authority host." },
    { id: "postgresql-two-process-multi-host", state: "not_verified", evidence: [], detail: "No independent concurrent host processes or network interruption/reconnect profile was run." },
    { id: "third-party-native-hosts", state: "not_verified", evidence: [], detail: "Pinned adapter contract tests do not establish a live external host deployment." },
    { id: "remote-gateway", state: "not_verified", evidence: [], detail: "No remote network bridge, token revocation, or cross-machine reconnect profile was run." },
    { id: "container-artifact-spool-mount", state: "not_verified", evidence: [], detail: "No bind-mounted container spool replacement/permission/restart profile was run." },
    { id: "npm-registry-distribution", state: "unsupported", evidence: [], detail: "Workspace packages remain private; local tarball consumer verification is not registry publication." },
  ];
  return {
    version: "taric-profile-verification/1",
    source_digest: sourceDigest,
    profiles,
  };
}

export function validateProfileVerificationManifest(manifest) {
  if (!manifest || manifest.version !== "taric-profile-verification/1" || !/^sha256:[0-9a-f]{64}$/.test(manifest.source_digest) || !Array.isArray(manifest.profiles)) return false;
  const allowed = new Set(["verified", "not_verified", "unsupported"]);
  const ids = new Set();
  for (const profile of manifest.profiles) {
    if (!profile || typeof profile.id !== "string" || !profile.id.trim() || ids.has(profile.id) || !allowed.has(profile.state) || !Array.isArray(profile.evidence) || typeof profile.detail !== "string" || !profile.detail.trim()) return false;
    ids.add(profile.id);
  }
  return ["single-host-node-core", "local-node-cli-bun-rpc-bridge", "postgresql-single-authority", "postgresql-two-process-multi-host", "remote-gateway"].every((id) => ids.has(id));
}
