# Proposal

## Why

Long-running penetration tests split work across agents, sessions, and tools, but their findings, evidence, coverage, and checkpoints need one consistent, reviewable memory. Taric's design defines that boundary and the deployment defaults; this change turns it into a versioned, implementable contract while keeping execution, HITL, credentials, and Artifact lifecycle decisions with the host application.

## What Changes

- Define Taric's PTES-oriented engagement memory contract for resources, observations, claims, evidence references, findings, coverage, and context packs.
- Specify proposal-only agent writes, deterministic admission, independent finding review, trust levels, and append-only audit events.
- Specify concurrent authority updates, Markdown projections, local Git checkpoints, and access-controlled sharing.
- Specify WorkItem/WorkRun/Attempt persistence, leases, checkpoints, handoffs, action intent references, and safe recovery semantics.
- Define a host adapter contract and initial Pi, DeepSeek Harness, and Hermes integration boundaries; default Hermes to a general plugin.
- Provide host action recommendation and decision/result recording interfaces for `llm_recommend`, `authorized_autonomous`, and `host_hitl`; Taric does not decide or execute actions.
- Keep Artifact storage, retention, redaction, credential storage/injection, human approver identity, and audit signing-key custody outside Taric.

## Capabilities

### New Capabilities
- `engagement-memory`: PTES engagement data, evidence references, retrieval, and context packs.
- `memory-governance`: proposal admission, review levels, trust state, and audit events.
- `collaboration-state`: durable work runs, checkpoints, handoffs, and recovery.
- `host-adapters`: versioned adapter contract and framework integrations.
- `host-action-integration`: action recommendations and host decision/result recording.
- `markdown-projection`: allowlisted Markdown projection and local/opt-in remote Git checkpoints.

### Modified Capabilities

None. This repository has no existing OpenSpec capabilities.

## Impact

- Establishes the TypeScript/Node.js Core, versioned JSON Schema, SQLite WAL single-host authority, and PostgreSQL option for multi-host sharing described in `docs/taric-design.md`.
- Defines MCP, CLI, and native-adapter surfaces without granting model-facing tools canonical writer or action-execution authority.
- Adds adapter contract tests and storage/projection conformance tests as implementation acceptance criteria.
- Leaves target-system tool execution and the host's authorization policy unchanged and host-owned.
