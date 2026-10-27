# Taric host integration profiles

Taric is an embeddable memory and governance plugin. It does not run models, select or launch agents, schedule tools, execute target-system operations, or authorize actions. The host/operator owns those responsibilities along with credentials, redaction, retention, and human-review workflow.

## Profiles

| Profile | Taric provides | Required host responsibility |
|---|---|---|
| Independent plugin baseline | Versioned Core/API, authority and governance state, host/operator interfaces, documented storage and recovery contracts | Select a transport and runtime topology; schedule agents/tools and authorize every target action |
| Bun in-process embedding (optional) | `@taric/core`, `@taric/schemas`, and `@taric/driver-bun-sqlite` package artifacts with a tested dependency closure | Pin the matching artifacts and host build; own lifecycle, scheduling, tools, authorization, credentials, and deployment paths |
| Central remote gateway (optional) | Existing Core API through TLS TCP connection-oriented JSON-RPC or HTTPS request/response, fixed token-to-principal mapping | Protect the TLS config/key and tokens, restrict network reachability, provide the current PostgreSQL activation evidence, and decide how remote Artifact bytes and retention are managed |
| External Artifact reference (optional) | Opaque external references and metadata; Taric does not fetch the referenced payload | Store/read payload bytes and apply credential, redaction, retention, and deletion policy |
| Taric task-session spool (`taric_stored`, default storage mode) | Bounded integrity-checked storage for opaque bytes after explicit host authorization | Bind each task session to a durable root, protect and back up the spool, decide which bytes Taric may access, and own credential/redaction/retention policy |
| Review material (optional) | Deterministic review pack and attested review submission contract | Select reviewers, call any model, conduct human review, and produce the verdict |
| State notifications (optional) | Bounded, best-effort state hints with polling recovery | Re-read authoritative state and decide whether any host-side action is appropriate |

These integration paths are independently selected and verified; their existence does not make them requirements of every Taric deployment. Artifact storage defaults to Taric-managed bytes after the host binds a task-session root. `storage_mode: "external"` records a `host_ref` without retrieving its bytes. `resource_refs` and notifications are state/query hints, not resource locks or work commands.

## Version and package pairing

This release exposes runtime components `1.0.1` (`@taric/cli`, `@taric/core`, `@taric/schemas`, `@taric/driver-bun-sqlite`, and `@taric/mcp`), while the private root workspace and Hermes plugin remain `1.0.0`; API contract `1.2.0`, schema `1.0.0`, and authority storage contract `authority-storage/3` are unchanged. Check the generated [`compatibility-matrix.json`](../compatibility-matrix.json) before pairing a host with Taric. The matrix records operation schemas/errors, package exports and runtime dependencies, driver metadata, and certified host versions. On 2026-10-27, build, typecheck, matrix validation and the PostgreSQL-configured workspace suites passed (Core 356/356 with no skipped live tests, CLI 37/37, Bun 11/11, MCP 12/12, and Schemas 10/10). Current runtime, backup/restore, multi-host and spool reports were generated for the `1.0.1` build.

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

The current tests verify Taric packages, loopback TLS TCP/HTTPS and local integration paths; they do not certify a real host scheduler, tool executor, action authorization policy, credential lifecycle, production TLS termination, or external Artifact store. Current-source PostgreSQL 17.11 live conformance and independent logical backup/restore passed, and two concurrent host containers with distinct IDs coordinated through the OrbStack bridge on one workstation. Cross-machine PostgreSQL coordination and network interruption recovery remain unverified. The container spool check passed across two sequential Node containers on one bind mount; it does not certify a third-party host or multiple hosts sharing writable spool storage. Pi 1.4.0 was installed in an isolated temporary directory and started in RPC mode; the Taric extension loaded through Pi's real `ExtensionAPI` and registered its lifecycle hooks/tool. This smoke made no model-provider or external-tool calls. DeepSeek Harness and Hermes host processes were not installed; their adapter/plugin contract tests alone do not certify those hosts. The optional gateway supports local Unix socket, TLS TCP and HTTPS; HTTPS clients use state reads rather than subscriptions. Workspace packages remain private, so local tarball verification is not npm registry publication.

The local host-contract checks can be repeated with:

```sh
node --test packages/core/test/host-adapters.test.mjs packages/core/test/gateway.test.mjs packages/cli/test/gateway.test.mjs
npm test --workspace @taric/hermes-plugin
npm test --workspace @taric/driver-bun-sqlite
node scripts/verify-pi-host-live.mjs --output /tmp/taric-pi-host-current.json
```

The first three commands use adapter API fixtures and an in-process Bun host example. To run the Pi smoke from a fresh checkout, first install the matrix-pinned package outside the workspace, then launch the check:

```sh
npm install --prefix /tmp/taric-pi-host-probe --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.4.0
node scripts/verify-pi-host-live.mjs --output /tmp/taric-pi-host-current.json
```

The script starts a real Pi RPC process, loads the Taric extension and checks registered capabilities without invoking a model or external tool. Set `TARIC_PI_HOST_PACKAGE` if the isolated package is installed elsewhere. This is a host-loading smoke, not complete scheduler, credential, tool-authorization or action-lifecycle certification.
