import test from "node:test";
import assert from "node:assert/strict";
import { buildProfileVerificationManifest, validateProfileVerificationManifest } from "../profile-verification.mjs";

test("profile manifest scopes verified runtime evidence and preserves untested deployment gaps", () => {
  const manifest = buildProfileVerificationManifest({
    checks: [
      { id: "clean-consumer", passed: true },
      { id: "proxy-restart-replay", passed: true },
      { id: "postgresql-runtime", passed: true },
    ],
    runtimeVerified: true,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    postgresHostCount: 1,
  });
  assert.equal(validateProfileVerificationManifest(manifest), true);
  assert.equal(manifest.profiles.find((item) => item.id === "postgresql-single-authority").state, "verified");
  assert.equal(manifest.profiles.find((item) => item.id === "postgresql-two-process-multi-host").state, "not_verified");
  assert.equal(manifest.profiles.find((item) => item.id === "remote-gateway").state, "not_verified");
  assert.equal(manifest.profiles.find((item) => item.id === "npm-registry-distribution").state, "unsupported");
});

test("profile manifest rejects duplicate and unknown state entries", () => {
  const manifest = buildProfileVerificationManifest({ checks: [], runtimeVerified: false, sourceDigest: `sha256:${"b".repeat(64)}` });
  assert.equal(validateProfileVerificationManifest(manifest), true);
  assert.equal(validateProfileVerificationManifest({ ...manifest, profiles: [...manifest.profiles, manifest.profiles[0]] }), false);
  assert.equal(validateProfileVerificationManifest({ ...manifest, profiles: manifest.profiles.map((item, index) => index ? item : { ...item, state: "maybe" }) }), false);
});
