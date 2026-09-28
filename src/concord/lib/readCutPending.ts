/**
 * Durable read-cut intent — the failure half of a rotating ban. A ban is
 * Banlist → grant strip → Refounding; the rotation can fail on a relay outage,
 * so the intent is marked BEFORE and cleared only on success, and the next visit
 * retries it.
 *
 * The KEEP list is captured at ban time; a retry must never rebuild it from
 * whatever roster the retrying surface holds (a cold view would rotate out
 * members). Keyed per (account, community) in ArmadaDB KV; await
 * {@link readCutPendingReady} before trusting a miss.
 */
import { KvPrefixCache } from "@/lib/db/kvCache";

export interface ReadCutIntent {
  /** Pubkeys (hex) still owed a read-cut. */
  targets: string[];
  /** The keep-list captured when the ban was issued. */
  keep: string[];
}

const cache = new KvPrefixCache<ReadCutIntent>({ prefix: "read-cut-pending:" });

const id = (me: string, communityIdHex: string) => `${me}:${communityIdHex}`;

/** Load the persisted intents. Await before treating a miss as "nothing owed". */
export function readCutPendingReady(): Promise<void> {
  return cache.ready();
}

export function readCutPending(me: string, communityIdHex: string): ReadCutIntent | undefined {
  const parsed = cache.get(id(me, communityIdHex));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { targets, keep } = parsed;
  if (!Array.isArray(targets) || !Array.isArray(keep)) return undefined;
  const strings = (a: unknown[]) => a.filter((p): p is string => typeof p === "string");
  const cleaned = { targets: strings(targets), keep: strings(keep) };
  return cleaned.targets.length > 0 ? cleaned : undefined;
}

/**
 * Add a target (idempotent); the freshest keep-list wins, minus all targets.
 * The await is load-bearing: this merges with persisted state, and an unwarmed
 * cache would overwrite and drop earlier targets.
 */
export async function addReadCutPending(
  me: string,
  communityIdHex: string,
  target: string,
  keep: string[],
): Promise<void> {
  await cache.ready();
  const prior = readCutPending(me, communityIdHex);
  const targets = new Set(prior?.targets ?? []);
  targets.add(target);
  const nextKeep = keep.filter((pk) => !targets.has(pk));
  cache.set(id(me, communityIdHex), { targets: [...targets], keep: nextKeep });
}

/** Clear the pending intent (cut landed, or went moot). */
export function clearReadCutPending(me: string, communityIdHex: string): void {
  cache.delete(id(me, communityIdHex));
}
