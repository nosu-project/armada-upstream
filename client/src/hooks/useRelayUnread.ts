import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { recordGroupActivity } from "@/lib/nip29Activity";
import { KIND_GROUP_CHAT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind — counts toward channel activity like chat does. */
const KIND_POLL = 1068;
const ACTIVITY_KINDS = [KIND_GROUP_CHAT, KIND_POLL];

/**
 * How far back the live tail's `since` reaches on (re)subscribe. A few seconds
 * isn't enough: any message that arrives between the snapshot query resolving
 * and the tail opening — or while a dead socket is reconnecting — would fall
 * outside a tiny window and never light a badge. The overlap with the snapshot
 * is deduped by id, so a generous window is free of double-counting. Mirrors
 * useGroupMessages' LIVE_SINCE_LOOKBACK_SECONDS.
 */
const LIVE_SINCE_LOOKBACK_SECONDS = 5 * 60;

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
 * ALL activity state lives in the query cache (`["nip29","unread",…]`), never
 * in component state:
 *
 * - the snapshot queryFn merges into whatever's already cached (append-only),
 *   so a refetch can never drop events the live tail delivered;
 * - the live tail writes into the same cache entry via
 *   {@link recordGroupActivity}, so events survive re-renders/remounts and are
 *   shared by every instance of this hook (server rail, sidebar, OS badge);
 * - the tail ALSO fans incoming messages into the matching
 *   `["nip29","messages",…]` timeline caches, so every open-ish channel on the
 *   relay stays synced as messages arrive — not just the one on screen.
 *
 * A periodic refetch + focus/reconnect refetch heal the Android half-dead
 * socket case, mirroring useGroupMessages' backstops.
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
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { readState } = useReadState();
  const { isChannelMuted } = useMutes();
  const queryClient = useQueryClient();

  const idsKey = useMemo(() => [...groupIds].sort().join(","), [groupIds]);

  const queryKey = useMemo(
    () => ["nip29", "unread", relayUrl, idsKey, user?.pubkey] as const,
    [relayUrl, idsKey, user?.pubkey],
  );

  // Latest activity per group (a small, cached snapshot), kept fresh by the
  // live subscription below plus periodic/focus refetches (dead-socket
  // healing). We only need timestamps + mention pubkeys, not bodies.
  const { data: activity } = useQuery<NostrEvent[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const ids = idsKey.split(",");
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: ACTIVITY_KINDS, "#h": ids, limit: 300 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      // Merge into the existing cache (dedupe by id) instead of overwriting:
      // a bare return would DROP any event the live tail delivered that has
      // since fallen off the relay's newest-300 page.
      const existing = queryClient.getQueryData<NostrEvent[]>(queryKey) ?? [];
      const byId = new Map<string, NostrEvent>();
      for (const e of [...existing, ...events]) byId.set(e.id, e);
      // Cap to the newest slice so a long-lived session can't grow unbounded.
      return [...byId.values()]
        .sort((a, b) => a.created_at - b.created_at)
        .slice(-600);
    },
    enabled: Boolean(relayUrl && groupIds.length > 0 && user),
    staleTime: 15_000,
    // Backstop poll + resume refetch: a half-dead socket (OS silently severed
    // it while backgrounded) leaves the live tail blocked with no error, so
    // badges quietly stop updating. Mirrors useGroupMessages' healing.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // Live tail so badges light up (and channel timelines stay synced) without
  // a refetch. Events go straight into the query cache — shared across all
  // instances of this hook and never lost to a re-render.
  useEffect(() => {
    if (!relayUrl || !idsKey || !user) return;
    const ids = idsKey.split(",");
    const controller = new AbortController();
    (async () => {
      try {
        const since = Math.floor(Date.now() / 1000) - LIVE_SINCE_LOOKBACK_SECONDS;
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: ACTIVITY_KINDS, "#h": ids, since }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            recordGroupActivity(queryClient, [msg[2] as NostrEvent]);
          }
        }
      } catch {
        // Subscription ended.
      }
    })();
    return () => controller.abort();
  }, [nostr, relayUrl, idsKey, user, queryClient]);

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
