import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { KIND_DM, useDMConversations } from "@/hooks/useDirectMessages";
import { useEventStore } from "@/hooks/useEventStore";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { countUnreadDm17Messages } from "@/lib/nip17/dm17Store";
import {
  buildDmSwitcherEntries,
  type Dm17SwitcherSource,
  type LegacyDmSwitcherSource,
} from "@/lib/switcher";

/** One known DM conversation, reduced to what account-level activity UIs need. */
export interface DmActivityItem {
  /** Canonical participant-set key (a pubkey for 1:1, comma-joined for a group). */
  key: string;
  /** Everyone in the conversation except the viewer (`[self]` for Note to Self). */
  peers: string[];
  route: string;
  createdAt: number;
  eventId: string;
  author: string;
  /** Exact incoming-message count when loaded (one-message floor meanwhile). */
  unreadCount: number;
  unread: boolean;
}

export interface DmActivityLegacySource extends LegacyDmSwitcherSource {
  latest: LegacyDmSwitcherSource["latest"] & { pubkey: string };
}

export interface DmActivityNip17Source extends Dm17SwitcherSource {
  latest: Dm17SwitcherSource["latest"] & { author: string };
}

/**
 * Merge legacy and NIP-17 conversation heads into newest-first activity rows.
 *
 * Identity/order deliberately comes from `buildDmSwitcherEntries`, the same
 * reducer used by the quick switcher. This layer only attaches the winning
 * message's author and the shared per-conversation read stamp. Legacy wins an
 * exact timestamp tie, matching the DMs page and switcher.
 */
export function buildDmActivityItems(
  legacy: readonly DmActivityLegacySource[],
  nip17: readonly DmActivityNip17Source[],
  opts: {
    self: string;
    isKnown: (peer: string, mine: boolean) => boolean;
    getLastRead: (key: string) => number;
    unreadCounts?: Readonly<Record<string, number>>;
  },
): DmActivityItem[] {
  const entries = buildDmSwitcherEntries(legacy, nip17, {
    isKnown: opts.isKnown,
  });
  const legacyByKey = new Map(legacy.map((row) => [row.peer, row]));
  const nip17ByKey = new Map(nip17.map((row) => [row.key, row]));

  return entries.flatMap((entry) => {
    const old = legacyByKey.get(entry.key);
    const modern = nip17ByKey.get(entry.key);
    const modernWins = Boolean(
      modern && (!old || modern.latest.createdAt > old.latest.created_at),
    );
    const createdAt = modernWins ? modern!.latest.createdAt : old?.latest.created_at;
    const eventId = modernWins ? modern!.latest.rumorId : old?.latest.id;
    const author = modernWins ? modern!.latest.author : old?.latest.pubkey;
    if (!createdAt || !eventId || !author) return [];
    const latestUnread =
      author !== opts.self && createdAt > opts.getLastRead(dmReadKey(entry.key));
    // The latest incoming head proves at least one unread message even while
    // the indexed count is loading (or if a store count transiently fails).
    const unreadCount = latestUnread
      ? Math.max(1, opts.unreadCounts?.[entry.key] ?? 1)
      : 0;

    return [{
      key: entry.key,
      peers: entry.peers,
      route: entry.route,
      createdAt,
      eventId,
      author,
      unreadCount,
      unread: unreadCount > 0,
    }];
  });
}

/**
 * Known, real-message DM conversations for the always-mounted recent rail.
 * This never decrypts preview text or opens the NIP-17 consent flow: avatars,
 * recency and indexed unread counts need no signer interaction.
 */
export function useDmActivity(): {
  items: DmActivityItem[];
  isLoading: boolean;
} {
  const { user } = useCurrentUser();
  const { getLastRead } = useReadState();
  const eventStore = useEventStore();
  const { isKnown, isLoading: trustLoading } = useKnownDmPeers();
  const legacy = useDMConversations();
  const modern = useDm17Conversations();

  const heads = useMemo(() => {
    if (!user || trustLoading) return [];
    return buildDmActivityItems(
      legacy.conversations,
      modern.conversations,
      { self: user.pubkey, isKnown, getLastRead },
    );
  }, [
    user,
    trustLoading,
    legacy.conversations,
    modern.conversations,
    isKnown,
    getLastRead,
  ]);

  // Exact badge counts are count-only indexed reads. Key them by each unread
  // head and its current read stamp: a new message or a read immediately swaps
  // cache entries, while ordinary re-renders do no database work.
  const unreadSignature = heads
    .filter((item) => item.unread)
    .map((item) => `${item.key}:${item.eventId}:${getLastRead(dmReadKey(item.key))}`)
    .join("|");
  const counts = useQuery<Record<string, number>>({
    queryKey: ["dm", "activity-unread-counts", user?.pubkey, unreadSignature],
    enabled: Boolean(user && unreadSignature),
    staleTime: 10_000,
    queryFn: async ({ signal }) => {
      const self = user!.pubkey;
      const legacyStore = await eventStore;
      const rows = await Promise.all(heads.filter((item) => item.unread).map(async (item) => {
        const lastRead = getLastRead(dmReadKey(item.key));
        const legacyCount = item.peers.length === 1 && item.peers[0] !== self
          ? legacyStore.count([{
              kinds: [KIND_DM],
              authors: [item.peers[0]],
              "#p": [self],
              since: Math.max(0, Math.floor(lastRead) + 1),
            }], { signal }).then((result) => result.count).catch(() => 0)
          : Promise.resolve(0);
        const modernCount = countUnreadDm17Messages(
          self,
          item.peers,
          lastRead,
          { signal },
        ).catch(() => 0);
        const [oldCount, newCount] = await Promise.all([legacyCount, modernCount]);
        return [item.key, oldCount + newCount] as const;
      }));
      return Object.fromEntries(rows);
    },
  });

  const items = useMemo(() => {
    if (!counts.data) return heads;
    return heads.map((item) => {
      if (!item.unread) return item;
      const unreadCount = Math.max(1, counts.data[item.key] ?? 1);
      return { ...item, unreadCount, unread: unreadCount > 0 };
    });
  }, [heads, counts.data]);

  return {
    items,
    isLoading: legacy.isLoading || modern.isLoading || trustLoading,
  };
}
