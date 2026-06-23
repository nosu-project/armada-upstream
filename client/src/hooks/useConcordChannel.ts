import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { channelPseudonym } from "@/lib/concord/derive";
import {
  buildInnerEvent,
  openMessageMulti,
  sealWithSignedInner,
  type OpenedMessage,
} from "@/lib/concord/envelope";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_MESSAGE } from "@/lib/concord/kinds";
import type { Channel, Community } from "@/lib/concord/types";

import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "@nostrify/nostrify";

/** The held epoch keys for a channel: every retained epoch, newest first. */
function readEpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The set of `#z` pseudonyms to subscribe/query for a channel (one per held epoch). */
function channelPseudonyms(channel: Channel): string[] {
  return readEpochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

/**
 * Open + tally a batch of sealed outer events for a channel: decode each under
 * the held epoch keys (binding triad enforced), drop author-deleted messages,
 * and return the surviving messages sorted by time. Shared by the network query
 * and the IndexedDB cache-first seed.
 */
function openMessages(
  events: NostrEvent[],
  channelId: Uint8Array,
  epochKeys: Array<{ epoch: bigint; key: Uint8Array }>,
): OpenedMessage[] {
  const byId = new Map<string, OpenedMessage>();
  // Tombstones: target message id → set of pubkeys that authored a delete
  // for it. A delete only takes effect for the original author's own
  // message (cooperative self-delete), mirroring Vector's hide model.
  const deletes = new Map<string, Set<string>>();
  for (const ev of events) {
    try {
      const opened = openMessageMulti(ev, channelId, epochKeys);
      if (opened.kind === KIND_COMMUNITY_DELETE) {
        const target = opened.tags.find((t) => t[0] === "e")?.[1];
        if (!target) continue;
        let authors = deletes.get(target);
        if (!authors) deletes.set(target, (authors = new Set()));
        authors.add(opened.author);
        continue;
      }
      byId.set(opened.messageId, opened);
    } catch {
      // NoHeldEpoch / splice / bad-sig → not ours or invalid; skip.
    }
  }
  // Drop any message its own author deleted.
  for (const [id, msg] of byId) {
    if (deletes.get(id)?.has(msg.author)) byId.delete(id);
  }
  return [...byId.values()].sort((a, b) => a.ms - b.ms);
}

/**
 * Fetch + decrypt the messages of one Concord channel from the community's
 * relays. Queries every retained-epoch pseudonym (`#z`), opens each sealed outer
 * event under the matching epoch key (binding triad enforced), and returns the
 * verified messages sorted by time. Foreign/old-epoch blobs are silently
 * skipped (NoHeldEpoch), exactly as Vector's read path does.
 *
 * Cache-first: while the network query is in flight, the channel's sealed
 * events are read back from IndexedDB by their `#z` pseudonyms and decrypted
 * locally, so a channel we've visited renders instantly and survives a page
 * refresh (the relays only ever stored opaque blobs; decryption is local).
 */
export function useConcordChannelMessages(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  const queryKey = ["concord", "channel", channelIdHex];

  // Seed from the local store (decrypt sealed blobs by `#z`) before the network
  // resolves. Survives refresh because NostrBatcher mirrors the sealed events.
  useEffect(() => {
    if (!community || !channel) return;
    let cancelled = false;
    void (async () => {
      if ((queryClient.getQueryData<OpenedMessage[]>(queryKey) ?? []).length > 0) return;
      const store = await eventStore;
      const epochKeys = readEpochKeys(channel);
      const zs = channelPseudonyms(channel);
      const sealed = await store.query([
        { kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE], "#z": zs, limit: 500 },
      ]);
      if (cancelled || sealed.length === 0) return;
      const opened = openMessages(sealed, channel.id, epochKeys);
      if (cancelled || opened.length === 0) return;
      queryClient.setQueryData<OpenedMessage[]>(queryKey, (old) =>
        old && old.length > 0 ? old : opened,
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelIdHex, community, eventStore, queryClient]);

  return useQuery({
    queryKey,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      const epochKeys = readEpochKeys(channel!);
      const zs = channelPseudonyms(channel!);
      const relays = community!.relays;
      const results = await Promise.all(
        relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE], "#z": zs, limit: 500 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      return openMessages(results.flat(), channel!.id, epochKeys);
    },
  });
}

/** Send a sealed message into a Concord channel (signs the inner with the user's signer). */
export function useSendConcordMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      content,
      kind = KIND_COMMUNITY_MESSAGE,
      reference,
    }: {
      content: string;
      /** 3300 message (default), 3301 reaction, 3302 edit. */
      kind?: number;
      /** Target inner id for a reply/reaction/edit. */
      reference?: string;
    }) => {
      if (!user) throw new Error("Sign in to send a message.");
      if (!community || !channel) throw new Error("No channel selected.");

      // Inner authorship event signed by the user's real identity (the proof of
      // who wrote it), then sealed under the channel key with a throwaway outer key.
      const ms = Date.now();
      const innerTemplate = buildInnerEvent({
        channelId: channel.id,
        epoch: channel.epoch,
        content,
        ms,
        kind,
        reference,
      });
      const signedInner = await user.signer.signEvent(innerTemplate);
      const outer = sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);

      await Promise.all(
        community.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
      );
      return outer;
    },
    onSuccess: () => {
      if (channel) {
        queryClient.invalidateQueries({ queryKey: ["concord", "channel", bytesToHex(channel.id)] });
      }
    },
  });
}

/**
 * Fetch + decrypt reactions (kind 3301) for a channel and tally them per target
 * message. Each reaction's `content` is the emoji; its reply `e` tag names the
 * reacted-to message. Reuses the same per-epoch envelope read path.
 */
export function useConcordReactions(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ["concord", "reactions", channel ? bytesToHex(channel.id) : null],
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      const epochKeys = readEpochKeys(channel!);
      const zs = channelPseudonyms(channel!);
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [3301], "#z": zs, limit: 500 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      // target id → emoji → set of reactor pubkeys
      const tally = new Map<string, Map<string, Set<string>>>();
      for (const ev of results.flat()) {
        try {
          const opened = openMessageMulti(ev, channel!.id, epochKeys);
          const target = opened.tags.find((t) => t[0] === "e")?.[1];
          if (!target || !opened.content) continue;
          let byEmoji = tally.get(target);
          if (!byEmoji) tally.set(target, (byEmoji = new Map()));
          let reactors = byEmoji.get(opened.content);
          if (!reactors) byEmoji.set(opened.content, (reactors = new Set()));
          reactors.add(opened.author);
        } catch {
          // not ours / invalid → skip
        }
      }
      return tally;
    },
  });
}
