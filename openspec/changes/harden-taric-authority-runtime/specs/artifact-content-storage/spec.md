# Spec Delta

## ADDED Requirements

### Requirement: Measure Artifact upload and publication durability
Artifact upload SHALL expose a deployment profile for decoded chunk size, transport envelope bound, publication durability, and recovery behavior. Before changing the contractual 64 MiB decoded chunk limit, the project SHALL measure concurrent-upload peak RSS, throughput, and latency including base64 decode, Buffer retention, copy, and publication. Profiles that claim power-loss durability MUST define their fsync/rename cost and recovery guarantee; process-crash recovery SHALL continue to use publication markers and reconcile results.

#### Scenario: Benchmark concurrent uploads
- **WHEN** the release benchmark runs concurrent textual and binary uploads
- **THEN** it records decoded bytes, transport bytes, peak memory, throughput, latency, and publication failures for the selected profile

#### Scenario: Inject a publication failure
- **WHEN** a process fails before rename, after rename, or during catalog commit
- **THEN** restart and reconcile report the marker state, preserve hash/length integrity, and expose neither incomplete nor unverified content as available

#### Scenario: Use a non-durable profile
- **WHEN** an operator selects a profile without power-loss durability guarantees
- **THEN** the runtime reports that limitation explicitly and does not claim fsync-level recovery semantics
