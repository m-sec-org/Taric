# Local PostgreSQL with OrbStack

The latest saved [runtime verification](benchmarks/postgres-runtime-v2.json) passed all 12 scenarios on PostgreSQL 17.11 and an independent `pg_dump`/`pg_restore` check of 24 tables (audit sequence 107→107). This supplements the older availability check below; it does not establish that a container is currently healthy or that a saved report matches a rebuilt release. Generate a fresh report for the selected candidate and deployment when required.

> Last reviewed: 2026-10-18

`compose.postgres.yaml` starts one Taric-only PostgreSQL service on the active Docker context. It publishes **only** `127.0.0.1:55432`, uses the `taric-authority` Compose project, and persists data in the named volume `taric-authority-postgres-data`. It does not depend on or manage other development containers.

This is a local development/test deployment, not a production configuration. The checked-in password is public and the `taric` role is a database superuser created by the official image. Do not expose this service publicly or reuse its credentials. A production deployment needs operator-managed secrets, least-privilege roles, TLS, backup/recovery, and separate operational review.

## Start and check

Run from the repository root with OrbStack running:

```sh
docker context show
docker compose -f compose.postgres.yaml config --quiet
docker compose -f compose.postgres.yaml up -d --wait --wait-timeout 90
docker compose -f compose.postgres.yaml ps
docker compose -f compose.postgres.yaml exec -T postgres pg_isready -h 127.0.0.1 -U taric -d taric
```

The generated container name is `taric-authority-postgres-1`. Check that neither this name, the named volume, nor port `55432` belongs to another deployment before first use. Do not use `--remove-orphans`, broad cleanup commands, or other Compose files against this project.

The image is pinned to PostgreSQL **17.11**, Debian Bookworm, with the multi-platform image digest:

```text
postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
```

The PostgreSQL 17 volume target is `/var/lib/postgresql/data`, as required by the [official image documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata). PostgreSQL 18 uses a different data-directory layout; do not change major versions in place on this volume. Updating a digest is an explicit operator action, not an automatic startup upgrade.

Initial verification on 2026-10-14 used Docker context `orbstack` and Compose `v2.36.2`: the container reported `healthy` with zero failing checks, password-authenticated SQL returned `taric` for both database and user, and the host TCP endpoint was reachable. The running version was `PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2)` on `x86_64`. This records deployment availability, not Taric runtime conformance.

## Connect and run live tests

Host connection URL (public development credentials):

```text
postgresql://taric:taric-local-only@127.0.0.1:55432/taric
```

The container includes `psql`, so no host PostgreSQL installation is needed. This command checks password-authenticated TCP access, the selected database/user, and the running server version:

```sh
docker compose -f compose.postgres.yaml exec -T -e PGPASSWORD=taric-local-only postgres \
  psql -h 127.0.0.1 -U taric -d taric -v ON_ERROR_STOP=1 \
  -c 'SELECT current_database(), current_user, version();'
```

The workspace installs the `pg` driver. Build, then run both live storage and full Core conformance:

```sh
npm run build
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  node --test packages/core/test/postgres-live.test.mjs packages/core/test/runtime-conformance.test.mjs
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  TARIC_TEST_POSTGRES_CONTAINER=taric-authority-postgres-1 \
  node scripts/verify-postgres-runtime.mjs --output docs/benchmarks/postgres-runtime-v2.json
```

Tests use isolated schemas inside this development database; do not point the test URL at production. A skipped live test is missing evidence. Container health alone does not enable runtime: see [PostgreSQL runtime readiness](postgres-runtime-readiness.md) for the separate gate.

`TARIC_TEST_DATABASE_URL` is test-harness input only. The process-facing runtime uses `TARIC_DATABASE_URL` together with `TARIC_AUTHORITY_PROFILE=multi_host_authority`; do not point a production host at a report generated from a different database/schema or build.

## Initialize and activate Taric

Apply the common layout to the deployed authority before startup. This command only initializes Taric's `taric` schema and does not create conformance fixture records:

```sh
TARIC_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric node --input-type=module -e '
import { Pool } from "pg";
import { PostgresAuthorityStore } from "./packages/core/dist/index.js";
const pool = new Pool({ connectionString: process.env.TARIC_DATABASE_URL });
try { await new PostgresAuthorityStore(pool, { profile: "multi_host_authority" }).migrate(); }
finally { await pool.end(); }
'
```

With a passing activation report for the current build, CLI and MCP select the same authority:

```sh
export TARIC_AUTHORITY_PROFILE=multi_host_authority
export TARIC_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric
export TARIC_HOST_ID=local-orbstack
export TARIC_LEASE_MODE=server_side
export TARIC_RUNTIME_CONFORMANCE="$PWD/docs/benchmarks/postgres-runtime-v2.json"
export TARIC_CONTENT_ROOT="$PWD/.taric/content"
node packages/cli/dist/bin.js capability.status
```

Set `TARIC_ENGAGEMENT_ID` when using the model MCP interface, and start `node packages/mcp/dist/bin.js`. Before accepting writes, confirm that the diagnostics report `runtime_state=enabled`, `backend=postgresql`, and server-side fencing. Neither an absent/mismatched report nor a database health failure creates a SQLite fallback. Changing the Core implementation or schema/policy digest invalidates the saved activation evidence; rebuild and rerun verification. Keep the report and its permissions operator-controlled; runtime startup consumes it but never regenerates it.

## Operate without losing data

```sh
docker compose -f compose.postgres.yaml logs --tail 100 postgres
docker compose -f compose.postgres.yaml stop postgres
docker compose -f compose.postgres.yaml up -d --wait --wait-timeout 90
```

Stopping or recreating this service retains its named volume. Do not remove the volume unless an explicit, separately reviewed data reset is intended. The official image's initialization variables apply only to an empty data directory; changing a password in Compose does not rotate an existing database password. See the [official environment-variable documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md#environment-variables).

For a deliberate local reset, stop the service first, record the data-loss decision, and remove only the named volume `taric-authority-postgres-data` through the same Compose project. Never use `down -v` or broad Docker cleanup commands when other deployments share the Docker context.
