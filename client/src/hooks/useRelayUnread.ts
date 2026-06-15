import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { KIND_GROUP_CHAT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind — counts toward channel activity like chat does. */
const KIND_POLL = 1068;
const ACTIVITY_KINDS = [KIND_GROUP_CHAT, KIND_POLL];

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
 * Compute unread / mention state for every group on a relay, in a single REQ.
 * Compares the latest activity per group against the user's read-state. Used
 * to drive unread dots and mention badges on the channel list and server rail.
 *
 * Self-authored messages never mark a channel unread.
 */
export function useRelayUnread(
  relayUrl: string | undefined,
  groupIds: string[],
): RelayUnread {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { readState } = useReadState();

  const idsKey = useMemo(() => [...groupIds].sort().join(","), [groupIds]);

  // Latest activity per group (a small, cached snapshot), refreshed by the live
  // subscription below. We only need timestamps + mention pubkeys, not bodies.
  const { data: activity } = useQuery<NostrEvent[]>({
    queryKey: ["nip29", "unread", relayUrl, idsKey, user?.pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: ACTIVITY_KINDS, "#h": groupIds, limit: 300 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return events;
    },
    enabled: Boolean(relayUrl && groupIds.length > 0 && user),
    staleTime: 15_000,
  });

  // Live tail so badges light up without a refetch.
  const [live, setLive] = useState<NostrEvent[]>([]);
  useEffect(() => {
    setLive([]);
    if (!relayUrl || groupIds.length === 0 || !user) return;
    const controller = new AbortController();
    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: ACTIVITY_KINDS, "#h": groupIds, since: Math.floor(Date.now() / 1000) - 5 }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            setLive((prev) => (prev.some((e) => e.id === event.id) ? prev : [...prev, event]));
          }
        }
      } catch {
        // Subscription ended.
      }
    })();
    return () => controller.abort();
  }, [nostr, relayUrl, idsKey, user, groupIds]);

  return useMemo(() => {
    if (!relayUrl || !user) return EMPTY;
    const all = [...(activity ?? []), ...live];
    const byGroup: Record<string, GroupUnread> = {};

    for (const event of all) {
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

    const groups = Object.values(byGroup);
    return {
      byGroup,
      anyUnread: groups.length > 0,
      anyMention: groups.some((g) => g.mention),
    };
  }, [relayUrl, user, activity, live, readState, groupIds]);
}
