import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { channelPseudonym } from "@/lib/concord/derive";
import {
  buildInnerEvent,
  openedFromSealed,
  openMessageMulti,
  sealWithSignedInner,
  type OpenedMessage,
} from "@/lib/concord/envelope";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_MESSAGE } from "@/lib/concord/kinds";
import { runExclusive } from "@/lib/signerQueue";
import type { Channel, Community } from "@/lib/concord/types";

import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "@nostrify/nostrify";

/** Optimistic delivery status for a Concord message we sent, keyed by message id. */
export type ConcordSendStatus = "pending" | "failed";
export type ConcordSendStatusMap = Record<string, ConcordSendStatus>;

/** Query key for a channel's decoded message list. */
function channelKey(channelIdHex: string | null) {
  return ["concord", "channel", channelIdHex] as const;
}

/** Query key for a channel's optimistic send-status map. */
function statusKey(channelIdHex: string | null) {
  return ["concord", "msg-status", channelIdHex] as const;
}

/**
 * Query key for a channel's optimistic-delete set: message ids the current user
 * has self-deleted locally, kept hidden until the relay echoes the delete back.
 */
function deletedKey(channelIdHex: string | null) {
  return ["concord", "msg-deleted", channelIdHex] as const;
}

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
): { messages: OpenedMessage[]; deletes: Map<string, Set<string>> } {
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
  // Drop any message its own author deleted (within this batch).
  for (const [id, msg] of byId) {
    if (deletes.get(id)?.has(msg.author)) byId.delete(id);
  }
  // Return the tombstone map too, so a merge across fetches can prune an
  // already-known message whose author published a delete in THIS batch.
  return { messages: [...byId.values()].sort((a, b) => a.ms - b.ms), deletes };
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
      const { messages: opened } = openMessages(sealed, channel.id, epochKeys);
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
      const { messages: opened, deletes } = openMessages(results.flat(), channel!.id, epochKeys);

      // Merge with what's already shown rather than replacing it. The network
      // query can transiently return fewer messages than we already have —
      // relays time out, return partial pages, or one trips empty
      // (`.catch(() => [])`) — and replacing the cache wholesale makes the whole
      // chat blink out. Union by message id: keep every message we (or the
      // seed) already know, fold in the freshly decoded ones (network wins on
      // conflict), then honor any self-delete from this batch against the
      // already-known copies too.
      const prev = queryClient.getQueryData<OpenedMessage[]>(queryKey) ?? [];
      const byId = new Map<string, OpenedMessage>();
      for (const m of prev) byId.set(m.messageId, m);
      for (const m of opened) byId.set(m.messageId, m);
      for (const [id, msg] of byId) {
        if (deletes.get(id)?.has(msg.author)) byId.delete(id);
      }

      // Honor optimistic self-deletes: hide ids the user just deleted locally
      // until the relay's own delete event lands (at which point `openMessages`
      // already drops the message and we can forget the optimistic hint).
      const optimisticDeleted =
        queryClient.getQueryData<string[]>(deletedKey(channelIdHex)) ?? [];
      if (optimisticDeleted.length > 0) {
        const stillHidden: string[] = [];
        for (const id of optimisticDeleted) {
          if (byId.has(id)) {
            // Relay hasn't confirmed the delete yet — keep it hidden.
            byId.delete(id);
            stillHidden.push(id);
          }
          // else: the relay already dropped it; clear the optimistic hint.
        }
        if (stillHidden.length !== optimisticDeleted.length) {
          queryClient.setQueryData<string[]>(deletedKey(channelIdHex), stillHidden);
        }
      }

      // Reconcile optimistic send-status: clear "pending"/"failed" for any
      // message the relays have now echoed back (present in this round's
      // freshly-decoded `opened`).
      const status = queryClient.getQueryData<ConcordSendStatusMap>(statusKey(channelIdHex)) ?? {};
      const confirmed = opened.filter((m) => status[m.messageId]).map((m) => m.messageId);
      if (confirmed.length > 0) {
        queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (old = {}) => {
          const next = { ...old };
          for (const id of confirmed) delete next[id];
          return next;
        });
      }

      return [...byId.values()].sort((a, b) => a.ms - b.ms);
    },
  });
}

/**
 * Send a sealed message into a Concord channel, optimistically and queueably.
 *
 * Mirrors the DM/NIP-29 behavior: a real message (kind 3300/3302) is rendered
 * immediately with `pending` status the moment its inner authorship event is
 * signed, the relay broadcast happens in the background, and the message is
 * reconciled (status cleared) when the relays echo it back on the next refetch.
 * A failed broadcast marks the message `failed` (retryable). Signing is
 * serialized through the per-identity signer queue so a burst of sends never
 * races on a NIP-07 extension.
 *
 * Non-message sends (reactions 3301, deletes 3305) don't render as chat rows,
 * so they skip the optimistic insert but still serialize their signing.
 */
export function useSendConcordMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const channelIdHex = channel ? bytesToHex(channel.id) : null;

  const setStatus = useCallback(
    (id: string, status: ConcordSendStatus | undefined) => {
      queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (old = {}) => {
        if (status === undefined) {
          if (!(id in old)) return old;
          const next = { ...old };
          delete next[id];
          return next;
        }
        return { ...old, [id]: status };
      });
    },
    [queryClient, channelIdHex],
  );

  /** Broadcast a sealed outer to the community's relays. Throws if none accept. */
  const broadcast = useCallback(
    async (outer: NostrEvent) => {
      const results = await Promise.allSettled(
        community!.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
        ),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the message.");
      }
    },
    [nostr, community],
  );

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

      const self = user.pubkey;
      const signer = user.signer;
      const isChatMessage = kind === KIND_COMMUNITY_MESSAGE || kind === 3302;

      // Inner authorship event signed by the user's real identity (the proof of
      // who wrote it), then sealed under the channel key with a throwaway outer
      // key. Signing is serialized per-identity (extension-safe).
      const ms = Date.now();
      const innerTemplate = buildInnerEvent({
        channelId: channel.id,
        epoch: channel.epoch,
        content,
        ms,
        kind,
        reference,
      });

      // Sign + seal serialized per-identity (extension-safe). If this throws
      // (signer rejected / sealing failed) it propagates to the caller before
      // anything is rendered; the composer shows a toast and keeps the draft.
      const signed = await runExclusive(self, async () => {
        const signedInner = await signer.signEvent(innerTemplate);
        const sealed = sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);
        return { signedInner, sealed };
      });
      const outer = signed.sealed;
      const innerId = signed.signedInner.id;

      // Optimistically render real messages immediately as "pending".
      if (isChatMessage) {
        const optimistic = openedFromSealed(signed.signedInner, signed.sealed, channel.id, channel.epoch);
        queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
          old.some((m) => m.messageId === optimistic.messageId)
            ? old
            : [...old, optimistic].sort((a, b) => a.ms - b.ms),
        );
        setStatus(innerId, "pending");
      }

      // Broadcast in the background so the composer never blocks on the relay.
      // Real messages reconcile their status via the message-list refetch (the
      // relay echo clears "pending"); mark "failed" if no relay accepts.
      void broadcast(outer)
        .then(() => {
          if (channel) {
            queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
          }
        })
        .catch(() => {
          if (isChatMessage) setStatus(innerId, "failed");
        });

      return { outer, messageId: innerId, isChatMessage };
    },
  });
}

/**
 * Re-broadcast a Concord message that previously failed to send. The sealed
 * outer is reconstructed from the still-rendered optimistic message (we hold
 * the verified inner content + tags), re-signed through the signer queue, and
 * re-broadcast. The message id is preserved so it reconciles on refetch.
 */
export function useRetryConcordMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel ? bytesToHex(channel.id) : null;

  const setStatus = useCallback(
    (id: string, status: ConcordSendStatus | undefined) => {
      queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (old = {}) => {
        if (status === undefined) {
          const next = { ...old };
          delete next[id];
          return next;
        }
        return { ...old, [id]: status };
      });
    },
    [queryClient, channelIdHex],
  );

  const retry = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const messages = queryClient.getQueryData<OpenedMessage[]>(channelKey(channelIdHex)) ?? [];
      const msg = messages.find((m) => m.messageId === id);
      if (!msg) return;
      const self = user.pubkey;
      const signer = user.signer;
      setStatus(id, "pending");

      void (async () => {
        try {
          const outer = await runExclusive(self, async () => {
            // Rebuild the inner from the original content/tags. `buildInnerEvent`
            // re-derives the binding tags; the reply reference (if any) is in the
            // original inner's `e` tag.
            const reference = msg.tags.find((t) => t[0] === "e")?.[1];
            const innerTemplate = buildInnerEvent({
              channelId: channel.id,
              epoch: channel.epoch,
              content: msg.content,
              ms: msg.ms,
              kind: msg.kind,
              reference,
            });
            const signedInner = await signer.signEvent(innerTemplate);
            return sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);
          });
          const results = await Promise.allSettled(
            community.relays.map((url) =>
              nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
            ),
          );
          if (!results.some((r) => r.status === "fulfilled")) {
            throw new Error("No relay accepted the message.");
          }
          queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
        } catch {
          setStatus(id, "failed");
        }
      })();
    },
    [user, community, channel, channelIdHex, queryClient, nostr, setStatus],
  );

  /** Drop a failed optimistic message from the channel view. */
  const discard = useCallback(
    (id: string) => {
      queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.messageId !== id),
      );
      setStatus(id, undefined);
    },
    [queryClient, channelIdHex, setStatus],
  );

  /**
   * Optimistically self-delete a message: hide it immediately, then publish the
   * sealed 3305 in the background. On failure, restore the message (and clear
   * the optimistic-delete hint) so it doesn't silently vanish. The hide is
   * recorded in the optimistic-delete set so a background refetch (which may
   * still see the message before the relay echoes the delete) keeps it hidden.
   */
  const deleteMessage = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const self = user.pubkey;
      const signer = user.signer;

      const messages = queryClient.getQueryData<OpenedMessage[]>(channelKey(channelIdHex)) ?? [];
      const target = messages.find((m) => m.messageId === id);

      // Hide immediately: remove from the rendered list and remember the id so
      // a refetch before the relay confirms doesn't un-hide it.
      queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.messageId !== id),
      );
      queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
        old.includes(id) ? old : [...old, id],
      );

      const restore = () => {
        if (target) {
          queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
            old.some((m) => m.messageId === id)
              ? old
              : [...old, target].sort((a, b) => a.ms - b.ms),
          );
        }
        queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
          old.filter((d) => d !== id),
        );
      };

      void (async () => {
        try {
          const outer = await runExclusive(self, async () => {
            const innerTemplate = buildInnerEvent({
              channelId: channel.id,
              epoch: channel.epoch,
              content: "",
              ms: Date.now(),
              kind: KIND_COMMUNITY_DELETE,
              reference: id,
            });
            const signedInner = await signer.signEvent(innerTemplate);
            return sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);
          });
          const results = await Promise.allSettled(
            community.relays.map((url) =>
              nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
            ),
          );
          if (!results.some((r) => r.status === "fulfilled")) {
            throw new Error("No relay accepted the delete.");
          }
          queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
        } catch {
          // Couldn't publish the delete — bring the message back so the user
          // knows it wasn't removed.
          restore();
        }
      })();
    },
    [user, community, channel, channelIdHex, queryClient, nostr],
  );

  return { retry, discard, deleteMessage };
}

/** Read a channel's optimistic send-status map (pending/failed by message id). */
export function useConcordSendStatus(channel: Channel | undefined): ConcordSendStatusMap {
  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  const { data } = useQuery<ConcordSendStatusMap>({
    queryKey: statusKey(channelIdHex),
    queryFn: () => ({}),
    enabled: Boolean(channelIdHex),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? {};
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
