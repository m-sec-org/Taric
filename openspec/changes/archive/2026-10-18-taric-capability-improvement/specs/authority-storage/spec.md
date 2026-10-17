# Spec Delta

## ADDED Requirements

### Requirement: Measure bounded authority reads and operator maintenance

Authority read and operator maintenance operations SHALL use a fixed watermark or read sequence and SHALL expose enough diagnostics to distinguish queue wait, SQL scan/return rows, snapshot hydration, ordering/projection, serialization, cursor bytes, WAL growth, event-loop delay, elapsed time, and peak RSS. A budget exceeded during a required read SHALL return an explicit continuation or error. Operator maintenance SHALL be explicit, scoped, and observable; it MUST NOT silently rewrite authority history or claim execution isolation without measured evidence. Maintenance diagnostics SHALL state whether execution can delay ordinary writes or lease heartbeats.

#### Scenario: Context page is measured
- **WHEN** an operator runs the authority benchmark for a context page
- **THEN** the report includes fixture size, sample count, p50/p95, read sequence, scanned/returned rows, cursor size, memory, and event-loop delay

#### Scenario: Maintenance overlaps a write
- **WHEN** doctor, verify, reconcile, or export runs while a normal write or lease heartbeat is pending
- **THEN** the operation records queueing and watermark effects, keeps operator authorization, and does not claim an unmeasured worker isolation guarantee

#### Scenario: Read budget cannot be met
- **WHEN** a required context or snapshot read exceeds its scan or byte budget
- **THEN** Taric returns a bounded continuation or structured budget error and does not return a partial result as complete
