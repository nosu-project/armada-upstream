import { useNostr } from "@nostrify/react";
import { hashKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { citationFor, dissolvedAt, useControlFold2, useDissolved2 } from "@/concord-v2/hooks/useControlPlane2";
import { persistTimelineSnapshot, prewarmTimelineSnapshot } from "@/concord-v2/hooks/timelineSnapshot";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSendStatusMap, useSendStatusMapValue, type SendStatusMap } from "@/hooks/useSendStatusMap";
import {
  buildV2CommentTags,
  foldTimeline,
  forgetChatSkips,
  openChatBatch,
  type ChatModeration,
  type FoldedTimeline,
  type OpenedChat,
} from "@/concord-v2/lib/chat";
import { KIND_COMMENT, KIND_DELETE, KIND_MESSAGE, KIND_POLL, KIND_REACTION, KIND_SEAL_ENCRYPTED, KIND_WRAP } from "@/concord-v2/lib/kinds";
import { whenAuthSettled } from "@/concord-v2/lib/planeSync";
import {
  clearChannelExhausted,
  queryChannelRumors,
  readChannelCursor,
  updateChannelCursor,
  writeRumors,
  peekPendingWraps,
  ackPendingWraps,
} from "@/concord-v2/lib/rumorStore";
import { citationToTag, type AuthorityCitation } from "@/concord-v2/lib/edition";
import { citationSatisfied } from "@/concord-v2/lib/control";
import { canActOnMember, Permissions } from "@/concord-v2/lib/roles";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord-v2/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { beginSyncTask, type SyncTaskHandle } from "@/lib/syncActivity";
import { logSync, sinceMs } from "@/lib/syncLog";
import { STORE_READ } from "@/lib/storeQuery";
import { markOwnWebPushEvent } from "@/lib/webPushState";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Query key for a channel's RAW opened-event set (all chat-plane kinds). */
export const channelKey = (channelIdHex: string | null) => ["concord2", "channel", channelIdHex] as const;
const statusKey = (channelIdHex: string | null) => ["concord2", "msg-status", channelIdHex] as const;
const deletedKey = (channelIdHex: string | null) => ["concord2", "msg-deleted", channelIdHex] as const;

/**
 * Every chat-plane kind rides an identical kind-1059 wrap, so the relay can't
 * pre-filter messages from reactions — the decode window must absorb both.
 * Sized above V1's 30 accordingly; the rumor cache serves re-reads with no decrypt.
 */
const WINDOW_SIZE = 100;
/** Relay backfill page size. */
const BACKFILL_PAGE = 50;
/** EOSE race grace once the fastest relay returns a page. */
const BACKFILL_EOSE_GRACE_MS = 500;
/**
 * Older-history pages walked back-to-back on a cold load. The passes chain
 * without waiting for the 60s poll, so deep history fills promptly rather than
 * one ~300-event chunk per minute. Bounded so a huge channel can't page relays
 * forever in one go — the saved cursor resumes any remainder on later polls or
 * on an explicit `loadOlder`.
 */
const BACKFILL_MAX_PAGES = 20;
/** Pages per `loadOlder` scroll-up when the local store is exhausted. */
const LOAD_OLDER_MAX_PAGES = 6;

/**
 * Minimum interval between relay backfill rounds for one channel. The wire
 * delivers live wraps to the rumor store; the backfill exists for history the
 * wire never covered (cold opens, offline gaps) and must not re-run on every
 * bus-invalidated re-read.
 */
const BACKFILL_MIN_INTERVAL_MS = 30_000;

function channelFilter(channel: ChannelV2, extra?: Partial<NostrFilter>): NostrFilter {
  return { kinds: [KIND_WRAP], authors: channel.streams.map((s) => s.group.pk), ...extra };
}

/** Upsert opened events into the raw set, deduped by rumor id, sorted by ms. */
export function upsertOpenedChat(old: OpenedChat[] | undefined, incoming: OpenedChat[]): OpenedChat[] {
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

/** Local shorthand. */
const upsert = upsertOpenedChat;

/**
 * Backfill wraps from the relays with `until` pagination and per-relay cursors
 * (a relay ignoring `until` is culled after one non-progressing page). Returns
 * the oldest and newest `created_at` seen, every raw wrap collected across the
 * passes (so the caller can decrypt them into the rumor cache directly),
 * whether history is exhausted (no relay had a full page left to page past),
 * and whether any relay FAILED (error/abort) — a failed relay's events may be
 * missing, so failure must never be recorded as exhaustion and must block
 * cursor advancement past the failed region.
 *
 * `since` bounds a pass from below (the bridge pass uses it to fetch exactly
 * the region between the saved cursor and the newest page).
 *
 * The kind-1059 wraps these reads return are NEVER mirrored into the shared
 * `armada-events` store — `NostrBatcher.cacheEvents` drops all gift-wrap kinds
 * unconditionally. Only the decrypted rumors are persisted (see rumorStore.ts).
 */
async function backfillStore(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  channel: ChannelV2,
  signal: AbortSignal,
  opts: { until?: number; since?: number; maxPages?: number; beforeRelay?: (url: string) => Promise<void> } = {},
): Promise<{ oldest?: number; newest?: number; events: NostrEvent[]; exhausted: boolean; failed: boolean }> {
  const maxPages = opts.maxPages ?? BACKFILL_MAX_PAGES;
  let oldest: number | undefined;
  let newest: number | undefined;
  let active = relays.map((url) => ({ url, cursor: opts.until }));
  const collected: NostrEvent[] = [];
  let failed = false;

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
        if (opts.since !== undefined) filter.since = opts.since;
        try {
          // Per-relay auth gate (see backfillAndRefresh): each relay's page
          // waits only for ITS OWN stream AUTHs to settle, never for the
          // slowest relay's cap.
          await opts.beforeRelay?.(relay.url);
          if (pageSignal.aborted) return { relay, events: [] as NostrEvent[], ok: false };
          const events = await nostr
            .relay(relay.url)
            .query([filter], {
              signal: AbortSignal.any([pageSignal, AbortSignal.timeout(8000)]),
            });
          // Only a relay that actually HAS events may start the race clock. An
          // instant empty EOSE (e.g. a relay that stores no wraps) must never
          // abort relays still mid-answer — cold NIP-42 AUTH costs extra
          // round-trips, and losing that race silently drops their messages
          // (issue #19: the platform relay answered empty in ~0ms and starved
          // the real community relays on every cold open).
          if (events.length > 0) armGrace();
          return { relay, events, ok: true };
        } catch {
          return { relay, events: [] as NostrEvent[], ok: false };
        }
      }),
    );
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    const next: typeof active = [];
    for (const { relay, events, ok } of results) {
      if (!ok) {
        // Error or aborted — this relay's region was NOT read. Track the
        // failure (blocks exhaustion/cursor advancement) and drop it for this
        // run; a later poll retries it.
        failed = true;
        continue;
      }
      collected.push(...events);
      let relayOldest = Infinity;
      let progressed = 0;
      for (const ev of events) {
        if (newest === undefined || ev.created_at > newest) newest = ev.created_at;
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
  // `exhausted` means we verifiably reached the bottom: every relay ran to a
  // short/empty page AFTER we'd seen history. An all-empty run (no events
  // collected at all) is INCONCLUSIVE — a relay answering empty before NIP-42
  // AUTH completes, or a stale `until` cursor past the relay's data — and must
  // NOT seal the channel as exhausted, or a notification-only room (1 message,
  // no history yet) gets permanently stuck with just that message. Treat an
  // all-empty run like a failure so a later poll retries it.
  const reachedBottom = active.length === 0 && !failed;
  const exhausted = reachedBottom && collected.length > 0;
  return { oldest, newest, events: collected, exhausted, failed: failed || (reachedBottom && collected.length === 0) };
}

/** The moderation context resolved from the community's control fold. */
export function useChatModeration2(community: CommunityV2 | undefined): ChatModeration {
  const { data: folded } = useControlFold2(community);
  const { data: dissolvedAtMs } = useDissolved2(community);
  return useMemo(
    () => ({
      banned: folded?.banned ?? new Set<string>(),
      canDelete: (deleter: string, author: string, action?: { citation?: AuthorityCitation; ms: number }) => {
        if (!folded || !community) return false;
        // Death wins every race (CORD-02 §9), but it is an ORDERING rule, not a
        // switch: the fold replays history, so a global "is dissolved" test
        // would retroactively un-hide every moderation delete this community
        // ever honored, including ones published years before the tombstone.
        // Only actions published AFTER the tombstone are refused. The seal
        // leaves SELF-deletes open regardless; they short-circuit in the fold
        // before reaching here.
        if (dissolvedAtMs !== null && dissolvedAtMs !== undefined && action && action.ms > dissolvedAtMs) {
          return false;
        }
        // Authorization, resolved against the CURRENT roster. The citation is a
        // completeness floor and never a grant of rank, so a since-demoted actor
        // is refused here no matter what they cited (CORD-04 §5).
        if (!canActOnMember(folded.roster, deleter, folded.ownerHex, author, Permissions.MANAGE_MESSAGES)) {
          return false;
        }
        // …then the sync floor: have we read enough of their Grant to trust the
        // verdict above? Uncited means we have not, so the delete parks.
        return citationSatisfied(folded, community.id, deleter, action?.citation);
      },
    }),
    [folded, community, dissolvedAtMs],
  );
}

/**
 * One channel's timeline: the RAW opened-event set (messages, reactions,
 * edits, deletes — all sharing the wrap kind) read local-first from the
 * decrypted rumor cache, refreshed by a live subscription plus a resumable
 * relay backfill, then folded (with moderation) in memory.
 *
 * Wraps are never persisted: incoming kind-1059 wraps are decrypted once and
 * the recovered rumors are written to the rumor store, which the timeline reads
 * back with an ordinary `{ kinds, "#channel" }` query and no decrypt. A
 * per-channel sync cursor (persisted in the folded cache) lets a cold launch
 * resume where it left off instead of re-paging the newest window.
 *
 * LOCAL-FIRST IS THE LOADING CONTRACT. The queryFn resolves on the store read
 * and returns; the park drain and every relay pass run behind that return and
 * repaint through `setQueryData` as they land. So `isLoading` — the caller's
 * skeleton — covers the ArmadaDB read alone, and network catch-up is reported
 * on the sync-activity signal instead. Holding the skeleton until a relay
 * round settled meant a conversation whose entire history was already on disk
 * still opened on a placeholder for as long as the relays took.
 */
export function useChannelTimeline2(
  community: CommunityV2 | undefined,
  channel: ChannelV2 | undefined,
  /**
   * The channel id the CALLER already knows (the URL names it on the first
   * render), so the persisted last-painted window can seed the cache before
   * the key-derivation chain produces a {@link ChannelV2}. Only ever used for
   * the cache key and the snapshot; the query stays disabled until `channel`.
   */
  routeChannelIdHex?: string | null,
) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const moderation = useChatModeration2(community);

  const channelIdHex = channel?.idHex ?? routeChannelIdHex ?? null;
  const epochSig = channel?.streams.map((s) => s.epoch.toString()).join(",") ?? "";
  const queryKey = channelKey(channelIdHex);

  // Seed the cache from the persisted last-painted window the moment the
  // channel id is known — before the fold chain resolves a ChannelV2 — so a
  // warm reload paints messages instead of a skeleton. Stale-seeded, so the
  // real store read still runs and replaces it (see timelineSnapshot).
  useEffect(() => {
    if (channelIdHex) void prewarmTimelineSnapshot(queryClient, channelIdHex, channelKey(channelIdHex));
  }, [channelIdHex, queryClient]);

  const windowLimitRef = useRef(WINDOW_SIZE);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // In-memory mirror of the persisted per-channel cursor (created_at bounds +
  // exhausted flag), loaded on channel change and written through on progress.
  // `newest` is the top of CONTIGUOUSLY-synced history: it only advances when
  // a backfill's bridge pass has verifiably fetched everything between the old
  // `newest` and the newest page (see backfillAndRefresh), so a hole can never
  // be sealed over.
  const cursor = useRef<Map<string, { newest?: number; oldest?: number; exhausted: boolean }>>(new Map());
  const initialLoadedRef = useRef<string | null>(null);
  const lastBackfillRef = useRef(0);

  useEffect(() => {
    windowLimitRef.current = WINDOW_SIZE;
    setHasMore(true);
    setIsLoadingOlder(false);
    initialLoadedRef.current = null;
    lastBackfillRef.current = 0;
    // Hydrate the in-memory cursor from the persisted one for this channel.
    if (channelIdHex) {
      void readChannelCursor(channelIdHex).then((c) => {
        if (!c) return;
        // Heal a POISONED cursor: `exhausted` with `oldest === 0` means it was
        // sealed without ever paging down (an all-empty backfill run — e.g. a
        // relay that answered empty before NIP-42 AUTH). Clearing `exhausted`
        // lets the backfill retry so a notification-only room finally pulls its
        // history instead of showing just the one delivered message.
        const poisoned = c.exhausted && !c.oldest;
        cursor.current.set(channelIdHex, {
          newest: c.newest,
          oldest: c.oldest,
          exhausted: poisoned ? false : c.exhausted,
        });
        if (poisoned) void clearChannelExhausted(channelIdHex);
      });
    }
  }, [channelIdHex]);

  // A caught-up rekey changes the held stream set: forget remembered decode
  // failures, clear the exhaustion flag (a new stream key may unlock history),
  // and re-read.
  useEffect(() => {
    if (!channelIdHex) return;
    forgetChatSkips();
    const c = cursor.current.get(channelIdHex);
    if (c) c.exhausted = false;
    void clearChannelExhausted(channelIdHex);
    queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochSig]);

  // Live updates come from the wire: WireSync holds the standing kind-1059
  // subscription for EVERY channel, decrypts with our stream keys, writes the
  // rumor store, and announces `c2:<idHex>` on the bus. We just re-read.
  // (Relay backfill inside the queryFn is independently throttled below so a
  // bus invalidation is a cheap local read, not a network round.)
  //
  // `c2park:<streamPk>` covers the wire's blind spot: a wrap for one of OUR
  // stream addresses that the wire couldn't decrypt (its spec hadn't refreshed
  // past a rekey yet) is parked, not stored — re-reading drains the park via
  // the queryFn's peekPendingWraps pass, so the message paints now instead of
  // after the next poll.
  useWireScopes((scopes) => {
    if (!channelIdHex) return;
    const mine =
      scopes.has(`c2:${channelIdHex}`) ||
      (channel?.streams.some((s) => scopes.has(`c2park:${s.group.pk}`)) ?? false);
    if (mine) {
      void queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
    }
  });

  const query = useQuery<OpenedChat[]>({
    queryKey,
    // The queryFn resolves on the ArmadaDB read (see its comment), so this is a
    // store read and takes the store-read policy: no pausing while the browser
    // claims to be offline, no backoff ladder held at `isPending` — both of
    // which this query's `isLoading` is a skeleton over.
    ...STORE_READ,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    // Keep the previous render's messages painted ONLY when they belong to
    // THIS channel (the previous query has the same key), never the outgoing
    // channel's timeline during a switch. Decided from the previous query's
    // own key (race-free), NOT a ref updated by an effect: this inline closure
    // defeats TanStack's placeholder memoization, so it re-runs on EVERY
    // render while the new channel's first read is pending, and a ref would
    // already point at the new channel by the second render.
    placeholderData: (prev, prevQuery) =>
      prevQuery && hashKey(prevQuery.queryKey) === hashKey(queryKey) ? prev : undefined,
    // Live messages arrive over the wire's standing subscription (see above);
    // this timer only drives periodic relay BACKFILL/healing, itself floored by
    // BACKFILL_MIN_INTERVAL_MS. Run it slowly and only while the tab is visible
    // — a wire-bus invalidation still refreshes the view instantly on new msgs.
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const cursorKeyId = channelIdHex ?? "";

      // Fold in any wraps the native service parked (it can't decrypt) so a
      // notification's message lands from this read. Runs AFTER the store
      // paint, not serially before it: the peek opens a second IndexedDB
      // database and, with wraps parked, decrypts a notification batch —
      // ahead of the store read that used to tax every channel-switch paint.
      // writeRumors rings the bus once the drained rumors commit, so the
      // timeline re-reads and paints them right after. Decode WITHOUT the
      // query's abort signal (the batch is notification-sized) and acknowledge
      // only what actually decoded — an interrupted or key-less decode leaves
      // the wraps parked for the next read instead of destroying them.
      const drainParked = async () => {
        const parked = await peekPendingWraps(channel!.streams.map((s) => s.group.pk));
        if (parked.length === 0) return;
        const opened = await openChatBatch(parked, channel!);
        // ACK only once the rumors are actually stored. The ack DELETES the
        // parked wrap, so acking over a failed write destroys the only copy of
        // a message the user was already notified about.
        if (!(await writeRumors(community!.idHex, opened))) return;
        const openedWrapIds = new Set(opened.map((o) => o.wrapId));
        ackPendingWraps(parked.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
      };

      // hasMore is true if the local rumor window is full OR relays may have more.
      const refreshHasMore = (localFull: boolean) => {
        setHasMore(localFull || !cursor.current.get(cursorKeyId)?.exhausted);
      };

      const composeFromStore = async (extra?: OpenedChat[]): Promise<OpenedChat[]> => {
        const rumors = await queryChannelRumors(community!.idHex, channelIdHex!, {
          limit: windowLimitRef.current,
          signal,
        });
        refreshHasMore(rumors.length >= windowLimitRef.current);
        const prev = (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter(
          (m) => m.channelIdHex === channelIdHex,
        );
        // Fold in freshly-decrypted events directly rather than racing the
        // fire-and-forget rumor write.
        return upsert(prev, extra ? upsert(rumors, extra) : rumors);
      };

      const backfillAndRefresh = async (task: SyncTaskHandle) => {
        if (signal.aborted) return;
        // Hold each relay's pages until THAT relay has ACKED our stream AUTHs
        // (if it challenged) — a kind-1059 REQ racing NIP-42 gets CLOSED and
        // reads back as an empty page, which on a cold open paints "no
        // messages" for a channel that has plenty (the post-login empty-rooms
        // bug). Gated PER RELAY (backfillStore's beforeRelay) rather than
        // awaited for the whole relay set up front: one unsettled relay used
        // to hold every relay's first page behind its full cap
        // (whenAuthSettled, up to 8s) — a cold-open skeleton stall. A relay
        // that reads empty or aborts while its auth settles is recorded as
        // failed, so the cursor never seals over its region and a later round
        // retries it.
        const authGate = (url: string) => whenAuthSettled(url, () => channel!.streams.map((s) => s.group));
        // Running count of rumors this round decrypted, for the status bar.
        let synced = 0;
        const tick = () => {
          if (synced > 0) task.update({ detail: `${synced} ${synced === 1 ? "message" : "messages"}` });
        };
        // Pass 1: pull the newest page (no `until`) so live-adjacent history
        // lands first. Decrypt it and PAINT immediately — the newest page is
        // what the viewer sees on open, so the timeline shows as soon as this
        // lands rather than waiting for the deep-history passes below (which,
        // on a cold channel, meant staring at a skeleton through up to 20
        // back-to-back relay pages).
        const newest = await backfillStore(nostr, community!.relays, channel!, signal, { maxPages: 1, beforeRelay: authGate });
        if (signal.aborted) return;

        const firstOpened = await openChatBatch(newest.events, channel!, { signal });
        if (signal.aborted) return;
        writeRumors(community!.idHex, firstOpened);
        synced += firstOpened.length;
        tick();
        queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore(firstOpened));

        const saved = cursor.current.get(cursorKeyId);

        // Pass 2 (the bridge): fetch the REGION BETWEEN the saved `newest` and
        // pass 1's oldest. Without it, an offline burst larger than one page
        // leaves a permanent hole — pass 3 resumes BELOW already-seen history
        // and the advanced cursor seals the gap forever (issue #19).
        let bridge: Awaited<ReturnType<typeof backfillStore>> = {
          events: [],
          exhausted: true,
          failed: false,
        };
        if (saved?.newest && newest.oldest !== undefined && newest.oldest > saved.newest) {
          bridge = await backfillStore(nostr, community!.relays, channel!, signal, {
            until: newest.oldest - 1,
            since: saved.newest,
            beforeRelay: authGate,
          });
          if (signal.aborted) return;
        }

        // Pass 3: page OLDER history back-to-back. Resume from the saved
        // cursor if we have one; otherwise (cold channel) resume from just
        // below pass 1's newest page rather than re-fetching that page.
        const resumeFrom = saved?.oldest ?? (newest.oldest !== undefined ? newest.oldest - 1 : undefined);
        const older = await backfillStore(nostr, community!.relays, channel!, signal, { until: resumeFrom, beforeRelay: authGate });
        if (signal.aborted) return;

        // Decrypt the bridge + older pages into the rumor cache (pass 1 already
        // decrypted + painted above).
        const opened = await openChatBatch(
          [...bridge.events, ...older.events],
          channel!,
          { signal },
        );
        writeRumors(community!.idHex, opened);
        synced += opened.length;
        tick();

        // Advance the persisted cursor: `oldest` back, `exhausted` sticky, and
        // `newest` forward ONLY when the newest region is verifiably complete —
        // pass 1 had no relay failures and the bridge ran to exhaustion. An
        // incomplete round leaves `newest` where it was, so the next poll
        // re-bridges the same region instead of sealing a hole.
        const c = cursor.current.get(cursorKeyId) ?? { exhausted: false };
        if (older.oldest !== undefined && (c.oldest === undefined || older.oldest < c.oldest)) {
          c.oldest = older.oldest;
        }
        if (older.exhausted) c.exhausted = true;
        const complete = !newest.failed && bridge.exhausted;
        if (complete) {
          const top = Math.max(newest.newest ?? 0, bridge.newest ?? 0, c.newest ?? 0);
          if (top > 0) c.newest = top;
        }
        cursor.current.set(cursorKeyId, c);
        void updateChannelCursor(cursorKeyId, {
          newest: complete ? c.newest : undefined,
          oldest: c.oldest,
          exhausted: c.exhausted,
        });

        // A round that failed outright with nothing decrypted must not hold
        // the 30s throttle: the relays were likely wedged (a REQ swallowed by
        // a mid-flight NIP-42 handshake, a poisoned shared query mid-heal) —
        // let the next poll / bus ring / re-open retry immediately instead of
        // reading as a permanently empty room.
        if (synced === 0 && newest.failed && older.failed) lastBackfillRef.current = 0;

        queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore(opened));
      };

      const existing = queryClient.getQueryData<OpenedChat[]>(queryKey);

      // Relay backfill is throttled: a wire-bus invalidation re-reads the
      // store (cheap, instant) without re-paging relays on every message.
      // Nothing here gates the loading skeleton — the queryFn resolves on the
      // store read below and the relay round runs behind it, announced on the
      // sync-activity signal instead (see `beginSyncTask`).
      const dueForBackfill = Date.now() - lastBackfillRef.current >= BACKFILL_MIN_INTERVAL_MS;
      const maybeBackfill = () => {
        if (!dueForBackfill) return Promise.resolve();
        lastBackfillRef.current = Date.now();
        // Report this relay round on the sync-activity signal, named after the
        // channel with a live decrypted-message count and scoped `c2:<id>` so
        // the chat view can tell "this room is catching up" from unrelated
        // background sync — cold opens and post-wake gap-bridging are exactly
        // the "silent minute" the in-chat status bar exists for.
        const task = beginSyncTask(`#${channel!.name}`, { scope: `c2:${channel!.idHex}` });
        return backfillAndRefresh(task).finally(() => task.end());
      };

      if (existing && existing.length > 0) {
        // Warm: paint what we have; heal in the background.
        initialLoadedRef.current = channelIdHex;
        void (async () => {
          if (signal.aborted) return;
          queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore());
          await drainParked();
          await maybeBackfill();
        })().catch(() => undefined);
        return existing;
      }

      // The store read is the whole of the first load. An empty result is NOT
      // authoritative for V2 — history is decrypted by the backfill, not the
      // wire's live `since` window — but that is a SYNC state, not a loading
      // one: the park drain and the relay round below run behind this return,
      // report themselves on the sync-activity signal, and repaint through
      // `setQueryData` as they land.
      const local = await composeFromStore();
      initialLoadedRef.current = channelIdHex;
      void drainParked().catch(() => undefined);
      void maybeBackfill().catch(() => undefined);
      return local;
    },
  });

  // Keep the persisted window current. Content-compared inside, so repaint
  // churn does not rewrite it.
  useEffect(() => {
    if (channelIdHex && query.data && query.data.length > 0) {
      void persistTimelineSnapshot(channelIdHex, query.data);
    }
  }, [channelIdHex, query.data]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!hasMore || isLoadingOlder) return 0;
    const before = query.data?.filter((m) => m.kind === KIND_MESSAGE || m.kind === KIND_POLL).length ?? 0;
    const cursorKeyId = channelIdHex ?? "";
    setIsLoadingOlder(true);
    try {
      // If the rumor cache still has more than the current window, just widen
      // the window (a re-read, no network, no decrypt). Otherwise the cache is
      // exhausted, so page deeper history from the relays directly.
      const inCache = await queryChannelRumors(community!.idHex, channelIdHex!, {
        limit: windowLimitRef.current + 1,
      });
      const localHasMore = inCache.length > windowLimitRef.current;

      windowLimitRef.current += WINDOW_SIZE;

      if (!localHasMore && !cursor.current.get(cursorKeyId)?.exhausted) {
        const controller = new AbortController();
        const resumeFrom = cursor.current.get(cursorKeyId)?.oldest;
        const older = await backfillStore(nostr, community!.relays, channel!, controller.signal, {
          until: resumeFrom,
          maxPages: LOAD_OLDER_MAX_PAGES,
        });
        const opened = await openChatBatch(older.events, channel!);
        writeRumors(community!.idHex, opened);

        const c = cursor.current.get(cursorKeyId) ?? { exhausted: false };
        if (older.oldest !== undefined && (c.oldest === undefined || older.oldest < c.oldest)) {
          c.oldest = older.oldest;
        }
        if (older.exhausted) c.exhausted = true;
        cursor.current.set(cursorKeyId, c);
        // Deep-history paging never touches `newest` (that's the bridge's job).
        void updateChannelCursor(cursorKeyId, {
          oldest: c.oldest,
          exhausted: c.exhausted,
        });

        const prev = (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter(
          (m) => m.channelIdHex === channelIdHex,
        );
        queryClient.setQueryData<OpenedChat[]>(queryKey, upsert(prev, opened));
      }

      const result = await query.refetch();
      const after = result.data?.filter((m) => m.kind === KIND_MESSAGE || m.kind === KIND_POLL).length ?? 0;
      return Math.max(0, after - before);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [hasMore, isLoadingOlder, query, nostr, community, channel, channelIdHex, queryClient, queryKey]);

  // The folded view (moderation + edits + reaction tallies), plus the
  // optimistic-delete overlay.
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
    // Loading skeleton gate: the LOCAL read, and nothing else. `isPending` is
    // true from the moment the query mounts until its queryFn resolves, and
    // that queryFn resolves on the rumor-store read — so a channel whose
    // history is already in ArmadaDB paints as soon as IndexedDB answers,
    // rather than sitting behind a relay round it doesn't need. Everything
    // after that read (park drain, backfill, gap bridge) is network catch-up
    // and surfaces as sync activity (`beginSyncTask` → SyncStatusIndicator and
    // the timeline's `syncing` affordance), not as a loading state.
    //
    // Gated on `channel` so a query that is merely DISABLED (the community's
    // channels haven't folded yet, or never will) reads as not-loading instead
    // of hanging on a skeleton forever — `isPending` alone stays true for a
    // disabled query.
    isLoading: Boolean(channel) && query.isPending,
    loadOlder,
    hasMore,
    isLoadingOlder,
  };
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Send one chat-plane rumor: build (with the channel/epoch binding),
 * optimistically insert IMMEDIATELY, then sign the seal with the user's real
 * identity (a remote round-trip for NIP-46 logins), wrap under the CURRENT
 * epoch's stream key, and broadcast fire-and-forget. No pending spinner
 * (matching V1): the message is treated as sent the moment it renders —
 * clearing a spinner on the full broadcast meant awaiting every relay's OK,
 * so one dead relay held it for the whole publish timeout. A sign OR
 * broadcast failure marks the message "failed" (retry/discard) — it never
 * silently vanishes.
 */
export function useSendMessage2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel?.idHex ?? null;
  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));

  const broadcast = useCallback(
    async (wrap: NostrEvent) => {
      // Budget scaled to the signer: an auth-gating relay can demand a NIP-42
      // sign (a bunker round-trip for NIP-46 logins) inside this await (#51).
      const timeout = publishTimeoutMs(user?.method);
      const started = Date.now();
      const results = await Promise.allSettled(
        community!.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(timeout) })),
      );
      results.forEach((r, i) => {
        logSync(
          "send",
          `wrap ${wrap.id.slice(0, 8)} → ${community!.relays[i]}: ${r.status === "fulfilled" ? "accepted" : `FAILED (${r.reason instanceof Error ? r.reason.message : r.reason})`} in ${sinceMs(started)}`,
        );
      });
      if (!results.some((r) => r.status === "fulfilled")) throw new Error("No relay accepted the message.");
    },
    [nostr, community, user?.method],
  );

  return useMutation({
    mutationFn: async ({
      content,
      kind = KIND_MESSAGE,
      replyTo,
      target,
      targetKind,
      targetPubkey,
      extraTags,
      ms,
    }: {
      content: string;
      /** 9 message (default), 7 reaction, 5 delete, 3302 edit, 1111 thread reply. */
      kind?: number;
      /**
       * Thread parent. Present ⇒ this rumor is a NIP-22 kind-1111 comment, tagged
       * with `K`/`E`/`P` (root) + `k`/`e`/`p` (parent) by {@link buildV2CommentTags}
       * — NOT a kind-9 `q` (that's reserved for inline quote-replies, NIP-C7).
       */
      replyTo?: { id: string; kind: number; pubkey: string; tags: string[][] };
      /** `e`-target for reactions / deletes / edits. */
      target?: string;
      /** Kind of the `e`-target for deletes (NIP-09 `k` tag); defaults to message. */
      targetKind?: number;
      /**
       * Author of the `e`-target, for a NIP-25 `p` tag on reactions. Lives on
       * the NIP-44-encrypted rumor (never the wrap), so it leaks nothing to the
       * relay while making the reacted-to author recoverable to channel members.
       */
      targetPubkey?: string;
      /** Extra rumor tags appended verbatim (NIP-30 emoji, NIP-92 imeta, …). */
      extraTags?: string[][];
      /**
       * Override the rumor's millisecond timestamp (e.g. an edit republishes
       * with the original's `ms` so it keeps its place in the timeline).
       * Defaults to the current time.
       */
      ms?: number;
    }) => {
      if (!user) throw new Error("Sign in to send a message.");
      if (!community || !channel) throw new Error("No channel selected.");
      // Death is one-way (CORD-02 §9). Gated at the PUBLISH, not just in the
      // UI: `canWrite` is derived from a query that is undefined on its first
      // tick, so a composer can be live for a moment before the verdict lands.
      // This read is local and sticky — once dissolved, never writable again.
      if ((await dissolvedAt(community.idHex)) !== undefined) {
        throw new Error("This community has been dissolved; it accepts no new messages.");
      }

      // A threaded reply is a NIP-22 comment (kind 1111), not a kind-9 message.
      const effectiveKind = replyTo ? KIND_COMMENT : kind;
      const effectiveMs = ms ?? Date.now();
      const tags: string[][] = [...channelBindingTags(channel.idHex, channel.current.epoch)];
      if (replyTo) tags.push(...buildV2CommentTags(replyTo));
      if (target) tags.push(["e", target]);
      // NIP-25: a reaction SHOULD carry a `p` for the reacted-to author. Safe
      // in V2 — the tag lives on the NIP-44-encrypted rumor, never the wrap.
      if (kind === KIND_REACTION && targetPubkey) tags.push(["p", targetPubkey]);
      if (kind === KIND_DELETE && target) tags.push(["k", String(targetKind ?? KIND_MESSAGE)]);
      if (extraTags) tags.push(...extraTags);

      const rumor: NostrRumor = buildRumor({ kind: effectiveKind, content, tags, pubkey: user.pubkey, ms: effectiveMs });
      // The message renders IMMEDIATELY — before the seal, which for a
      // NIP-46 login is a remote round-trip that can take seconds — and with
      // NO pending spinner (matching V1): the broadcast is near-instant in
      // reality, and gating the spinner on the full broadcast meant one dead
      // relay held it for the whole publish timeout. A message the user typed
      // must never silently vanish: sign or broadcast failure flips it to
      // "failed" (retry/discard affordance) instead of eating it.
      const isVisible = effectiveKind === KIND_MESSAGE || effectiveKind === KIND_COMMENT || effectiveKind === KIND_POLL;
      const opened: OpenedChat = {
        rumorId: rumor.id,
        author: user.pubkey,
        kind: effectiveKind,
        content,
        tags,
        ms: effectiveMs,
        createdAt: rumor.created_at,
        // Placeholders until sealed — the entry is re-upserted (same rumorId)
        // with the real seal/wrap below, and is NOT persisted before that.
        wrapId: "",
        streamPk: channel.current.group.pk,
        sealKind: KIND_SEAL_ENCRYPTED,
        seal: {
          id: "",
          pubkey: user.pubkey,
          kind: KIND_SEAL_ENCRYPTED,
          content: "",
          tags: [],
          created_at: rumor.created_at,
          sig: "",
        },
        channelIdHex: channel.idHex,
        epoch: channel.current.epoch,
      };
      if (isVisible) {
        queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) => upsert(old, [opened]));
      }

      logSync("send", `sealing rumor ${rumor.id.slice(0, 8)} (kind ${effectiveKind}) — signer: ${user.method}`);
      const sealStarted = Date.now();
      let seal: NostrEvent;
      try {
        seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      } catch (err) {
        logSync("send", `sealing ${rumor.id.slice(0, 8)} FAILED in ${sinceMs(sealStarted)}: ${err instanceof Error ? err.message : String(err)}`);
        if (isVisible) {
          // The message stays in the timeline as failed — retryable.
          setStatus(rumor.id, "failed");
          return { rumorId: rumor.id, wrap: undefined };
        }
        throw err; // reactions/edits/deletes: callers own the rollback
      }
      logSync("send", `sealed ${rumor.id.slice(0, 8)} in ${sinceMs(sealStarted)} — wrapping + broadcasting to ${community.relays.length} relay(s)`);
      const wrap = wrapSeal(seal, channel.current.group);

      // The wrap is authored by the channel stream key rather than the user,
      // so identify this exact relay event as local before its push can arrive.
      await markOwnWebPushEvent(wrap.id);

      const sealed: OpenedChat = { ...opened, seal, wrapId: wrap.id, streamPk: wrap.pubkey };
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) => upsert(old, [sealed]));
      // Persist to the rumor cache so a refresh mid-flight keeps the message
      // (and a self-delete removes its target via the store's NIP-09).
      writeRumors(community.idHex, [sealed]);

      void broadcast(wrap).catch(() => {
        if (isVisible) setStatus(rumor.id, "failed");
      });

      return { rumorId: rumor.id, wrap: wrap as NostrEvent | undefined };
    },
  });
}

/** Retry / discard a failed optimistic message, and optimistic self-delete. */
export function useMessageActions2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  // The fold supplies this actor's own Grant head, which a moderation delete
  // cites (CORD-04 §5).
  const { data: folded } = useControlFold2(community);
  const channelIdHex = channel?.idHex ?? null;
  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));
  const { mutateAsync: send } = useSendMessage2(community, channel);

  const retry = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const raw = queryClient.getQueryData<OpenedChat[]>(channelKey(channelIdHex)) ?? [];
      const msg = raw.find((m) => m.rumorId === id);
      if (!msg) return;
      // Re-send as a fresh rumor (a new id); drop the failed original. A
      // threaded reply (kind-1111 comment) carries its NIP-22 thread pointers in
      // its own tags, so preserve them verbatim (minus the channel binding,
      // which `send` re-adds) rather than rebuilding from a parent event.
      const isComment = msg.kind === KIND_COMMENT;
      const threadTags = isComment
        ? msg.tags.filter(([n]) => n !== "channel" && n !== "epoch")
        : undefined;
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.rumorId !== id),
      );
      setStatus(id, undefined);
      void send({
        content: msg.content,
        kind: msg.kind,
        extraTags: threadTags,
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
      // A delete of someone ELSE's message is an authority action, so it cites
      // the Grant it acts under (CORD-04 §5) — without it a peer whose roster is
      // one sweep stale cannot tell a moderator from a demoted one, and refuses
      // the delete. A self-delete is not an authority action and never cites.
      const target = (queryClient.getQueryData<OpenedChat[]>(channelKey(channelIdHex)) ?? [])
        .find((m) => m.rumorId === id);
      const moderating = Boolean(target && target.author !== user.pubkey);
      const citation = moderating ? citationFor(community, folded, user.pubkey) : undefined;
      queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
        old.includes(id) ? old : [...old, id],
      );
      void send({
        content: "",
        kind: KIND_DELETE,
        target: id,
        extraTags: citation ? [citationToTag(citation)] : undefined,
      }).catch(() => {
        // Couldn't publish the delete — unhide so the user knows.
        queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) => old.filter((d) => d !== id));
      });
    },
    [user, community, channel, channelIdHex, queryClient, send, folded],
  );

  return { retry, discard, deleteMessage };
}

/** The optimistic send-status map for a channel. */
export function useSendStatus2(channel: ChannelV2 | undefined): SendStatusMap {
  return useSendStatusMapValue(statusKey(channel?.idHex ?? null));
}
