# Spec Delta

## ADDED Requirements

### Requirement: Provide a bounded host state view before optional notifications

Taric SHALL expose an authenticated host/operator state view for one authorized Engagement per bounded request, returning a scope-safe watermark, fixed read time/freshness, L1 pending counts, conflicts/impact, unknown actions, and lease anomalies. Capability/runtime diagnostics SHALL respect the same authorization boundary. The view MUST NOT expose other Engagement existence, raw Artifact bytes, global sequence values, or global event history. Expiry and freshness SHALL be computed at the pinned read time even without a new commit. Periodic polling with retry/backoff SHALL remain correct when notifications are unavailable; incomplete scans MUST be explicit rather than reported as complete counts.

#### Scenario: Host reads its state view
- **WHEN** an authenticated host requests a state view for an authorized Engagement
- **THEN** Taric returns bounded aggregate state and watermarks for that Engagement without raw content or cross-Engagement metadata

#### Scenario: Scope is revoked
- **WHEN** a host loses Engagement or resource permission before a state read
- **THEN** the request returns an authorization error and does not disclose whether the prior view changed

#### Scenario: Polling observes a change
- **WHEN** a host polls after another process commits a change
- **THEN** the next authorized read can observe a later watermark even if no notification was delivered

#### Scenario: Lease expires without a commit
- **WHEN** a lease or freshness threshold expires between polls without any intervening authority commit
- **THEN** the next state read computes the expired status using its fixed read time and does not rely solely on a changed commit sequence

#### Scenario: Model requests the host queue
- **WHEN** a model principal requests the host state view
- **THEN** Taric returns an authorization error and the model tool inventory remains limited to the existing six tools

### Requirement: Keep optional state notifications best-effort

If state notifications are enabled, Taric SHALL treat them as bounded, best-effort, mergeable change hints. Delivery and ordering MUST NOT be required for correctness. Taric SHALL reauthorize subscriptions and reads, scope them to permitted resources, limit subscriptions and queued bytes, and disconnect slow consumers so clients can recover by polling and rereading state. Notifications MUST NOT invoke models, schedule work, or authorize actions.

Notification activation SHALL require measured polling cost or discovery latency to exceed a host budget recorded before measurement. For an MCP host surface, Taric SHALL negotiate a compatible protocol, expose resource discovery/read/subscribe/unsubscribe with stable resource URIs, and emit standard URI-only resource-updated notifications; authorized reads return scoped watermarks. Subscription registration SHALL close the read/subscribe race, cross-process changes SHALL remain detectable without stealing an outbox consumer, and reconnect SHALL reread state before advancing a locally completed range. Unsupported old positions SHALL require a new read, not general event replay.

#### Scenario: Notification is lost or duplicated
- **WHEN** a subscribed host misses or receives duplicate state notifications
- **THEN** polling and an authorized state read recover the current state without requiring event replay

#### Scenario: Subscription loses authorization
- **WHEN** a principal loses Engagement or resource access while subscribed
- **THEN** Taric cancels the affected subscription and sends no further information about that scope

#### Scenario: Subscriber is too slow
- **WHEN** a subscriber exceeds its bounded queue or delivery limit
- **THEN** Taric merges pending change hints or disconnects the subscriber, and polling remains the recovery path

#### Scenario: Polling meets its budget
- **WHEN** measured polling cost and discovery delay satisfy the host's recorded budgets
- **THEN** subscriptions remain disabled and polling is delivered without claiming subscription support

#### Scenario: Commit occurs during subscription registration
- **WHEN** another process commits after the initial read but before subscription registration completes
- **THEN** a watermark recheck or equivalent bounded check exposes the change and the host can recover it through an authorized read

### Requirement: Keep deferred import and replay paths explicitly unsupported

Snapshot import, general event replay, arbitrary Artifact path access, and unverified native transport activation SHALL return `unsupported_capability` or the applicable stable contract error. These responses MUST NOT create fallback SQLite state, partially modify authority, publish content, or reinterpret historical material as a current observation.

#### Scenario: Caller requests snapshot import
- **WHEN** an operator submits a snapshot import request through a public API
- **THEN** Taric returns an unsupported-capability error before mutation and leaves authority, counters, outbox, and projections unchanged

#### Scenario: Caller requests event replay
- **WHEN** a client requests a general replay or arbitrary historical event stream
- **THEN** Taric rejects the operation without exposing internal events or creating a replay cursor

#### Scenario: Multi-host readiness is missing
- **WHEN** an explicitly selected shared backend lacks matching current evidence or health
- **THEN** startup is blocked with a stable diagnostic and does not fall back to SQLite
