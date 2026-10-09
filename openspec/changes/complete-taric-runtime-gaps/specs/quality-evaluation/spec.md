# Spec Delta

## Purpose

Defines reproducible release evidence for Taric's contracts, isolation, recovery, projection safety, adapter compatibility, and penetration-testing memory quality. These checks are acceptance gates, not a new runtime decision-maker.

## ADDED Requirements

### Requirement: Provide reproducible conformance and fault evaluation
The project SHALL provide repeatable tests for every versioned API/CLI/MCP operation, shared admission behavior, model/host/operator isolation, writer bypass resistance, idempotency, CAS conflicts, display identifier allocation, projection allowlists, and adapter capability reporting. The suite SHALL include concurrent writes, forced failures at transaction boundaries, lease takeover, stale generations, snapshot round-trip, and replay/reconcile cases.

#### Scenario: Run the clean-checkout suite
- **WHEN** a clean checkout installs dependencies and runs the documented build-then-test command
- **THEN** Core, CLI, MCP, projection, storage, recovery, and adapter conformance tests execute without relying on pre-existing build artifacts

#### Scenario: Exercise a forbidden path
- **WHEN** a model client, stale attempt, or self-asserted reviewer tries a protected operation
- **THEN** the suite observes a stable denial, verifies that canonical/projection/current action state is unchanged, and checks any attributable rejection or late-result event without allowing unauthorized history modification

#### Scenario: Exercise a crash point
- **WHEN** the test terminates the process at each declared commit, outbox, checkpoint, or projection publication boundary
- **THEN** restart either recovers a complete state or reports an explicit repair state, with no silent partial success

### Requirement: Evaluate poisoning and finding quality
The project SHALL maintain versioned known-positive and known-negative penetration-testing fixtures, representative web and host scenarios, and prompt-injection/memory-poisoning cases. Release reports SHALL include sample counts, finding precision and recall against a human baseline, retrieval precision/recall, unsupported-claim rate, erroneous memory propagation, coverage miss rate, review agreement, guard false-positive/negative results, write latency, and recovery success; statistical metrics SHALL include 95% confidence intervals.

#### Scenario: Run a known-positive case
- **WHEN** a representative fixture contains a supported finding and evidence
- **THEN** the evaluation records whether the finding is retrieved, preserved through review, and eligible for the required trust level

#### Scenario: Run a known-negative or blocked case
- **WHEN** a fixture contains a bounded negative observation or edge control block
- **THEN** the evaluation verifies that Taric does not convert it into a universal absence claim or origin-level coverage closure

#### Scenario: Inject untrusted instructions
- **WHEN** malicious instructions appear in an Artifact reference, tool response, Markdown draft, or proposal
- **THEN** they cannot alter policy, trust level, writer capability, host authorization, or projection allowlists

### Requirement: Enforce release gates
The release report SHALL state whether all documented gates pass: zero duplicate IDs in a 100-worker single-engagement concurrency run, a unique event for every successful commit, zero unauthorized L1-to-L2 promotions, no unsupported claims for high/critical findings, known-positive recall no worse than the recorded human baseline, visible untested and blocked coverage, adapter contract compatibility for each pinned host version, and patch-to-query visibility p95 at most two seconds for the documented single-host baseline. Every active recoverable WorkRun SHALL have a checkpoint, lease/owner, context manifest, and action state. Missing/unavailable model review SHALL remain proposal-only and SHALL NOT fail open. A failed required gate SHALL prevent a passing release report.

#### Scenario: Gate fails
- **WHEN** a required release metric or security/conformance test fails
- **THEN** the release is marked failed with the failing evidence and is not reported as implementation-complete

#### Scenario: Gate passes
- **WHEN** all required tests and documented thresholds pass for the pinned versions and configuration
- **THEN** the report records the exact commit, schema/policy digests, fixture versions, sample sizes, and pass result
