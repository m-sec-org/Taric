# Spec Delta

## MODIFIED Requirements

### Requirement: Versioned adapter contract
The system SHALL define a versioned adapter contract for session lifecycle, context injection, proposal submission, worker/task attribution, checkpoint/handoff, action mode exchange, and host decision/result recording. Adapters SHALL declare only capabilities verified for their supported host versions. Every operation SHALL enforce capability scope and expose installation, configuration, removal, health, and version diagnostics without direct store access.

#### Scenario: Adapter connects
- **WHEN** an adapter connects with a supported contract version
- **THEN** Taric validates its declared capabilities and exposes only compatible operations

#### Scenario: Adapter version is unsupported
- **WHEN** an adapter declares an unsupported contract version or capability
- **THEN** Taric reports incompatibility and does not infer unsupported lifecycle or enforcement behavior

#### Scenario: Capability is declared but hook is unavailable
- **WHEN** the supported runtime does not provide a declared hook in its current mode
- **THEN** the adapter reports that capability unavailable and does not silently simulate it

### Requirement: Host-specific adapters remain thin
Native adapters SHALL map host lifecycle events to the shared Taric contract and SHALL NOT implement a separate authoritative memory store or duplicate Core admission rules. Pi, pinned DeepSeek Harness, and Hermes integrations SHALL provide executable lifecycle registration and transport calls for their tested capabilities. Adapter retries and host reload SHALL preserve committed state and map cancellation/errors explicitly.

#### Scenario: Host lifecycle event is received
- **WHEN** a supported host event requests context, submits a proposal, commits a checkpoint, or reports an action result
- **THEN** the adapter maps it to the corresponding versioned Taric API operation

#### Scenario: MCP-only host connects
- **WHEN** a host uses MCP without native lifecycle hooks
- **THEN** it can use supported read, context, proposal, and recommendation operations while missing lifecycle capabilities remain explicit

#### Scenario: Host reload after checkpoint
- **WHEN** a host reloads after a checkpoint commit
- **THEN** the adapter can retrieve committed state without duplicating the checkpoint or claiming uncommitted progress

#### Scenario: Load a tested native host extension
- **WHEN** a Pi or DeepSeek Harness extension is loaded through the host's actual extension API with the pinned host version/commit metadata
- **THEN** lifecycle callbacks are registered and the adapter reports only capabilities covered by real runtime contract tests

#### Scenario: Host version is outside the tested window
- **WHEN** a host version or preview commit is not present in the adapter compatibility manifest
- **THEN** the adapter reports an unsupported-version diagnostic and falls back to MCP/CLI capabilities without claiming native lifecycle support

### Requirement: Hermes default integration coexists with memory providers
The default Hermes integration SHALL use a general plugin and SHALL NOT replace the host's selected external memory provider. A MemoryProvider integration is outside the default capability set. The plugin SHALL register supported hooks and communicate with Core; a failed request SHALL surface a clear error and SHALL NOT claim state was stored.

#### Scenario: Install default Hermes integration
- **WHEN** the general plugin is enabled
- **THEN** Taric lifecycle integration is available without changing Hermes' external memory provider selection

#### Scenario: Core service is unavailable
- **WHEN** the plugin cannot communicate with Core
- **THEN** the host sees an integration error and existing external memory configuration remains unchanged
