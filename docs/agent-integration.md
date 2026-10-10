# Taric Runtime Integration

This guide describes the implemented single-host profile. The compatibility manifest in `packages/core/src/compatibility.ts` is the source of truth for supported versions and capabilities; `capability.status` reports that same manifest.

## Supported Profile

| Surface | State | Contract |
|---|---|---|
| Core authority | Supported | One local SQLite WAL authority, guarded by Core |
| Operator CLI | Supported | JSON input/output, diagnostics on stderr, nonzero errors |
| Model MCP | Supported | stdio protocol with read, context, proposal, checkpoint-proposal, and action-recommendation tools |
| Pi native adapter | Supported | `@earendil-works/pi-coding-agent` 1.1.0, commit `7c10bd4` |
| Pi session lifecycle (`pi.session_lifecycle`) | Supported | `session_start` reaches Core through the authenticated client |
| Pi context injection (`pi.context_injection`) | Supported | `context` and `before_agent_start` return a Taric Context Pack |
| Pi proposal/checkpoint/action/result hooks (`pi.proposal_checkpoint_action_result_hooks`) | `unsupported_capability` | `integrate-native-host-adapters` |
| DeepSeek native adapter (`deepseek_native_adapter`) | `unsupported_capability` | `integrate-native-host-adapters` |
| Hermes native adapter (`hermes_native_adapter`) | `unsupported_capability` | `integrate-native-host-adapters` |
| PostgreSQL / shared authority (`storage.postgresql`) | `unsupported_capability` | `add-shared-authority-backend` |
| Remote Git push (`git.remote_push`) and external secret scanner (`secrets.external_scanner`) | `unsupported_capability` | `evolve-engagement-memory` |
| Full statistical quality evaluation (`quality.full_statistical_evaluation`) | `unsupported_capability` | `validate-memory-quality` |
| Full relation graph and impact propagation (`graph.relation_impact`) | `unsupported_capability` | `evolve-engagement-memory` |

## Boundaries

The host owns model calls, worker scheduling, target tools, credentials, human identity and approval, and Artifact bodies, retention, and redaction. Taric stores references and bounded evidence metadata; it does not execute a target action or grant authorization. An action recommendation remains advisory, and Taric does not replay unknown external actions.

Ordinary model context omits L0 and unrequested L1 records. Projection output uses explicit field allowlists and contains only L2 records. Artifacts, credentials, private filesystem paths, unreviewed proposals, and private drafts are not projection content. Local Git checkpoints are enabled by default; remote push remains unsupported regardless of boolean configuration.

## Local Setup

From a clean checkout, use Node.js 22 or newer:

```sh
npm ci
npm run build
npm test
```

The runtime uses Node's `node:sqlite` binding. A single Core service owns its authority file. Multiple local clients must use that service rather than opening independent writer stores.

## Follow-up Handoff

| Change | Implemented prerequisite in this profile | Deferred release gate |
|---|---|---|
| `integrate-native-host-adapters` | Versioned Core/adapter contract and Pi host baseline | Lock DeepSeek/Hermes versions, exercise real lifecycle hooks, and prove native/MCP conformance |
| `evolve-engagement-memory` | Versioned authority records, fixed read sequence, bounded context, checkpoint/action references, allowlisted local projection | Add revisions, typed graph/impact, resume delta, snapshot round-trip, migrations, remote Git and a real secrets scan |
| `validate-memory-quality` | Deterministic schema, governance, trust, context, coverage, and projection contracts | Run full poisoning corpus, human baseline, precision/recall and confidence-interval evaluation |
| `add-shared-authority-backend` | SQLite authority boundary and single-host storage contract | Implement PostgreSQL, multi-host lease/event ordering, and backend conformance |

Each handoff has a proposal, design, task list, and normative follow-up spec under `openspec/changes/<change>/`. The changes are prerequisites in the order stated by their task lists; this guide does not claim their deferred release gates have passed.
