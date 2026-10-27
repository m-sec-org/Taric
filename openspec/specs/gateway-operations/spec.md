# gateway-operations Specification

## Purpose

Provide narrowly scoped operational controls for supervising the existing Taric gateway, including authenticated readiness visibility and deterministic configuration replacement, without changing Core authorization, authority coordination, or host execution responsibilities.

## Requirements

### Requirement: Gateway status reports authenticated readiness
The gateway SHALL provide an authenticated status operation that distinguishes listener liveness from authority readiness and reports backend, schema/policy identity, and shared-authority fencing state without returning credentials or token material.

#### Scenario: Gateway and authority are ready
- **WHEN** an authenticated operator or permitted host queries gateway status after listeners are bound and the selected authority passes readiness checks
- **THEN** the response reports listener availability and authority readiness with the selected backend and compatibility identity

#### Scenario: Listener is alive but authority is unavailable
- **WHEN** the gateway process is accepting transport connections but the authority is unavailable, fenced, or has failed activation checks
- **THEN** status reports liveness separately from readiness and authority operations remain fail-closed without opening a SQLite fallback

#### Scenario: Unauthenticated status request
- **WHEN** a caller queries status without a valid gateway credential or with a principal lacking the status permission
- **THEN** the gateway rejects the query without disclosing backend credentials, token entries, or filesystem secrets

### Requirement: Gateway configuration reload is atomic and revokes active identities
The gateway SHALL support an explicit operator-triggered reload of listener and token configuration that validates the complete replacement before activation, preserves the previous configuration on failure, and closes existing authenticated connections after a successful replacement.

#### Scenario: Valid configuration is reloaded
- **WHEN** an operator requests reload with a valid listener, TLS, and token configuration
- **THEN** the gateway atomically activates the replacement, reports the new non-secret configuration identity, and requires existing clients to authenticate again

#### Scenario: Invalid replacement is rejected
- **WHEN** a reload contains malformed tokens, invalid TLS material, or unsupported listener settings
- **THEN** the gateway keeps the prior active configuration, returns a structured failure, and does not partially bind or remove listeners

#### Scenario: Reload does not create a credential store
- **WHEN** the gateway reloads a token table
- **THEN** it reads operator-managed configuration only, does not issue or persist bearer secrets in authority state, and preserves one-token-to-one-principal/Engagement binding
