# Context cursor recovery

> Last reviewed: 2026-10-27

The context cursor recovery tests passed in the `1.0.1` workspace validation on 2026-10-27. The scale numbers at the end of this page are from the pre-1.0.0 candidate experiment; they remain fixture-specific historical observations and are not 1.0.1 release measurements or an SLA.

`context.build` and `context.query` produce ordered, budgeted context from a fixed `read_seq`. Use the same principal, Engagement, policy version, worker role, WorkItem, filters, ordering, candidate setting, and character budget when continuing. Preserve those request fields together with the cursor. A continuation cannot change the source sequence or cross an Engagement boundary. MCP exposes the same cursor, filter, ordering, budget, and sequence inputs.

For SQLite, the cursor key root normally follows the authority's content directory. For direct PostgreSQL Core construction an explicit content root is required. Process startup can derive a root from its resolved dbPath even for PG, but deployments should explicitly set a durable per-host `TARIC_CONTENT_ROOT` because the database provides no filesystem for cursor keys or Artifact payloads. Every host needs its own durable root and its own authority-bound key; a cursor is not portable between principals, authorities, content roots, or host-local spool roots.

The AES-GCM cursor is versioned v2 and contains the snapshot ID, fixed sequence/read time, filters, the last priority/time/ID sort tuple, bounded dependency/delta IDs, and bindings. It contains no source record bodies or growing delivered-ID list. Core re-fetches only a bounded keyset page of canonical versions from the original sequence, restores stale dependency records and checkpoint/delta ordering, and returns an explicit continuation plus an unexamined range when the page cannot finish. Later updates, new admissions, or elapsed expiry dates do not change that sequence. The original expiry decision uses the fixed read time.

Context cursor v2 is distinct from authority list cursor v1 (HMAC using the same persisted key) and Artifact catalog/chunk cursors (scope/keyset metadata). Do not apply Context encryption, expiry or fixed read-sequence claims to all cursors. `read_time` is stored in the Context cursor; ContextPack reports the pinned `read_seq`, not a top-level public `read_time` field.

## Persisted key

Core initializes `.taric-context-cursor-key.v1` below the configured content root when a fresh request needs a cursor. The versioned JSON key document has mode 0600, a key ID, creation time, and a digest binding both the real content root and stable authority ID. Symlinked key files, invalid formats, copied keys from another authority/root, and any file mode other than 0600 are rejected. Separate processes using the same authority and root verify the same key. In-memory test stores receive isolated temporary roots unless a root is explicitly configured.

The key file is private authority state. Include it when backing up that authority and content root. Losing the key makes existing cursors invalid; restoring data without its original key does not restore those cursors. A fresh query can create a new missing key, while a continuation never creates or silently replaces one. Cursor failures return the stable `invalid_cursor` code with a content-free public message. A fresh request is the recovery path after key loss or expiry.

## Explicit rotation

An operator rotates the configured key with the Core utility. Supply the store authority ID and content root used by the service; `store` below is an initialized trusted backend:

```js
import { rotateContextCursorKey } from "@taric/core";

await store.ready;
const root = process.env.TARIC_CONTENT_ROOT;
if (!root) throw new Error("TARIC_CONTENT_ROOT is required");
const result = rotateContextCursorKey(root, store.authorityId);
console.log({ version: result.version, key_id: result.key_id });
```

Rotation writes a new 0600 file and atomically renames it over the previous key. Existing context and list cursors using that key become invalid, including cursors held by an already running instance; Core reloads the key for each verification. New queries use the replacement key. The utility returns a version and key ID and does not expose the secret or local path in a transport response.

## Recovery procedure

1. Stop the process that is producing the affected continuations, but keep the authority read-only if possible.
2. Verify that `TARIC_DB`, `TARIC_CONTENT_ROOT`, and the authority identity match the original deployment. For PostgreSQL, verify the selected database/schema and host-local content root separately.
3. Restore the cursor key together with the matching authority and content root, or rotate it deliberately when the key is lost or suspected compromised.
4. Run a fresh `context.query` without the old cursor. Do not retry an `invalid_cursor` response with a newly generated or copied cursor.
5. If the source sequence is no longer available, restart from a fresh read and record the new `read_seq` in the host's checkpoint or handoff metadata.

Key loss invalidates pagination state; it does not invalidate committed authority records. Key rotation has the same effect by design and should be announced to all clients sharing that authority/root.

## Cost and validation

The Core `buildContextPack` helper accepts `scanBudget` (2–1000 authority rows per page, including lookahead; default 256). Public service/CLI/MCP requests do not forward this camelCase option and use the default; `cursorTtlMs` is likewise a helper option (default one hour). read_stats reports scanned and returned rows, the configured bound, and whether continuation remains. A page uses a stable priority keyset: scope/ROE and target WorkItem precede checkpoints, deltas and stale/conflict/coverage gaps, then direct material and background records. omitted_count_complete is false while another bounded page remains, so an unexamined range is never presented as a complete count. Resume delta reads changed subjects and their events only inside the fixed sequence range; if subject or event cardinality exceeds the resume budget, Core returns minimum_budget_required instead of claiming a complete delta.

The cursor tests cover restart, two instances, key modes/loss/rotation/authority binding, tampering, principal/Engagement/filter/ordering/budget/sequence bindings, stale dependencies, checkpoint ordering, fixed versions, and no duplicate or omitted IDs. Mandatory context that cannot fit the character budget returns `minimum_budget_required` with a minimum described in the message, while remaining ranges are explicitly unexamined.

The historical [legacy run](benchmarks/authority-scale-v2-baseline.json) measured a 0.90-second first page at 10k and 5.36 seconds at 50k, with 9.2 kB cursors that grew on continuation (17.6→34.3 kB over three pages). The final bounded run in that pre-1.0.0 candidate experiment, [authority-scale-v3.json](benchmarks/authority-scale-v3.json), measured 0.53/3.08 seconds for the same fixtures, held the first-page and every continuation cursor at 1,039 bytes, and reported a 256-row scan ceiling (255 returned) on first and continuation pages. The 50k first page is 42.5% lower than the legacy sample, so the 50% reduction target was not reached on that host; these are host-and-fixture observations, not general SLA or 1.0.0 release evidence.
