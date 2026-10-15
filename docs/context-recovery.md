# Context cursor recovery

`context.build` and `context.query` produce ordered, budgeted context from a fixed `read_seq`. Use the same principal, Engagement, policy version, worker role, WorkItem, filters, ordering, candidate setting, and character budget when continuing. Preserve those request fields together with the cursor. A continuation cannot change the source sequence or cross an Engagement boundary. MCP exposes the same cursor, filter, ordering, budget, and sequence inputs.

The AES-GCM cursor contains the snapshot ID, fixed sequence/read time, filters, offset, delivered IDs, dependency/delta IDs, and bindings. It contains no source record bodies. Core re-fetches canonical versions from the original sequence, restores stale dependency records and checkpoint/delta ordering, and returns the next unexamined range without duplicate or omitted IDs. Later updates, new admissions, or elapsed expiry dates do not change that sequence. The original expiry decision uses the fixed read time.

## Persisted key

Core initializes `.taric-context-cursor-key.v1` below the configured content root when a fresh request needs a cursor. The versioned JSON key document has mode 0600, a key ID, creation time, and a digest binding both the real content root and authority path. Symlinked key files, invalid formats, copied keys from another authority/root, and any file mode other than 0600 are rejected. Separate processes using the same authority and root verify the same key. In-memory test stores receive isolated temporary roots unless a root is explicitly configured.

The key file is private authority state. Include it when backing up that authority and content root. Losing the key makes existing cursors invalid; restoring data without its original key does not restore those cursors. A fresh query can create a new missing key, while a continuation never creates or silently replaces one. Cursor failures return the stable `invalid_cursor` code with a content-free public message. A fresh request is the recovery path after key loss or expiry.

## Explicit rotation

An operator rotates the configured key with the Core utility. Supply the exact authority path and content root used by the service:

```js
import { rotateContextCursorKey } from "@taric/core";

await store.ready;
const result = rotateContextCursorKey(process.env.TARIC_CONTENT_ROOT, store.authorityId);
console.log({ version: result.version, key_id: result.key_id });
```

Rotation writes a new 0600 file and atomically renames it over the previous key. Existing context and list cursors using that key become invalid, including cursors held by an already running instance; Core reloads the key for each verification. New queries use the replacement key. The utility returns a version and key ID and does not expose the secret or local path in a transport response.

## Cost and validation

The [authority benchmark](authority-storage-runbook.md#reproduce-scale-measurements) records first-page cost separately from three continuation samples at 10k and 50k records. Slimmer wire state avoids embedding all record bodies, but continuation still re-reads and sorts the pinned snapshot. Delivered-ID state can grow with pages, so cursor size is measured explicitly. No constant-time or O(1) memory guarantee is advertised.

The cursor tests cover restart, two instances, key modes/loss/rotation/authority binding, tampering, principal/Engagement/filter/ordering/budget/sequence bindings, stale dependencies, checkpoint ordering, fixed versions, and no duplicate or omitted IDs. Mandatory context that cannot fit the character budget returns `minimum_budget_required` with its minimum, while remaining ranges are explicitly unexamined.

The [recorded run](benchmarks/authority-scale-v1.json) measured a 1.08-second first page at 10k and 3.79 seconds at 50k. Continuation samples were 1.91/11.55/2.34 seconds and 2.72/3.59/3.36 seconds respectively. Each page delivered 161 claim records under a 64,000-character budget. Cursor size grew from 9.2 kB after the first page to 34.3 kB after four pages because delivered IDs are retained. Peak RSS includes worker startup validation: 128 MiB at 10k and 400 MiB at 50k. The report keeps the 10k slow continuation sample visible and does not equate small-fixture or mutation p95 with context recovery latency.
