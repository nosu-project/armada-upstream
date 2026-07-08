import type { QueryClient } from "@tanstack/react-query";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Shared fan-out for incoming NIP-29 group activity (kind 9 chat / 1068 polls).
 *
 * Historically each ingestion path (the open channel's live `req`, the
 * per-relay unread tail, the Android native feed, the post-login catch-up)
 * wrote only its own cache: messages landed in `["nip29","messages",…]` but the
 * unread snapshot `["nip29","unread",…]` was never touched, so channel badges
 * went stale (messages synced, sidebar didn't light up). These helpers make
 * every ingestion path update BOTH planes, idempotently (dedupe by event id),
 * so it doesn't matter which transport saw the event first.
 */

/** Newest events retained per unread cache entry (badges only need recency). */
const UNREAD_CACHE_CAP = 600;

/** First value of an event's `#h` (group id) tag, if any. */
export function groupIdOf(ev: NostrEvent): string | undefined {
  for (const tag of ev.tags) if (tag[0] === "h" && tag[1]) return tag[1];
  return undefined;
}

/** Sort ascending (oldest-first) and de-duplicate a message list by id. */
function sortDedupe(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Append events into every matching per-relay unread cache
 * (`["nip29","unread", relayUrl, idsKey, pubkey]`, where `idsKey` is the
 * comma-joined sorted group-id list `useRelayUnread` watches).
 *
 * Matching is by group membership in `idsKey` — an event only enters caches
 * that watch its `#h` group — so a caller that doesn't know the host relay
 * (e.g. the native feed, which only has the wire event) still targets the
 * right entries. Appends are dedupe-by-id and capped to the newest
 * {@link UNREAD_CACHE_CAP}, so repeated delivery over multiple transports is
 * harmless.
 */
export function recordUnreadActivity(queryClient: QueryClient, events: NostrEvent[]): void {
  if (events.length === 0) return;

  const entries = queryClient.getQueryCache().findAll({ queryKey: ["nip29", "unread"] });
  for (const entry of entries) {
    // queryKey: ["nip29", "unread", relayUrl, idsKey, pubkey]
    const idsKey = entry.queryKey[3];
    if (typeof idsKey !== "string" || idsKey.length === 0) continue;
    const watched = new Set(idsKey.split(","));
    const mine = events.filter((ev) => {
      const gid = groupIdOf(ev);
      return gid !== undefined && watched.has(gid);
    });
    if (mine.length === 0) continue;

    queryClient.setQueryData<NostrEvent[]>(entry.queryKey as readonly unknown[], (old = []) => {
      const merged = sortDedupe([...old, ...mine]);
      if (merged.length === old.length) return old; // nothing new — keep identity
      // Keep only the newest slice; badges compare recency against read-state.
      return merged.slice(Math.max(0, merged.length - UNREAD_CACHE_CAP));
    });
  }
}

/**
 * Insert a timeline event (kind 9/1068) into every cached
 * `["nip29","messages", relayUrl, groupId]` entry for its group. The cache is
 * keyed by (relayUrl, groupId) but a NIP-29 group lives on a single host
 * relay, so matching on the group-id slot targets the right (and only)
 * timeline. No-op when the group has no cache entry yet — the durable
 * IndexedDB mirror (NostrBatcher caches every relay-delivered event) still
 * covers the first open. Returns true if any cache entry was touched.
 */
export function recordTimelineEvent(queryClient: QueryClient, ev: NostrEvent): boolean {
  const gid = groupIdOf(ev);
  if (!gid) return false;
  let touched = false;
  const entries = queryClient.getQueryCache().findAll({ queryKey: ["nip29", "messages"] });
  for (const entry of entries) {
    // queryKey: ["nip29", "messages", relayUrl, groupId]
    if (entry.queryKey[3] !== gid) continue;
    queryClient.setQueryData<NostrEvent[]>(entry.queryKey as readonly unknown[], (old = []) => {
      if (old.some((e) => e.id === ev.id)) return old;
      touched = true;
      return sortDedupe([...old, ev]);
    });
  }
  return touched;
}

/**
 * Fan a batch of incoming group activity into both planes: channel timelines
 * (existing entries only) and unread badge caches.
 */
export function recordGroupActivity(queryClient: QueryClient, events: NostrEvent[]): void {
  for (const ev of events) recordTimelineEvent(queryClient, ev);
  recordUnreadActivity(queryClient, events);
}
