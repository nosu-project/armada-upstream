import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { queryMentionRumors } from "@/concord/lib/rumorStore";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import type { Channel } from "@/concord/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";
import { concordMentionReadKey, useReadState } from "@/hooks/useReadState";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import {
  everyoneMentionAuthors,
  isEveryoneMention,
} from "@/concord/lib/everyoneMention";
import { emptyRoles } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

/** How many newest cached mentions to surface. */
const MENTION_LIMIT = 200;

/**
 * Stable empty result. A community with no channels disables the query (and
 * every community's is undefined until its first read lands), so a fresh `[]`
 * default here would hand a new reference to every consumer on each render —
 * which drove the Notification Center's per-community reporter into an
 * unbounded setState loop that froze the tab.
 */
const NO_MENTIONS: ChatMsg[] = [];
const NO_ROLES = emptyRoles();

/**
 * The current user's mentions across a Concord community — every cached
 * kind-9 message (and kind-1111 thread reply) that p-tags them, from ANY of
 * the community's channels, newest-first. Purely local: served from the
 * decrypted rumor cache (IndexedDB), which the wire keeps fed for every
 * channel (no relay query).
 *
 * Deliberately NOT derived from {@link useCommunityRumors} (unlike unread and
 * threads): the shared scan reads only each channel's newest window, so a
 * mention older than a busy channel's window would silently vanish from the
 * tab. Mentions instead use their own single index-backed `#p` filter
 * ({@link queryMentionRumors}) — one cheap transaction reaching the newest
 * `MENTION_LIMIT` mentions across the whole store, however deep. The scan
 * lives in the shared TanStack Query cache (keyed by pubkey + the channel
 * set) and re-runs the moment the wire bus announces a `c2:` change to any
 * watched channel, with a light poll as a backstop. Each row carries its own
 * `channel` binding, so the view can label which channel a mention came from.
 *
 * Read state is independent of channel read state (issue #53): the tab is a
 * single flat list, so it tracks ONE last-seen `created_at` per community,
 * kept in the shared read-state map at `c2m:<communityIdHex>` — the same map
 * channels and DMs use, so it syncs across devices via the encrypted NIP-78
 * settings event. `hasNew` lights the tab when the newest mention post-dates
 * that stamp; `markAllRead` advances it to the newest mention, so clearing
 * the badge no longer requires opening every mentioning channel. Reading a
 * channel that shows a mention also advances the stamp (see `markRead`).
 */
export function useConcordMentions(community: Community | undefined, channels: Channel[]): {
  mentions: ChatMsg[];
  isLoading: boolean;
  hasNew: boolean;
  markRead: (timestamp: number) => void;
  markAllRead: () => void;
} {
  const communityIdHex = community?.idHex;
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const queryClient = useQueryClient();
  const { readState, markRead: sharedMarkRead } = useReadState();
  // Passive: ambient rail and Notification Center callers must never turn this
  // local index into a per-community control-plane network sweep.
  const { data: folded } = useControlFold(community, false);

  // A stable list of channel ids (recomputed only when the set changes), so
  // the query key doesn't churn on every parent re-render.
  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const roles = folded?.roster ?? NO_ROLES;
  const ownerHex = folded?.ownerHex ?? community?.owner;
  const everyoneAuthors = useMemo(
    () => everyoneMentionAuthors(roles, ownerHex, channelIds),
    [roles, ownerHex, channelIds],
  );
  const everyoneAuthorSig = everyoneAuthors.join(",");

  const { mutedPubkeys } = useMutedPubkeys();

  const { data: allMentions = NO_MENTIONS, isLoading } = useQuery<ChatMsg[]>({
    ...STORE_READ,
    queryKey: ["concord-mentions", communityIdHex ?? null, pubkey, channelSig, everyoneAuthorSig],
    queryFn: async ({ signal }) => {
      const rumors = await queryMentionRumors(communityIdHex!, channelIds, pubkey!, {
        limit: MENTION_LIMIT,
        signal,
        everyoneAuthors,
      });
      // The indexed query returns exact direct mentions plus candidate messages
      // from authorized role holders. Re-check both the literal and the exact
      // channel scope here; the candidate author union can span channels.
      return rumors
        .filter((r) => {
          if (r.author === pubkey) return false;
          if (r.tags.some(([name, value]) => name === "p" && value === pubkey)) return true;
          return isEveryoneMention(r.content, roles, ownerHex, r.author, r.channelIdHex);
        })
        .sort((a, b) => b.ms - a.ms)
        .slice(0, MENTION_LIMIT)
        .map(openedToChatMsg);
    },
    enabled: !!communityIdHex && !!pubkey && channelIds.length > 0,
    // NO refetch interval: the `c2:` bus ring below invalidates this the moment
    // the wire ingests a message for a watched channel, which is the only way a
    // new mention arrives in-process. The rail mounts one of these per joined
    // community, so the old 30s poll was N independent index scans on unaligned
    // clocks whatever screen was open — the highest-frequency slice of the
    // recurring O(N) foreground load behind the power-user hitches. `staleTime:
    // 0` keeps a remount catch-up; the live path is the bus.
    staleTime: 0,
  });

  // Re-derive when the persisted quarantine warms or grows, so a mention the
  // flood fold folded stops counting the moment the memory lands.
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);

  // Outside the query so a mute (or a fold) takes effect without a re-scan of
  // the store, and so `hasNew` below is derived from the same list the tab
  // renders — a filtered mention that still lit the badge would leave a dot the
  // Mentions tab has nothing in it to clear.
  const mentions = useMemo(() => {
    void memoryRev;
    let list = mutedPubkeys.size === 0 ? allMentions : allMentions.filter((m) => !mutedPubkeys.has(m.pubkey));
    // Drop mentions the flood fold quarantined in their channel: a folded flood
    // that `p`-tags you must no more light the Mentions tab than it lights the
    // channel badge (useConcordUnread). Live re-folding is impossible here — a
    // `#p` scan across channels is not a channel batch the heuristic can judge —
    // so this reads the DURABLE per-channel verdict the unread/timeline folds
    // remember (quarantineMemory), which is the cross-session source of record.
    // Each mention's `id` is its rumorId, unique across channels, so the union
    // of every watched channel's remembered set is a sound membership test.
    if (communityIdHex && channelIds.length > 0) {
      let quarantined: Set<string> | undefined;
      for (const idHex of channelIds) {
        const remembered = recallQuarantined(communityIdHex, idHex);
        if (!remembered) continue;
        quarantined ??= new Set();
        for (const id of remembered) quarantined.add(id);
      }
      if (quarantined && quarantined.size > 0) list = list.filter((m) => !quarantined.has(m.id));
    }
    return list;
  }, [allMentions, mutedPubkeys, communityIdHex, channelIds, memoryRev]);

  // Re-scan the moment the wire ingests a rumor for any watched channel.
  useWireScopes((scopes) => {
    for (const idHex of channelIds) {
      if (scopes.has(`c2:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord-mentions", communityIdHex ?? null, pubkey] });
        return;
      }
    }
  });

  // The mentions last-seen stamp from the shared read-state map (reactive, so
  // the rail badge and the open page re-derive together on any advance).
  const readKey = communityIdHex ? concordMentionReadKey(communityIdHex) : undefined;
  const readAt = readKey ? (readState[readKey] ?? 0) : 0;

  // `created_at` is unix SECONDS on the ChatMsg; the newest mention is first.
  const newestMentionAt = mentions[0]?.created_at ?? 0;
  const hasNew = newestMentionAt > readAt;

  // Advance the stamp to an arbitrary timestamp (monotonic — the shared map
  // no-ops on older stamps). Used when a mention is seen outside the tab,
  // e.g. read naturally in its channel.
  const markRead = useCallback(
    (timestamp: number) => {
      if (!readKey || timestamp <= 0) return;
      sharedMarkRead(readKey, timestamp);
    },
    [readKey, sharedMarkRead],
  );

  const markAllRead = useCallback(() => {
    if (newestMentionAt <= 0) return;
    markRead(newestMentionAt);
  }, [markRead, newestMentionAt]);

  return useMemo(
    () => ({ mentions, isLoading, hasNew, markRead, markAllRead }),
    [mentions, isLoading, hasNew, markRead, markAllRead],
  );
}
