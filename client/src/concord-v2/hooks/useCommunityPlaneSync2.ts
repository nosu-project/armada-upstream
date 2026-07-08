import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { channelKey, upsertOpenedChat } from "@/concord-v2/hooks/useChannel2";
import { openChatBatch, type OpenedChat } from "@/concord-v2/lib/chat";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { writeRumors } from "@/concord-v2/lib/rumorStore";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * How far back the plane sub's `since` reaches on (re)subscribe, so a message
 * that arrived while the subscription was down (community switch, reconnect)
 * is replayed. Decode memoization + dedupe-by-rumor-id make the overlap free.
 */
const LIVE_SINCE_LOOKBACK_SECONDS = 5 * 60;

/**
 * Live-sync the FULL chat plane of an open Concord V2 community — every
 * channel, not just the one on screen.
 *
 * `useChannelTimeline2` only subscribes to the active channel's stream
 * addresses, so historically a message to any other channel of the community
 * was never received on web: it wasn't decrypted, never entered the rumor
 * store, never lit an unread badge, and only surfaced after a relay backfill
 * when the channel was eventually opened (at which point it was immediately
 * stamped read — so the badge never lit at all).
 *
 * This hook opens ONE subscription per community relay covering the kind-1059
 * stream addresses of ALL the community's channels. Each arriving wrap is
 * decrypted with the owning channel's stream keys and:
 *
 *  - written to the rumor store (the durable layer `useConcord2Unread`'s 5s
 *    scan and every channel's cold read compose from);
 *  - upserted into the channel's `["concord2","channel",…]` timeline cache
 *    when one is already populated (instant paint on channel switch; a cache
 *    that hasn't finished its initial load is left alone so a lone live row
 *    can never paint over the loading skeleton);
 *  - used to invalidate the unread scan, so badges light immediately instead
 *    of on the next 5s tick.
 *
 * Cursors are deliberately NOT advanced (mirrors the channel live sub: only a
 * completed backfill bridge may advance `newest`, so offline gaps can't be
 * sealed over). Decodes are memoized per wrap, so the overlap with the active
 * channel's own subscription costs nothing.
 */
export function useCommunityPlaneSync2(
  community: CommunityV2 | undefined,
  channels: ChannelV2[],
): void {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  // Resubscribe only when the actual stream-address set changes (a channel is
  // added/removed or rekeyed), not on parent re-renders.
  const streamSig = useMemo(
    () =>
      channels
        .map((c) => c.streams.map((s) => s.group.pk).join("+"))
        .sort()
        .join(","),
    [channels],
  );
  const relaysSig = community?.relays.join(",") ?? "";

  useEffect(() => {
    if (!community || channels.length === 0) return;

    // wrap author (stream address) → owning channel.
    const byPk = new Map<string, ChannelV2>();
    for (const c of channels) for (const s of c.streams) byPk.set(s.group.pk, c);
    const authors = [...byPk.keys()];
    if (authors.length === 0) return;

    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - LIVE_SINCE_LOOKBACK_SECONDS;

    const ingest = async (wrap: NostrEvent) => {
      const channel = byPk.get(wrap.pubkey);
      if (!channel) return;
      const opened = await openChatBatch([wrap], channel);
      if (opened.length === 0) return;
      writeRumors(opened);

      // Paint into an already-loaded timeline cache (dedupe by rumor id). A
      // missing/empty entry means the channel hasn't completed its initial
      // load — leave it to the channel's own queryFn, which reads the store.
      const key = channelKey(channel.idHex);
      const existing = queryClient.getQueryData<OpenedChat[]>(key);
      if (existing && existing.length > 0) {
        queryClient.setQueryData<OpenedChat[]>(key, (old) => upsertOpenedChat(old, opened));
      }

      // Nudge the badge scan now rather than on its next 5s tick. The scan
      // also folds the rumor store, so even if this refetch races the
      // fire-and-forget store write, the next tick reconciles.
      void queryClient.invalidateQueries({ queryKey: ["concord2-unread"] });
    };

    for (const url of community.relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [{ kinds: [KIND_WRAP], authors, since }],
            { signal: controller.signal },
          )) {
            if (msg[0] === "EVENT") await ingest(msg[2] as NostrEvent);
          }
        } catch {
          // Subscription ended — the unread scan's store reads still cover
          // anything other transports (native service) deliver.
        }
      })();
    }

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, queryClient, community?.idHex, relaysSig, streamSig]);
}
