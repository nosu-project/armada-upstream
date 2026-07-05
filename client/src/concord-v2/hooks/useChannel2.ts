import { useNostr } from "@nostrify/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useControlFold2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useSendStatusMap, useSendStatusMapValue, type SendStatusMap } from "@/hooks/useSendStatusMap";
import { useTimelineSnapshotWriter } from "@/hooks/useTimelineSnapshot";
import { readTimelineSnapshot } from "@/lib/timelineSnapshot";
import {
  foldTimeline,
  forgetChatSkips,
  openChatBatch,
  type ChatModeration,
  type FoldedTimeline,
  type OpenedChat,
} from "@/concord-v2/lib/chat";
import { KIND_DELETE, KIND_MESSAGE, KIND_SEAL_ENCRYPTED, KIND_WRAP } from "@/concord-v2/lib/kinds";
import { canActOnMember, Permissions } from "@/concord-v2/lib/roles";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, type Rumor } from "@/concord-v2/lib/stream";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Query key for a channel's RAW opened-event set (all chat-plane kinds). */
const channelKey = (channelIdHex: string | null) => ["concord2", "channel", channelIdHex] as const;
const statusKey = (channelIdHex: string | null) => ["concord2", "msg-status", channelIdHex] as const;
const deletedKey = (channelIdHex: string | null) => ["concord2", "msg-deleted", channelIdHex] as const;

/** Snapshot scope for a V2 channel (see timelineSnapshot.ts). */
const snapshotScopeOf = (channelIdHex: string) => `concord2:${channelIdHex}`;

/**
 * Every chat-plane kind rides an identical kind-1059 wrap, so the relay can't
 * pre-filter messages from reactions — the decode window must absorb both.
 * Sized above V1's 30 accordingly; decode is memoized so re-reads are cheap.
 */
const WINDOW_SIZE = 100;
/** Relay backfill page size. */
const BACKFILL_PAGE = 50;
/** EOSE race grace once the fastest relay returns a page. */
const BACKFILL_EOSE_GRACE_MS = 500;
/** Bounded older-history pages per pass (the cursor resumes next poll). */
const BACKFILL_MAX_PAGES = 6;

function channelFilter(channel: ChannelV2, extra?: Partial<NostrFilter>): NostrFilter {
  return { kinds: [KIND_WRAP], authors: channel.streams.map((s) => s.group.pk), ...extra };
}

/** Upsert opened events into the raw set, deduped by rumor id, sorted by ms. */
function upsert(old: OpenedChat[] | undefined, incoming: OpenedChat[]): OpenedChat[] {
  const byId = new Map<string, OpenedChat>();
  for (const m of old ?? []) byId.set(m.rumorId, m);
  let changed = false;
  for (const m of incoming) {
    if (!byId.has(m.rumorId)) {
      byId.set(m.rumorId, m);
      changed = true;
    }
  }
  if (!changed && old) return old;
  return [...byId.values()].sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.rumorId < b.rumorId ? -1 : 1));
}

/**
 * Backfill the local store from the relays with `until` pagination and
 * per-relay cursors (a relay ignoring `until` is culled after one
 * non-progressing page). Returns the oldest `created_at` seen.
 */
async function backfillStore(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  channel: ChannelV2,
  signal: AbortSignal,
  until?: number,
  maxPages: number = BACKFILL_MAX_PAGES,
): Promise<number | undefined> {
  let oldest: number | undefined;
  let active = relays.map((url) => ({ url, cursor: until }));

  for (let page = 0; page < maxPages && active.length > 0; page++) {
    if (signal.aborted) break;
    const pageController = new AbortController();
    const pageSignal = AbortSignal.any([signal, pageController.signal]);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const armGrace = () => {
      graceTimer ??= setTimeout(() => pageController.abort(), BACKFILL_EOSE_GRACE_MS);
    };

    const results = await Promise.all(
      active.map(async (relay) => {
        const filter = channelFilter(channel, { limit: BACKFILL_PAGE });
        if (relay.cursor !== undefined) filter.until = relay.cursor;
        try {
          const events = await nostr
            .relay(relay.url)
            .query([filter], { signal: AbortSignal.any([pageSignal, AbortSignal.timeout(8000)]) });
          armGrace();
          return { relay, events };
        } catch {
          return { relay, events: [] as NostrEvent[] };
        }
      }),
    );
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    const next: typeof active = [];
    for (const { relay, events } of results) {
      let relayOldest = Infinity;
      let progressed = 0;
      for (const ev of events) {
        if (relay.cursor === undefined || ev.created_at < relay.cursor) {
          progressed += 1;
          if (ev.created_at < relayOldest) relayOldest = ev.created_at;
        }
      }
      if (Number.isFinite(relayOldest)) {
        if (oldest === undefined || relayOldest < oldest) oldest = relayOldest;
      }
      if (progressed > 0 && events.length >= BACKFILL_PAGE && relayOldest > 0) {
        next.push({ url: relay.url, cursor: relayOldest - 1 });
      }
    }
    active = next;
  }
  return oldest;
}

/** The moderation context resolved from the community's control fold. */
export function useChatModeration2(community: CommunityV2 | undefined): ChatModeration {
  const { data: folded } = useControlFold2(community);
  return useMemo(
    () => ({
      banned: folded?.banned ?? new Set<string>(),
      canHide: (deleter: string, author: string) =>
        Boolean(
          folded &&
            canActOnMember(folded.roster, deleter, folded.ownerHex, author, Permissions.MANAGE_MESSAGES),
        ),
    }),
    [folded],
  );
}

/**
 * One channel's timeline: the RAW opened-event set (messages, reactions,
 * edits, deletes — all sharing the wrap kind) read local-first from the
 * append-only event store, refreshed by a live subscription plus a resumable
 * relay backfill, then folded (with moderation) in memory.
 */
export function useChannelTimeline2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const moderation = useChatModeration2(community);

  const channelIdHex = channel?.idHex ?? null;
  const epochSig = channel?.streams.map((s) => s.epoch.toString()).join(",") ?? "";
  const queryKey = channelKey(channelIdHex);
  const snapshotScope = channelIdHex ? snapshotScopeOf(channelIdHex) : undefined;

  const windowLimitRef = useRef(WINDOW_SIZE);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const backfillCursor = useRef<Map<string, number | undefined>>(new Map());
  const initialLoadedRef = useRef<string | null>(null);

  useEffect(() => {
    windowLimitRef.current = WINDOW_SIZE;
    setHasMore(true);
    setIsLoadingOlder(false);
    initialLoadedRef.current = null;
  }, [channelIdHex]);

  // A caught-up rekey changes the held stream set: forget remembered decode
  // failures and re-read.
  useEffect(() => {
    if (!channelIdHex) return;
    forgetChatSkips();
    queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochSig]);

  // Live subscription: new wraps land the moment a relay forwards them.
  useEffect(() => {
    if (!community || !channel || !channelIdHex) return;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    const pending: NostrEvent[] = [];
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    const isReady = () =>
      initialLoadedRef.current === channelIdHex ||
      (queryClient.getQueryData<OpenedChat[]>(queryKey)?.length ?? 0) > 0;

    const fold = async (events: NostrEvent[]) => {
      if (events.length === 0) return;
      const opened = await openChatBatch(events, channel);
      if (opened.length === 0) return;
      queryClient.setQueryData<OpenedChat[]>(queryKey, (old) => upsert(old, opened));
      // Clear optimistic pending/failed for anything echoed back.
      queryClient.setQueryData<SendStatusMap>(statusKey(channelIdHex), (s = {}) => {
        let touched = false;
        const next = { ...s };
        for (const m of opened) {
          if (m.rumorId in next) {
            delete next[m.rumorId];
            touched = true;
          }
        }
        return touched ? next : s;
      });
    };

    const apply = async (events: NostrEvent[]) => {
      if (events.length === 0) return;
      if (!isReady()) {
        // Buffer until the initial store decode resolves, so a live message
        // can't paint a lonely single row over the loading skeleton.
        pending.push(...events);
        readyTimer ??= setInterval(() => {
          if (controller.signal.aborted) {
            clearInterval(readyTimer);
            readyTimer = undefined;
            return;
          }
          if (isReady()) {
            clearInterval(readyTimer);
            readyTimer = undefined;
            void fold(pending.splice(0, pending.length));
          }
        }, 100);
        return;
      }
      await fold(events);
    };

    for (const url of community.relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req([channelFilter(channel, { since })], {
            signal: controller.signal,
          })) {
            if (msg[0] === "EVENT") await apply([msg[2] as NostrEvent]);
          }
        } catch {
          // Subscription ended — the poll covers gaps.
        }
      })();
    }
    return () => {
      controller.abort();
      if (readyTimer !== undefined) clearInterval(readyTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community, channelIdHex, epochSig, queryClient]);

  const query = useQuery<OpenedChat[]>({
    queryKey,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    // First-frame paint from the localStorage snapshot (already-decrypted).
    initialData: () => {
      const snap = readTimelineSnapshot<OpenedChat>(snapshotScope);
      if (!snap || !channelIdHex) return undefined;
      const own = snap.filter((m) => m.channelIdHex === channelIdHex);
      return own.length > 0 ? own : undefined;
    },
    initialDataUpdatedAt: 0,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const store = await eventStore;

      const composeFromStore = async (): Promise<OpenedChat[]> => {
        const wraps = await store.query([channelFilter(channel!, { limit: windowLimitRef.current })]);
        setHasMore(wraps.length >= windowLimitRef.current);
        const opened = await openChatBatch(wraps, channel!, { signal });
        const prev = (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter(
          (m) => m.channelIdHex === channelIdHex,
        );
        return upsert(prev, opened);
      };

      const cursorKeyId = channelIdHex ?? "";
      const backfillAndRefresh = async () => {
        if (signal.aborted) return;
        // Pass 1: pull the newest page (no `until`) so live-adjacent history
        // lands first. Returns the oldest `created_at` it saw on that page.
        const newestOldest = await backfillStore(nostr, community!.relays, channel!, signal, undefined, 1);
        if (signal.aborted) return;
        // Pass 2: page OLDER history. Resume from the saved cursor if we have
        // one; otherwise (cold channel) resume from just below pass 1's newest
        // page rather than re-fetching that identical page. `resumeFrom` is only
        // undefined on the very first pass — after that the cursor drives it.
        const resumeFrom =
          backfillCursor.current.get(cursorKeyId) ??
          (newestOldest !== undefined ? newestOldest - 1 : undefined);
        const oldest = await backfillStore(nostr, community!.relays, channel!, signal, resumeFrom);
        if (oldest !== undefined && (resumeFrom === undefined || oldest < resumeFrom)) {
          backfillCursor.current.set(cursorKeyId, oldest);
        }
        if (signal.aborted) return;
        queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore());
      };

      const existing = queryClient.getQueryData<OpenedChat[]>(queryKey);
      if (existing && existing.length > 0) {
        // Warm: paint what we have; heal in the background.
        initialLoadedRef.current = channelIdHex;
        void (async () => {
          if (signal.aborted) return;
          queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore());
          await backfillAndRefresh();
        })().catch(() => undefined);
        return existing;
      }

      const local = await composeFromStore();
      initialLoadedRef.current = channelIdHex;
      void backfillAndRefresh().catch(() => undefined);
      return local;
    },
  });

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!hasMore || isLoadingOlder) return 0;
    const before = query.data?.filter((m) => m.kind === KIND_MESSAGE).length ?? 0;
    windowLimitRef.current += WINDOW_SIZE;
    setIsLoadingOlder(true);
    try {
      const result = await query.refetch();
      const after = result.data?.filter((m) => m.kind === KIND_MESSAGE).length ?? 0;
      return Math.max(0, after - before);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [hasMore, isLoadingOlder, query]);

  // Keep the cold-launch snapshot fresh (skip while showing a previous
  // channel's data through keepPreviousData).
  useTimelineSnapshotWriter(snapshotScope, query.data, !query.isPlaceholderData);

  // The folded view (moderation + edits + deletes + reaction tallies), plus
  // the optimistic-delete overlay.
  const optimisticDeleted = useQuery<string[]>({
    queryKey: deletedKey(channelIdHex),
    // This query is never fetched — the overlay is populated imperatively via
    // setQueryData in deleteMessage. The no-op queryFn only exists to satisfy
    // React Query's "no queryFn" dev warning; enabled:false keeps it from running.
    queryFn: () => [],
    enabled: false,
    initialData: [],
  }).data;

  const folded: FoldedTimeline = useMemo(() => {
    const result = foldTimeline(query.data ?? [], moderation);
    if (optimisticDeleted && optimisticDeleted.length > 0) {
      const hidden = new Set(optimisticDeleted);
      return { ...result, messages: result.messages.filter((m) => !hidden.has(m.rumorId)) };
    }
    return result;
  }, [query.data, moderation, optimisticDeleted]);

  return {
    /** The folded, moderated timeline + reaction tallies. */
    folded,
    isLoading: query.isLoading,
    loadOlder,
    hasMore,
    isLoadingOlder,
  };
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Send one chat-plane rumor: build (with the channel/epoch binding), sign the
 * seal with the user's real identity, wrap under the CURRENT epoch's stream
 * key, optimistically insert, and broadcast fire-and-forget. Only a total
 * broadcast failure marks it failed (retryable).
 */
export function useSendMessage2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel?.idHex ?? null;
  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));

  const broadcast = useCallback(
    async (wrap: NostrEvent) => {
      const results = await Promise.allSettled(
        community!.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) throw new Error("No relay accepted the message.");
    },
    [nostr, community],
  );

  return useMutation({
    mutationFn: async ({
      content,
      kind = KIND_MESSAGE,
      replyTo,
      target,
      extraTags,
    }: {
      content: string;
      /** 9 message (default), 7 reaction, 5 delete, 3302 edit. */
      kind?: number;
      /** Reply parent: `["q", id, "", author]` per NIP-C7. */
      replyTo?: { id: string; author: string };
      /** `e`-target for reactions / deletes / edits. */
      target?: string;
      /** Extra rumor tags appended verbatim (NIP-30 emoji, NIP-92 imeta, …). */
      extraTags?: string[][];
    }) => {
      if (!user) throw new Error("Sign in to send a message.");
      if (!community || !channel) throw new Error("No channel selected.");

      const ms = Date.now();
      const tags: string[][] = [...channelBindingTags(channel.idHex, channel.current.epoch)];
      if (replyTo) tags.push(["q", replyTo.id, "", replyTo.author]);
      if (target) tags.push(["e", target]);
      if (kind === KIND_DELETE && target) tags.push(["k", KIND_MESSAGE.toString()]);
      if (extraTags) tags.push(...extraTags);

      const rumor: Rumor = buildRumor({ kind, content, tags, pubkey: user.pubkey, ms });
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      const wrap = wrapSeal(seal, channel.current.group);

      // Optimistic insert (messages/edits render; reactions/deletes fold in).
      const opened: OpenedChat = {
        rumorId: rumor.id,
        author: user.pubkey,
        kind,
        content,
        tags,
        ms,
        createdAt: rumor.created_at,
        wrapId: wrap.id,
        streamPk: wrap.pubkey,
        sealKind: KIND_SEAL_ENCRYPTED,
        seal,
        channelIdHex: channel.idHex,
        epoch: channel.current.epoch,
      };
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) => upsert(old, [opened]));

      void broadcast(wrap).catch(() => {
        if (kind === KIND_MESSAGE) setStatus(rumor.id, "failed");
      });

      return { rumorId: rumor.id, wrap };
    },
  });
}

/** Retry / discard a failed optimistic message, and optimistic self-delete. */
export function useMessageActions2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel?.idHex ?? null;
  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));
  const { mutateAsync: send } = useSendMessage2(community, channel);

  const retry = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const raw = queryClient.getQueryData<OpenedChat[]>(channelKey(channelIdHex)) ?? [];
      const msg = raw.find((m) => m.rumorId === id);
      if (!msg) return;
      setStatus(id, "pending");
      // Re-send as a fresh rumor (a new id); drop the failed original.
      const replyTag = msg.tags.find((t) => t[0] === "q");
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.rumorId !== id),
      );
      setStatus(id, undefined);
      void send({
        content: msg.content,
        kind: msg.kind,
        replyTo: replyTag ? { id: replyTag[1], author: replyTag[3] ?? "" } : undefined,
      }).catch(() => undefined);
    },
    [user, community, channel, channelIdHex, queryClient, setStatus, send],
  );

  const discard = useCallback(
    (id: string) => {
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.rumorId !== id),
      );
      setStatus(id, undefined);
    },
    [queryClient, channelIdHex, setStatus],
  );

  /** Optimistic delete: hide now, publish the kind-5 in the background. */
  const deleteMessage = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
        old.includes(id) ? old : [...old, id],
      );
      void send({ content: "", kind: KIND_DELETE, target: id }).catch(() => {
        // Couldn't publish the delete — unhide so the user knows.
        queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) => old.filter((d) => d !== id));
      });
    },
    [user, community, channel, channelIdHex, queryClient, send],
  );

  return { retry, discard, deleteMessage };
}

/** The optimistic send-status map for a channel. */
export function useSendStatus2(channel: ChannelV2 | undefined): SendStatusMap {
  return useSendStatusMapValue(statusKey(channel?.idHex ?? null));
}
