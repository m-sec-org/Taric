# Spec Delta

## Purpose

Defines a versioned, host-independent integration contract so supported agent frameworks can exchange context and collaboration state without moving host execution policy into Taric.

## ADDED Requirements

### Requirement: Versioned adapter contract
The system SHALL define a versioned adapter contract for session lifecycle, context injection, proposal submission, worker/task attribution, checkpoint/handoff, action mode exchange, and host decision/result recording. Adapters SHALL declare only capabilities verified for their supported host versions.

#### Scenario: Adapter connects
- **WHEN** an adapter connects with a supported contract version
- **THEN** Taric validates its declared capabilities and exposes only compatible operations

#### Scenario: Adapter version is unsupported
- **WHEN** an adapter declares an unsupported contract version or capability
- **THEN** Taric reports incompatibility and does not infer unsupported lifecycle or enforcement behavior

### Requirement: Host-specific adapters remain thin
Native adapters SHALL map host lifecycle events to the shared Taric contract and SHALL NOT implement a separate authoritative memory store or duplicate Core admission rules.

#### Scenario: Host lifecycle event is received
- **WHEN** a supported host event requests context, submits a proposal, commits a checkpoint, or reports an action result
- **THEN** the adapter maps it to the corresponding versioned Taric API operation

#### Scenario: MCP-only host connects
- **WHEN** a host uses MCP without native lifecycle hooks
- **THEN** it can use supported read, context, proposal, and recommendation operations while missing lifecycle capabilities remain explicit

### Requirement: Hermes default integration coexists with memory providers
The default Hermes integration SHALL use a general plugin and SHALL NOT replace the host's selected external memory provider. A MemoryProvider integration is outside the default capability set.

#### Scenario: Install default Hermes integration
- **WHEN** the general plugin is enabled
- **THEN** Taric lifecycle integration is available without changing Hermes' external memory provider selection
