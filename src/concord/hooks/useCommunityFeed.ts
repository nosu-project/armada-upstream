import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useChatModeration } from "@/concord/hooks/useChannel";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import { foldTimeline } from "@/concord/lib/chat";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { CHAT_ROW_KINDS, queryRumorsByChannel } from "@/concord/lib/rumorStore";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";

import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import type { ChatMsg } from "@/components/chat/transport";

/** Rumors read per channel per page. Widened by `loadOlder`, never narrowed. */
const PAGE = 100;
/**
 * Ceiling on the per-channel window. A community with 40 channels at the cap
 * is a 20k-row scan; past that the reader wants the channel, or search.
 */
const MAX_WINDOW = 1000;

/** Stable empties, so a pane that has never read hands out constant identities. */
const NO_MESSAGES: ChatMsg[] = [];
const NO_ROWS: Map<string, OpenedChat[]> = new Map();

const ROW_KINDS = new Set(CHAT_ROW_KINDS);

export interface CommunityFeed {
  /** Every channel's messages in one list, NEWEST FIRST. */
  messages: ChatMsg[];
  isLoading: boolean;
  /** Whether an older page exists (see the completeness watermark below). */
  hasMore: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => void;
}

/**
 * Every message in every channel of a Concord community, merged into one
 * chronological feed — the "All messages" pane. Purely local: one transaction
 * against the decrypted rumor cache, which the wire keeps fed for every
 * channel, so this issues no relay query of its own and adds no subscription.
 *
 * `active` gates the whole thing. A community-wide N-channel scan contends
 * with the open channel's own timeline read on the single store connection
 * (the channel-switch tax `useCommunityRumors` documents), and unlike unread
 * badges this view has no consumer when it isn't on screen — so it reads only
 * while the pane is open, and stops the moment it isn't.
 *
 * ## The window is a slice, not a sample
 *
 * The read is per-channel and limit-bounded (a single multi-value `#channel`
 * filter shares one global limit, so a busy channel would starve every quiet
 * one out of the merged list entirely — see `queryRumorsByChannel`). But
 * per-channel windows merge into a RAGGED tail: with a 100-row window, a
 * channel posting 500 messages today reaches back hours while a channel
 * posting five a month reaches back a year. Rendered as one list that reads as
 * a hole — scroll past today and the next thing shown is a month-old message
 * from somewhere quiet, with everything the busy channel said in between
 * simply absent, and nothing on screen saying so.
 *
 * So the feed is cut at the newest point where it is COMPLETE: for every
 * channel whose window filled (and which therefore has more behind it), take
 * the oldest message that window reached; the latest of those timestamps is
 * the watermark, and nothing older is shown. What remains is a true slice of
 * the community — every message from every channel, in order, with nothing
 * missing — and `loadOlder` widens the window rather than paging a cursor, so
 * the watermark recedes and the slice grows. `hasMore` is exactly "a channel
 * was truncated", which is also the only condition under which anything was
 * withheld.
 *
 * ## Folding is per channel, because the heuristics are
 *
 * Each channel's rows are folded on their own (`foldTimeline`) before the
 * merge: edits, deletes and reaction tallies are per-target, but the FLOOD
 * detector judges a batch as a cohort, and a merged batch would let traffic in
 * one channel supply the "everyone arrived together" evidence about another.
 * Folding each channel's own window is the same batch shape its timeline
 * folds, so the verdicts agree with what the channel itself shows.
 *
 * Quarantined messages are then DROPPED rather than collapsed into an
 * expandable row the way a channel timeline shows them, and the durable
 * per-channel verdicts (`recallQuarantined`) are merged in on top — the same
 * choice the Mentions pane makes, and for the same reason: this is an
 * aggregate catch-up surface, and a flood is exactly what makes one useless.
 * The channel itself still shows them behind its flood row.
 */
export function useCommunityFeed(
  community: Community | undefined,
  channels: Channel[],
  active: boolean,
): CommunityFeed {
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const moderation = useChatModeration(community, active);
  const communityIdHex = community?.idHex;

  // A stable id list (recomputed only when the channel SET changes), so the
  // query key doesn't churn on every parent re-render.
  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // How deep to read per channel. In the query key, so widening refetches.
  const [windowSize, setWindow] = useState(PAGE);
  // A different community is a different feed; don't carry the depth over.
  useEffect(() => setWindow(PAGE), [communityIdHex]);

  const queryKey = useMemo(
    () => ["concord-community-feed", communityIdHex ?? null, channelSig, windowSize] as const,
    [communityIdHex, channelSig, windowSize],
  );

  const { data: byChannel = NO_ROWS, isPending, isFetching } = useQuery<Map<string, OpenedChat[]>>({
    ...STORE_READ,
    queryKey,
    queryFn: ({ signal }) =>
      queryRumorsByChannel(communityIdHex!, channelIds, { perChannel: windowSize, signal }),
    enabled: active && !!communityIdHex && channelIds.length > 0,
    // The wire bus below is the live path; this is only a backstop for an
    // ingest this tab never heard about (a write from another tab).
    refetchInterval: 60_000,
    staleTime: Infinity,
  });

  // Re-fold when the persisted quarantine warms or grows, so a flood folded in
  // a past session stops showing here the moment the memory lands.
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);

  // Everything below the store read is pure, and lives outside the query so a
  // mute, a fold or a roster change re-derives without re-scanning the store.
  const { messages, hasMore } = useMemo(() => {
    void memoryRev;
    if (byChannel.size === 0) return { messages: NO_MESSAGES, hasMore: false };

    const merged: OpenedChat[] = [];
    // The oldest point back to which EVERY channel has been read. A channel
    // whose window filled has more behind it, so the merged list is only whole
    // as far back as the latest of those channels' oldest rows.
    let completeSince = 0;

    for (const [idHex, rows] of byChannel) {
      const folded = foldTimeline(rows, moderation, {
        ...(user?.pubkey !== undefined ? { self: user.pubkey } : {}),
      });
      const dropped = new Set(folded.quarantined);
      const remembered = communityIdHex ? recallQuarantined(communityIdHex, idHex) : undefined;
      if (remembered) for (const id of remembered) dropped.add(id);
      for (const m of folded.messages) if (!dropped.has(m.rumorId)) merged.push(m);

      // Truncation is a property of the RAW read, not the fold: count the rows
      // the limit applied to (side events carry their own budget) and take the
      // oldest one this channel's window reached.
      let count = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        if (!ROW_KINDS.has(r.kind)) continue;
        count++;
        if (r.ms < oldest) oldest = r.ms;
      }
      if (count >= windowSize && oldest < Number.POSITIVE_INFINITY && oldest > completeSince) {
        completeSince = oldest;
      }
    }

    let list = completeSince > 0 ? merged.filter((m) => m.ms >= completeSince) : merged;
    if (mutedPubkeys.size > 0) list = list.filter((m) => !mutedPubkeys.has(m.author));
    // Newest first, id as the tie-break so equal timestamps hold a stable order.
    list.sort((a, b) => b.ms - a.ms || (a.rumorId < b.rumorId ? 1 : -1));

    return {
      messages: list.map(openedToChatMsg),
      hasMore: completeSince > 0 && windowSize < MAX_WINDOW,
    };
  }, [byChannel, moderation, user?.pubkey, mutedPubkeys, communityIdHex, windowSize, memoryRev]);

  // Re-read the moment the wire ingests a rumor for any channel of this
  // community. A full re-scan rather than `useCommunityRumors`' per-channel
  // delta patch: this query only runs while the pane is open, and the fold
  // needs each channel's whole window anyway.
  useWireScopes((scopes) => {
    if (!active) return;
    for (const idHex of channelIds) {
      if (scopes.has(`c2:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord-community-feed", communityIdHex ?? null] });
        return;
      }
    }
  });

  const loadOlder = useCallback(() => {
    setWindow((w) => Math.min(w + PAGE, MAX_WINDOW));
  }, []);

  return useMemo(
    () => ({
      messages,
      // Gated on being enabled, so a closed pane (or a community whose channels
      // haven't folded yet) reads as not-loading rather than loading forever —
      // `isPending` alone stays true for a disabled query.
      isLoading: active && !!communityIdHex && channelIds.length > 0 && isPending,
      hasMore,
      isLoadingOlder: isFetching && !isPending,
      loadOlder,
    }),
    [messages, active, communityIdHex, channelIds, isPending, hasMore, isFetching, loadOlder],
  );
}
