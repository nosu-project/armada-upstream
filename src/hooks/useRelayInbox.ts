import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { BUZZ_UNREAD_KINDS } from "@/buzz/kinds";
import { KIND_COMMENT, KIND_GROUP_CHAT } from "@/lib/nip29";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-88 poll kind — counts as inbox activity like chat does. */
const KIND_POLL = 1068;

/**
 * Kinds that can @-mention you in a group: NIP-29 chat, polls, NIP-22 comments, and the Buzz
 * "new content" set.
 */
const MENTION_KINDS = [
  ...new Set([KIND_GROUP_CHAT, KIND_POLL, KIND_COMMENT, ...BUZZ_UNREAD_KINDS]),
];

const SCAN_LIMIT = 200;

export interface InboxItem {
  event: NostrRumor;
  /** The group (`h` tag) the event belongs to. */
  groupId: string;
  /** Not yet read past in its channel. */
  unread: boolean;
}

export interface RelayInbox {
  items: InboxItem[];
  unreadCount: number;
}

const EMPTY: RelayInbox = { items: [], unreadCount: 0 };

/**
 * Server "inbox": messages across a relay's groups that `#p`-tag the user. From the store plus a
 * throttled relay top-up; unread until read past in the channel (`useReadState`).
 */
export function useRelayInbox(
  relayUrl: string | undefined,
  groupIds: string[],
): RelayInbox {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const { readState } = useReadState();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const idsKey = useMemo(() => [...groupIds].sort().join(","), [groupIds]);

  const queryKey = useMemo(
    () => ["nip29", "inbox", relayUrl, idsKey, user?.pubkey] as const,
    [relayUrl, idsKey, user?.pubkey],
  );

  const { data: mentions } = useQuery<NostrRumor[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      const ids = idsKey ? idsKey.split(",") : [];
      const cached = await store.query([
        { kinds: MENTION_KINDS, "#p": [user!.pubkey], "#h": ids, limit: SCAN_LIMIT },
      ]);

      // Best-effort top-up for mentions older than the wire's live window.
      try {
        const fresh = await nostr.relay(relayUrl!).query(
          [{ kinds: MENTION_KINDS, "#p": [user!.pubkey], limit: SCAN_LIMIT }],
          { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
        );
        const byId = new Map<string, NostrRumor>();
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
      // Filtered here so the unread badge agrees with the list.
      if (mutedPubkeys.has(event.pubkey)) continue;
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
  }, [relayUrl, user, mentions, readState, groupIds, mutedPubkeys]);
}
