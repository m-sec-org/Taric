# Tasks

- [ ] Acquire independently annotated, versioned samples covering every required quality stratum.
- [ ] Record human baseline provenance and annotation agreement.
- [x] Generate a digest-bound quality release report from the current commit.
- [x] Verify failed, stale and incomplete reports keep the capability disabled.
- [x] Gate runtime quality capability activation on an independent report-byte pin and current implementation, schema and policy digests.
- [x] Verify isolated tarball consumer lifecycle and host-to-Core restart/replay in the release gate.
- [x] Generate a digest-bound profile manifest with explicit verified, not_verified and unsupported states.
