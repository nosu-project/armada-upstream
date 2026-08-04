import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useMutes } from "@/hooks/useMutes";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { BUZZ_UNREAD_KINDS } from "@/buzz/kinds";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-88 poll kind — counts toward channel activity like chat does. */
const KIND_POLL = 1068;
/**
 * Human-visible activity kinds: NIP-29 chat + polls, plus the Buzz
 * "new content" set (stream v2, forum posts/comments — kind 9 is shared).
 * Buzz system rows / job events deliberately excluded (phantom unreads).
 * Kinds absent from a relay simply never match.
 *
 * Exported for the wire's unread-dot deferral, whose judgment of "this
 * server's rail button is already dotted" must count exactly the kinds the
 * rail counts — a kind only one side knows about is a dot the other can't
 * explain.
 */
export const NIP29_ACTIVITY_KINDS = [...new Set([KIND_GROUP_CHAT, KIND_POLL, ...BUZZ_UNREAD_KINDS])];
const ACTIVITY_KINDS = NIP29_ACTIVITY_KINDS;

/** Newest store events scanned per relay when deriving unread. */
const SCAN_LIMIT = 300;

/** Per-group unread summary. */
export interface GroupUnread {
  /** Unix timestamp of the latest non-self message seen. */
  latest: number;
  /** Whether any unread message mentions the current user (`p` tag). */
  mention: boolean;
}

export interface RelayUnread {
  /** groupId → unread summary. */
  byGroup: Record<string, GroupUnread>;
  /** Whether any group on this relay has unread activity. */
  anyUnread: boolean;
  /** Whether any group on this relay has an unread mention. */
  anyMention: boolean;
}

const EMPTY: RelayUnread = { byGroup: {}, anyUnread: false, anyMention: false };

/**
 * Compute unread / mention state for every group on a relay — purely from the
 * shared IndexedDB event store, which the wire keeps fed. No sockets, no relay
 * queries: a channel reads as unread when the store holds activity newer than
 * the user's read-state. Re-derived when the wire bus announces a change to
 * any of the watched groups (plus a light poll as a backstop). Drives the
 * unread dots and mention badges on the channel list and server rail.
 *
 * Self-authored messages never mark a channel unread.
 *
 * Muted channels (or a muted server) are excluded from the aggregate
 * `anyUnread` — but unread *mentions* still count toward `anyMention`,
 * Discord-style. `byGroup` always carries the full unread data (so
 * "mark as read" and per-row rendering keep working on muted channels).
 */
export function useRelayUnread(
  relayUrl: string | undefined,
  groupIds: string[],
): RelayUnread {
  const { user } = useCurrentUser();
  const { readState } = useReadState();
  const { isChannelMuted } = useMutes();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const idsKey = useMemo(() => [...groupIds].sort().join(","), [groupIds]);

  const queryKey = useMemo(
    () => ["nip29", "unread", relayUrl, idsKey, user?.pubkey] as const,
    [relayUrl, idsKey, user?.pubkey],
  );

  const { data: activity } = useQuery<NostrRumor[]>({
    queryKey,
    queryFn: async () => {
      const store = await eventStore;
      return store.query([{ kinds: ACTIVITY_KINDS, "#h": idsKey.split(","), limit: SCAN_LIMIT }], {
        relay: relayUrl,
      });
    },
    enabled: Boolean(relayUrl && groupIds.length > 0 && user),
    staleTime: 5_000,
    // Backstop poll (cheap local read); the bus below is the fast path.
    refetchInterval: 30_000,
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
    const byGroup: Record<string, GroupUnread> = {};

    for (const event of activity ?? []) {
      if (event.pubkey === user.pubkey) continue; // never unread from self
      const h = event.tags.find(([n]) => n === "h")?.[1];
      if (!h || !groupIds.includes(h)) continue;

      const lastRead = readState[channelReadKey(relayUrl, h)] ?? 0;
      const isUnread = event.created_at > lastRead;
      if (!isUnread) continue;

      const mentionsMe = event.tags.some(([n, v]) => n === "p" && v === user.pubkey);
      const cur = byGroup[h];
      byGroup[h] = {
        latest: Math.max(cur?.latest ?? 0, event.created_at),
        mention: (cur?.mention ?? false) || mentionsMe,
      };
    }

    const groups = Object.entries(byGroup);
    return {
      byGroup,
      anyUnread: groups.some(([id]) => !isChannelMuted(relayUrl, id)),
      anyMention: groups.some(([, g]) => g.mention),
    };
  }, [relayUrl, user, activity, readState, groupIds, isChannelMuted]);
}
