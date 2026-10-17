# Spec Delta

## MODIFIED Requirements

### Requirement: Maintain integrity, idempotency, and session isolation

Payload publication and its authority manifest/association SHALL use the existing operation-id/idempotency and audit mechanisms. A successful write MUST expose both verified payload and committed metadata; a failed or interrupted write MUST expose neither as available content and MUST leave a recoverable operation marker. Artifact bytes SHALL become `available` only after manifest, chunk lengths/hashes, session binding, publication marker, and catalog publication checks pass. Every payload and execution record SHALL belong to exactly one Engagement and registered task session. Missing, deleted, tampered, or unreadable files SHALL return structured `unavailable`/`integrity_failed` status and SHALL not be treated as available Evidence. Taric SHALL not silently recreate or delete payloads when a host changes the session filesystem; retention and deletion remain explicit host/operator actions. Transport support MUST NOT allow arbitrary path reads, infer capture truth, or redact opaque content.

#### Scenario: Retry a content write
- **WHEN** a host retries the same content write with the same idempotency key and normalized upload metadata
- **THEN** Taric returns the original content reference and does not create a second payload or execution association

#### Scenario: Detect file tampering
- **WHEN** a stored payload chunk differs from its manifest hash or the session manifest is incomplete
- **THEN** Taric reports an integrity failure, excludes the payload from Evidence/output, and preserves the authority audit state for repair

#### Scenario: Isolate two task sessions
- **WHEN** a caller uses a valid Artifact reference or path-derived locator from another Engagement or task session
- **THEN** Taric rejects the read or association without revealing the other session's content or metadata

#### Scenario: Catalog commit races file publication
- **WHEN** file publication and catalog commit complete in different orders
- **THEN** reads report pending/unavailable or verified available according to recorded markers and never expose an unverified file as evidence

## ADDED Requirements

### Requirement: Enforce and measure Artifact transport and resource bounds

Each supported Artifact transport SHALL declare decoded-byte, encoded-envelope, metadata, queue, and page limits. The service SHALL preserve the 64 MiB decoded chunk contract, apply bounded receive/backpressure, reject oversized or malformed input before publication, and keep uncommitted content unreadable. Measurements SHALL cover real process-to-process transport, text and binary payloads, one and two uploads, slow consumers, decode/copy/hash/publication phases, elapsed time, throughput, peak RSS, event-loop delay, failure count, and publication status.

#### Scenario: Valid maximum chunk
- **WHEN** an authorized host sends one 64 MiB decoded chunk through a declared transport
- **THEN** the service accepts it within the transport envelope, reports the bounded operation state, and preserves the content hash on commit

#### Scenario: Encoded envelope exceeds the limit
- **WHEN** a request's encoded payload or metadata exceeds the declared transport bound
- **THEN** the service rejects it before publication, leaves no readable partial Artifact, and returns a stable validation error or the transport's documented bounded framing rejection without dispatching a mutation

#### Scenario: Slow consumer or interrupted process
- **WHEN** a receiver cannot drain an upload or the process stops during staging/publication
- **THEN** queues remain bounded, the Artifact is unavailable/quarantined until verified recovery, and the measurement records the failure without claiming power-loss durability

