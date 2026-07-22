import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { BUZZ_UNREAD_KINDS } from "@/buzz/kinds";
import { KIND_COMMENT, KIND_GROUP_CHAT } from "@/lib/nip29";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind — counts as inbox activity like chat does. */
const KIND_POLL = 1068;

/**
 * Kinds that can @-mention you inside a group: NIP-29 chat + polls + threaded
 * comments (NIP-22), plus the Buzz "new content" set (stream v2, forum
 * posts/comments). Kinds absent from a relay simply never match.
 */
const MENTION_KINDS = [
  ...new Set([KIND_GROUP_CHAT, KIND_POLL, KIND_COMMENT, ...BUZZ_UNREAD_KINDS]),
];

/** Newest mention events scanned per relay. */
const SCAN_LIMIT = 200;

/** One inbox entry: a message elsewhere on this server that mentions you. */
export interface InboxItem {
  /** The mentioning event. */
  event: NostrEvent;
  /** The group (`h` tag) the event belongs to. */
  groupId: string;
  /** Whether you haven't yet read past it in that channel. */
  unread: boolean;
}

export interface RelayInbox {
  /** Mentions across the server, newest first. */
  items: InboxItem[];
  /** How many of them are unread. */
  unreadCount: number;
}

const EMPTY: RelayInbox = { items: [], unreadCount: 0 };

/**
 * The server "inbox": every message across a relay's NIP-29 groups that
 * `#p`-tags the current user — the same mention signal the channel list shows
 * as an "@" pill, gathered into one mail-client-style list.
 *
 * Sourced from the shared IndexedDB event store (which the wire keeps fed), with
 * a throttled relay top-up for mentions older than the wire's live window. A
 * mention reads as unread until you've read past it in its channel
 * (`useReadState`), so opening the channel clears it — no separate read store.
 * Self-authored events never appear. Re-derived when the wire ingests activity
 * for any of the watched groups.
 */
export function useRelayInbox(
  relayUrl: string | undefined,
  groupIds: string[],
): RelayInbox {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { readState } = useReadState();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const idsKey = useMemo(() => [...groupIds].sort().join(","), [groupIds]);

  const queryKey = useMemo(
    () => ["nip29", "inbox", relayUrl, idsKey, user?.pubkey] as const,
    [relayUrl, idsKey, user?.pubkey],
  );

  const { data: mentions } = useQuery<NostrEvent[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      const ids = idsKey ? idsKey.split(",") : [];
      const cached = await store.query([
        { kinds: MENTION_KINDS, "#p": [user!.pubkey], "#h": ids, limit: SCAN_LIMIT },
      ]);

      // Top-up from the relay for mentions the wire's live window missed (older
      // history, or channels only just discovered). Best-effort: a slow/AUTH-
      // gated relay never blocks the cached result.
      try {
        const fresh = await nostr.relay(relayUrl!).query(
          [{ kinds: MENTION_KINDS, "#p": [user!.pubkey], limit: SCAN_LIMIT }],
          { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
        );
        const byId = new Map<string, NostrEvent>();
        for (const ev of [...cached, ...fresh]) byId.set(ev.id, ev);
        return [...byId.values()];
      } catch {
        return cached;
      }
    },
    enabled: Boolean(relayUrl && groupIds.length > 0 && user),
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Re-derive as soon as the wire ingests activity for any watched group.
  useWireScopes((scopes) => {
    if (!idsKey) return;
    for (const id of idsKey.split(",")) {
      if (scopes.has(`nip29:${id}`)) {
        void queryClient.invalidateQueries({ queryKey });
        return;
      }
    }
  });

  return useMemo(() => {
    if (!relayUrl || !user) return EMPTY;
    const groupSet = new Set(groupIds);
    const items: InboxItem[] = [];
    let unreadCount = 0;

    for (const event of mentions ?? []) {
      if (event.pubkey === user.pubkey) continue; // your own message isn't inbox
      const h = event.tags.find(([n]) => n === "h")?.[1];
      if (!h || !groupSet.has(h)) continue;
      if (!event.tags.some(([n, v]) => n === "p" && v === user.pubkey)) continue;

      const lastRead = readState[channelReadKey(relayUrl, h)] ?? 0;
      const unread = event.created_at > lastRead;
      if (unread) unreadCount++;
      items.push({ event, groupId: h, unread });
    }

    items.sort((a, b) => b.event.created_at - a.event.created_at);
    return { items, unreadCount };
  }, [relayUrl, user, mentions, readState, groupIds]);
}
