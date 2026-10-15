# Spec Delta

## ADDED Requirements

### Requirement: Gate shared backend runtime activation
PostgreSQL storage primitives SHALL be exposed through the same Core service facade and policy/governance contract as SQLite before the multi-host profile is enabled. The shared runtime SHALL cover proposals, reviews, L1/L2 admission, checkpoints, actions, Artifact catalog, leases, fencing, audit/outbox, pinned reads, and backup/restore semantics. A backend with only partial primitives SHALL report `runtime_state=disabled` and `implementation_state=available`; it SHALL not construct a partially capable service or silently fall back to SQLite.

#### Scenario: Use a primitive-only PostgreSQL backend
- **WHEN** an operator selects PostgreSQL before the full runtime conformance suite passes
- **THEN** startup returns a stable blocked/disabled capability report and performs no authority mutation

#### Scenario: Enable a conforming PostgreSQL runtime
- **WHEN** PostgreSQL passes the shared SQLite conformance suite and health/lease checks
- **THEN** the service facade enables the multi-host profile with equivalent externally visible operation and error semantics

#### Scenario: Shared backend becomes unavailable
- **WHEN** an enabled multi-host service loses its shared backend or fencing health
- **THEN** new writes are blocked with an unavailable/blocked error and the runtime does not open an independent SQLite authority
