import type { AuthorityStore, CanonicalRecord, TrustLevel } from "./store.js";

export interface ContextPack { read_seq: number; items: CanonicalRecord[]; omitted_count: number; omitted_as_unexamined: boolean; cursor?: string; sources: string[]; }

function estimate(record: CanonicalRecord): number { return JSON.stringify(record).length; }

export function buildContextPack(store: AuthorityStore, engagementId: string, budget: number, options: { includeCandidates?: boolean } = {}): ContextPack {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError("budget must be a positive integer");
  const snapshot = store.snapshot(engagementId, options);
  const items: CanonicalRecord[] = []; let used = 0; let omitted = 0;
  for (const item of snapshot.records) {
    const size = estimate(item);
    if (used + size > budget) { omitted += 1; continue; }
    items.push(item); used += size;
  }
  return { read_seq: snapshot.read_seq, items, omitted_count: omitted, omitted_as_unexamined: omitted > 0, cursor: omitted ? `after:${items.at(-1)?.id ?? "start"}` : undefined, sources: items.map((item) => item.id) };
}
