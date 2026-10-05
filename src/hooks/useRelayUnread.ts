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
 * Human-visible activity kinds: NIP-29 chat, polls, and Buzz "new content" (system/job events
 * excluded as phantom unreads). Exported so the wire's unread-dot deferral counts the same kinds.
 */
export const NIP29_ACTIVITY_KINDS = [...new Set([KIND_GROUP_CHAT, KIND_POLL, ...BUZZ_UNREAD_KINDS])];
const ACTIVITY_KINDS = NIP29_ACTIVITY_KINDS;

const SCAN_LIMIT = 300;

export interface GroupUnread {
  /** Latest non-self message timestamp. */
  latest: number;
  /** Whether any unread message mentions the user (`p` tag). */
  mention: boolean;
}

export interface RelayUnread {
  byGroup: Record<string, GroupUnread>;
  anyUnread: boolean;
  anyMention: boolean;
}

const EMPTY: RelayUnread = { byGroup: {}, anyUnread: false, anyMention: false };

/**
 * Unread/mention state per group, purely from the store (no sockets), re-derived on wire bus
 * rings. Self messages never count. Muted channels are excluded from `anyUnread` but mentions
 * still count; `byGroup` always carries full data.
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
    // No polling or focus refetch: the wire bus is the complete live path, and per-server polls
    // on the rail freeze the app on refocus (cf. useCommunityRumors).
    staleTime: Infinity,
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
