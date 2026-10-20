/**
 * The community blocklist as the app holds it: the entries last fetched (kept
 * in KV, so a block survives going offline) and a refresh from relays. Entries
 * are verified and folded by `blocklist.ts`.
 *
 * A failed fetch keeps what is held, and the app doesn't refuse to work
 * because a relay is down. Before the first fetch nothing is blocked.
 */
import { useMemo, useSyncExternalStore } from "react";

import { STOCK_RELAYS } from "@/concord/lib/stockRelays";
import { BLOCKLIST_AUTHORS, BLOCKLIST_KIND, foldBlocklist, isCommunityBlocked, type BlocklistEntry } from "@/lib/blocklist";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { DEPLOYMENT_RELAYS } from "@/lib/platform";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** What a refresh needs of the pool. */
export interface BlocklistPool {
  group(relays: string[]): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

const KV_KEY = "blocklist:events";
/** How old a fetch may be before {@link refreshBlocklist} fetches again. */
const FRESH_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
/** Plenty for years of entries; the list is read whole, never by `#d`. */
const FETCH_LIMIT = 1000;

const RELAYS = [...new Set([...STOCK_RELAYS, ...DEPLOYMENT_RELAYS])];

let events: NostrEvent[] = [];
let entries: Map<string, BlocklistEntry> = foldBlocklist(events, BLOCKLIST_AUTHORS);
let version = 0;
let fetchedAt = 0;
let inflight: Promise<void> | undefined;
let warming: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** Merge `incoming`, keeping only the newest event per entry, and tell subscribers if anything changed. */
function absorb(incoming: NostrEvent[]): boolean {
  const next = foldBlocklist([...events, ...incoming], BLOCKLIST_AUTHORS);
  const changed = next.size !== entries.size
    || [...next].some(([hash, entry]) => entries.get(hash)?.id !== entry.id);
  if (!changed) return false;
  const kept = new Set([...next.values()].map((entry) => entry.id));
  events = [...events, ...incoming].filter((event, i, all) => kept.has(event.id) && all.findIndex((e) => e.id === event.id) === i);
  entries = next;
  version++;
  for (const listener of listeners) listener();
  return true;
}

/** Load what the last session fetched. Once. */
function warm(): Promise<void> {
  warming ??= getArmadaDB().kv.get<NostrEvent[]>(KV_KEY)
    .then((cached) => {
      if (Array.isArray(cached)) absorb(cached);
    })
    .catch(() => undefined);
  return warming;
}

/**
 * Fetch the entries from relays, unless a fetch finished in the last
 * {@link FRESH_MS} (`force` skips that). Never throws.
 */
export function refreshBlocklist(pool: BlocklistPool, { force = false } = {}): Promise<void> {
  if (BLOCKLIST_AUTHORS.length === 0) return Promise.resolve();
  if (inflight) return inflight;
  if (!force && Date.now() - fetchedAt < FRESH_MS) return warm();
  inflight = (async () => {
    await warm();
    try {
      const fetched = await pool.group(RELAYS).query(
        [{ kinds: [BLOCKLIST_KIND], authors: BLOCKLIST_AUTHORS, limit: FETCH_LIMIT }],
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      fetchedAt = Date.now();
      if (absorb(fetched)) await getArmadaDB().kv.set(KV_KEY, events).catch(() => undefined);
    } catch {
      // Keep what is held.
    }
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

/** Whether `communityId` is blocked, by what is held right now. Not an id, not blocked. */
export function isBlockedNow(communityId: string): boolean {
  if (BLOCKLIST_AUTHORS.length === 0 || !/^[0-9a-f]{64}$/i.test(communityId)) return false;
  return isCommunityBlocked(entries, communityId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = () => version;

/**
 * {@link isBlockedNow}, re-rendering when the held entries change. A new
 * function each change, so memos that depend on it recompute.
 */
export function useIsBlocked(): (communityId: string) => boolean {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => {
    void current;
    return (communityId: string) => isBlockedNow(communityId);
  }, [current]);
}

/** For tests: forget everything. */
export function resetBlocklistForTests(): void {
  events = [];
  entries = foldBlocklist(events, BLOCKLIST_AUTHORS);
  version++;
  fetchedAt = 0;
  inflight = undefined;
  warming = undefined;
}
