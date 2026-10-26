import test from "node:test";
import assert from "node:assert/strict";
import { buildProfileVerificationManifest, validateProfileVerificationManifest } from "../profile-verification.mjs";

test("profile manifest scopes verified runtime evidence and preserves unsupported deployment boundaries", () => {
  const manifest = buildProfileVerificationManifest({
    checks: [
      { id: "clean-consumer", passed: true },
      { id: "proxy-restart-replay", passed: true },
      { id: "remote-gateway-live", passed: true },
      { id: "postgresql-runtime", passed: true },
    ],
    runtimeVerified: true,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    postgresHostCount: 1,
  });
  assert.equal(validateProfileVerificationManifest(manifest), true);
  assert.equal(manifest.profiles.find((item) => item.id === "postgresql-single-authority").state, "verified");
  assert.equal(manifest.profiles.find((item) => item.id === "postgresql-two-container-multi-host").state, "not_verified");
  assert.deepEqual(manifest.profiles.find((item) => item.id === "postgresql-two-container-multi-host").evidence, ["verify-multi-host-postgres-live"]);
  assert.deepEqual(manifest.profiles.find((item) => item.id === "container-artifact-spool-mount").evidence, ["verify-container-spool"]);
  assert.match(manifest.profiles.find((item) => item.id === "postgresql-two-container-multi-host").detail, /Two host containers/);
  assert.equal(manifest.profiles.find((item) => item.id === "third-party-native-hosts").state, "not_verified");
  assert.match(manifest.profiles.find((item) => item.id === "third-party-native-hosts").detail, /Pi 1\.4\.0/);
  assert.equal(manifest.profiles.find((item) => item.id === "remote-gateway").state, "verified");
  assert.deepEqual(manifest.profiles.find((item) => item.id === "remote-gateway").evidence, ["remote-gateway-live"]);
  assert.match(manifest.profiles.find((item) => item.id === "container-artifact-spool-mount").detail, /local bind-mounted spool/);
  assert.equal(manifest.profiles.find((item) => item.id === "npm-registry-distribution").state, "unsupported");
});

test("profile manifest rejects duplicate and unknown state entries", () => {
  const manifest = buildProfileVerificationManifest({ checks: [], runtimeVerified: false, sourceDigest: `sha256:${"b".repeat(64)}` });
  assert.equal(validateProfileVerificationManifest(manifest), true);
  assert.equal(validateProfileVerificationManifest({ ...manifest, profiles: [...manifest.profiles, manifest.profiles[0]] }), false);
  assert.equal(validateProfileVerificationManifest({ ...manifest, profiles: manifest.profiles.map((item, index) => index ? item : { ...item, state: "maybe" }) }), false);
});
