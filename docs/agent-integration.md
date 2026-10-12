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
| DeepSeek native adapter (`deepseek_native_adapter`) | Partial: pinned DSH `0.2.0-rc.2` commit `639ed01` / Cordis `4.0.4` session events only; context, tool, checkpoint, action result, cancel and reload lifecycle hooks are unavailable in the pinned contract | MCP/CLI fallback |
| Hermes general plugin (`hermes_native_adapter`) | Partial: pinned Hermes `0.19.0` commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`; pre-LLM context and session/tool observer hooks over authenticated Core RPC; proposal/checkpoint/action hooks are not exposed by this integration; does not replace MemoryProvider | MCP/CLI fallback |
| PostgreSQL / shared authority (`storage.postgresql`) | `unsupported_capability` | `add-shared-authority-backend` |
| Remote Git push (`git.remote_push`) and external secret scanner (`secrets.external_scanner`) | Supported only through Engagement-authorized callbacks | `evolve-engagement-memory` |
| Full statistical quality evaluation (`quality.full_statistical_evaluation`) | `unsupported_capability` | `validate-memory-quality` |
| Versioned relation, patch merge, bounded impact and snapshot import | Supported through Core `resource.*` and `snapshot.import` operations |

## Boundaries

The host owns model calls, worker scheduling, target tools, credentials, human identity and approval, and Artifact bodies, retention, and redaction. Taric stores references and bounded evidence metadata; it does not execute a target action or grant authorization. An action recommendation remains advisory, and Taric does not replay unknown external actions.

Ordinary model context omits L0 and unrequested L1 records. Projection output uses explicit field allowlists and contains only L2 records. Artifacts, credentials, private filesystem paths, unreviewed proposals, and private drafts are not projection content. Local Git checkpoints are enabled by default; remote push requires a private repository, access and retention configuration, Engagement authorization, a real secrets-scan result, and a push callback.

Core exposes `resource.revise` for immutable ResourceRevision variants, `resource.relation` for typed same-Engagement edges, `resource.patch` for base-generation three-way merges with conflict evidence, and `resource.impact` for bounded continuation plus revalidation WorkItems. `snapshot.export` returns Taric-native JSON; `snapshot.import` validates schema, references, hashes, aliases, and destination state before one atomic import. JSONL uses one manifest line followed by record lines. Context cursors bind principal, Engagement, filters, ordering, pinned `read_seq`, and budget. Sealed drafts retain their original Attempt/generation and require explicit rebase before reuse.

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
| `integrate-native-host-adapters` | Versioned Core/adapter contract, locked host package contracts, scoped RPC and management commands | Complete host-supported event mapping, real-host contract runs, and native/MCP conformance |
| `evolve-engagement-memory` | Versioned revisions, typed graph/impact, pinned context recovery, snapshot round-trip, generation projection and local/authorized Git checkpoints | Future migration replay and shared authority remain separate changes |
| `validate-memory-quality` | Deterministic schema, governance, trust, context, coverage, and projection contracts | Run full poisoning corpus, human baseline, precision/recall and confidence-interval evaluation |
| `add-shared-authority-backend` | SQLite authority boundary and single-host storage contract | Implement PostgreSQL, multi-host lease/event ordering, and backend conformance |

Each handoff has a proposal, design, task list, and normative follow-up spec under `openspec/changes/<change>/`. The changes are prerequisites in the order stated by their task lists; this guide does not claim their deferred release gates have passed.

## Native adapter setup

The Hermes general plugin lives in `packages/hermes-plugin/`. Configure `TARIC_CORE_SOCKET`, `TARIC_ADAPTER_TOKEN` (at least 32 characters), and `TARIC_ENGAGEMENT_ID`; it raises a stable integration error when Core is unavailable. Start the Core-side Unix socket using `listenAdapterRpc(service, { socket_path, token, principal })`; the socket is restricted to mode `0600` and binds one host principal to one Engagement. The plugin never reads the authority database.

`taric adapter install`, `taric adapter remove`, `taric adapter config`, `taric adapter health`, and `taric adapter version` manage and inspect only Taric adapter configuration. Health reports the local Core process, manifest, configured adapter entries, and config path. These operations do not add missing host hooks. Unknown DSH/Hermes versions remain `unsupported_capability` and use MCP/CLI fallback.
