# Taric host integration profiles

Taric is an embeddable memory and governance plugin. It does not run models, select or launch agents, schedule tools, execute target-system operations, or authorize actions. The host/operator owns those responsibilities along with credentials, redaction, retention, and human-review workflow.

## Profiles

| Profile | Taric provides | Required host responsibility |
|---|---|---|
| Independent plugin baseline | Versioned Core/API, authority and governance state, host/operator interfaces, documented storage and recovery contracts | Select a transport and runtime topology; schedule agents/tools and authorize every target action |
| Bun in-process embedding (optional) | `@taric/core`, `@taric/schemas`, and `@taric/driver-bun-sqlite` package artifacts with a tested dependency closure | Pin the matching artifacts and host build; own lifecycle, scheduling, tools, authorization, credentials, and deployment paths |
| External Artifact reference (optional) | Opaque external references and metadata; Taric does not fetch the referenced payload | Store/read payload bytes and apply credential, redaction, retention, and deletion policy |
| Taric task-session spool (`taric_stored`, default storage mode) | Bounded integrity-checked storage for opaque bytes after explicit host authorization | Bind each task session to a durable root, protect and back up the spool, decide which bytes Taric may access, and own credential/redaction/retention policy |
| Review material (optional) | Deterministic review pack and attested review submission contract | Select reviewers, call any model, conduct human review, and produce the verdict |
| State notifications (optional) | Bounded, best-effort state hints with polling recovery | Re-read authoritative state and decide whether any host-side action is appropriate |

These integration paths are independently selected and verified; their existence does not make them requirements of every Taric deployment. Artifact storage defaults to Taric-managed bytes after the host binds a task-session root. `storage_mode: "external"` records a `host_ref` without retrieving its bytes. `resource_refs` and notifications are state/query hints, not resource locks or work commands.

## Version and package pairing

This release exposes Taric/workspace packages `1.0.0`, API contract `1.2.0`, schema `1.0.0`, and authority storage contract `authority-storage/3`. Check the generated [`compatibility-matrix.json`](../compatibility-matrix.json) before pairing a host with Taric. The matrix records operation schemas/errors, package exports and runtime dependencies, driver metadata, and certified host versions. On 2026-10-26, the 1.0.0 workspace build, typecheck, matrix check, tests, and clean tarball consumer passed; nine Core PostgreSQL-gated tests were skipped because no live test database was configured.

The Bun embedding profile uses versioned package artifacts; public npm publication is not required. Build the artifacts in dependency order:

```sh
npm run build --workspace @taric/schemas
npm run build --workspace @taric/core
npm run build --workspace @taric/driver-bun-sqlite
npm run verify:matrix
```

Create and install the package tarballs from a trusted release directory:

```sh
npm pack packages/schemas
npm pack packages/core
npm pack packages/driver-bun-sqlite
```

Install the three matching tarballs in the consumer together with the host's locked runtime dependencies. Do not rely on workspace links, TypeScript path aliases, or a separately built source tree. The clean consumer must import `AuthorityStore` and `BunSqliteAuthorityDriver`, open a temporary authority, then run shared runtime and driver-specific conformance. See the [Bun driver guide](authority-driver-guide.md) for the driver API and acceptance scenarios.

Taric uses exact contract-version matching. A host declaring API `1.1.0` is rejected by an API `1.2.0` service; deploy a matching host/Taric pair or a separately maintained earlier release. No compatibility shim or implicit downgrade is provided.

## Verification boundary

The current test and clean-consumer results verify Taric packages and local integration paths; they do not certify a real host scheduler, tool executor, action authorization policy, credential lifecycle, container mount, or external Artifact store. The 1.0.0 workspace run exercised the Bun driver suite, while the clean consumer smoke covered tarball installation/import and a live query. The saved PostgreSQL 17.11 runtime report is from a pre-1.0.0 candidate and used one authority host; it does not enable the current 1.0.0 PostgreSQL runtime. PostgreSQL activation still requires a fresh matching report and deployed health checks, and a two-process/multi-host deployment, remote gateway, container spool mount, and BreachWeave integration remain unverified. Pinned adapter tests for Pi, DeepSeek Harness, and Hermes do not by themselves certify a live third-party host deployment. Workspace packages remain private, so local tarball verification is not npm registry publication.
