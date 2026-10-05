import { useNostr } from "@nostrify/react";
import { hashKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { citationFor, dissolvedAt, useControlFold, useDissolved } from "@/concord/hooks/useControlPlane";
import { persistTimelineSnapshot, prewarmTimelineSnapshot, takeSnapshotSeed } from "@/concord/hooks/timelineSnapshot";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useKeyedMemo } from "@/hooks/useKeyedMemo";
import type { SendStatus, SendStatusMap } from "@/hooks/useSendStatusMap";
import {
  buildConcordCommentTags,
  filterEpochCutoff,
  foldTimeline,
  forgetChatSkips,
  openChatBatch,
  type ChatModeration,
  type FoldedTimeline,
  type OpenedChat,
} from "@/concord/lib/chat";
import { backfillStore, LOAD_OLDER_MAX_PAGES, setChannelSyncContext } from "@/concord/lib/channelSync";
import { KIND_COMMENT, KIND_DELETE, KIND_MESSAGE, KIND_POLL, KIND_REACTION, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import {
  clearStreamExhausted,
  CHAT_ROW_KINDS,
  queryChannelFirstSeenCached,
  queryChannelPageBefore,
  queryChannelRumors,
  queryChannelRumorsByIds,
  readStreamCursor,
  sweepExpiredCommunityRumors,
  updateStreamCursor,
  writeRumors,
  peekPendingWraps,
  ackPendingWraps,
  removeRumors,
} from "@/concord/lib/rumorStore";
import {
  discardOutgoing,
  failOutgoing,
  getOutgoing,
  outgoingStatusMap,
  putOutgoing,
  recordToRow,
  updateOutgoing,
  subscribeOutgoing,
  unsealedOutgoingRows,
  withoutMsTag,
  type OutgoingRecord,
} from "@/concord/lib/outgoing";
import { isRelayTrusted, verifyOutgoing, type VerifyPool } from "@/concord/lib/outgoingVerify";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  rememberQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { recordSightings, sightingsRevision, subscribeSightings } from "@/concord/lib/mediaTrust";
import { citationToTag, type AuthorityCitation } from "@/concord/lib/edition";
import { citationSatisfied } from "@/concord/lib/control";
import { useActivePause } from "@/concord/hooks/usePause";
import { canActOnMember, isAuthorized, isAuthorizedIn, isStaff, Permissions } from "@/concord/lib/roles";
import { chatExpiresAt, messageExpirationOf } from "@/concord/lib/disappearing";
import { consumeSend, isRateLimitedKind, SendRateLimitError } from "@/concord/lib/sendRateLimit";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Channel, Community } from "@/concord/lib/types";
import { publishTimeoutMs } from "@/lib/publishTimeout";
import { logSync, sinceMs } from "@/lib/syncLog";
import { STORE_READ } from "@/lib/storeQuery";
import { markOwnWebPushEvent } from "@/lib/webPushState";
import { invalidateSyncTopic } from "@/sync/syncManager";
import { useSyncTopic } from "@/sync/useSyncTopic";
import { useWireScopes } from "@/wire/useWireScopes";
import { shareByRumorId } from "@/lib/shareRows";

import type { NostrEvent } from "@nostrify/nostrify";

export const channelKey = (channelIdHex: string | null) => ["concord", "channel", channelIdHex] as const;
const deletedKey = (channelIdHex: string | null) => ["concord", "msg-deleted", channelIdHex] as const;

/** Reactions share the wrap kind with messages (no relay pre-filter), so the window absorbs both. */
const WINDOW_SIZE = 100;

/**
 * Flood detector history window: time-based to capture the QUIET before a
 * flood (a row count spends itself on the flood); 7 days covers weekend lulls.
 */
const FLOOD_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FLOOD_HISTORY_MAX_ROWS = 4000;

const EMPTY_RAW: OpenedChat[] = [];

export interface ChannelTimelineFocus {
  messageId?: string;
  threadRoot?: string;
}

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

const upsert = upsertOpenedChat;

/** Swap in `row` for the cached row with its rumor id (`upsert` keeps the old one). */
function replaceRow(old: OpenedChat[] | undefined, row: OpenedChat): OpenedChat[] {
  const i = old?.findIndex((m) => m.rumorId === row.rumorId) ?? -1;
  if (!old || i < 0) return upsert(old, [row]);
  const next = old.slice();
  next[i] = row;
  return next;
}

/**
 * Scroll-back resume point, kept per channel beside the cache. Not derived
 * from the cache's oldest row: a retained permalink row can be far older and skip the gap.
 */
interface PageCursor {
  until: number;
  ids: Set<string>;
}
const ROW_KINDS = new Set(CHAT_ROW_KINDS);
const pageCursors = new Map<string, PageCursor>();

function lowerCursor(cursor: PageCursor | undefined, events: readonly OpenedChat[]): PageCursor | undefined {
  let out = cursor;
  for (const ev of events) {
    if (!ROW_KINDS.has(ev.kind)) continue;
    if (!out || ev.createdAt < out.until) out = { until: ev.createdAt, ids: new Set([ev.rumorId]) };
    else if (ev.createdAt === out.until) out.ids.add(ev.rumorId);
  }
  return out;
}

function cursorHolds(cursor: PageCursor | undefined, data: readonly OpenedChat[]): cursor is PageCursor {
  return !!cursor && data.some((m) => cursor.ids.has(m.rumorId));
}

export interface ChatModerationState extends ChatModeration {
  /**
   * Whether a control fold (live or restored) backs this context. Until then
   * `banned` is empty for want of a Banlist, not because nobody is banned, so
   * a read surface withholds rows rather than painting banned authors.
   */
  ready: boolean;
}

/**
 * Moderation context from the control fold. AMBIENT callers (rail, badges)
 * must pass `active` false: one active observer lights the shared key into
 * a per-community network fan-out (see `useConcordUnread.network.test.tsx`).
 */
export function useChatModeration(
  community: Community | undefined,
  active = true,
): ChatModerationState {
  const { data: folded } = useControlFold(community, active);
  const { data: dissolvedAtMs } = useDissolved(community, active);
  return useMemo(
    () => ({
      ready: folded !== undefined,
      banned: folded?.banned ?? new Set<string>(),
      canDelete: (deleter: string, author: string, action?: { citation?: AuthorityCitation; ms: number }) => {
        if (!folded || !community) return false;
        // CORD-02 §9: death is an ORDERING rule — only actions after the tombstone
        // are refused, or old moderation would be un-hidden. Self-deletes short-circuit earlier.
        if (dissolvedAtMs !== null && dissolvedAtMs !== undefined && action && action.ms > dissolvedAtMs) {
          return false;
        }
        // Against the CURRENT roster: a citation is a completeness floor, never a grant (CORD-04 §5).
        if (!canActOnMember(folded.roster, deleter, folded.ownerHex, author, Permissions.MANAGE_MESSAGES)) {
          return false;
        }
        // Sync floor: uncited means we haven't read enough of their Grant, so park.
        return citationSatisfied(folded, community.id, deleter, action?.citation);
      },
      // CORD-08 §4: only from MANAGE_METADATA; unverifiable until the fold lands.
      canSetTimer: (author: string) =>
        Boolean(folded && isAuthorized(folded.roster, author, folded.ownerHex, Permissions.MANAGE_METADATA)),
      isStaff: (author: string) => Boolean(folded && isStaff(folded.roster, author, folded.ownerHex)),
      canMentionEveryone: (author: string, channelIdHex: string) => Boolean(
        folded
        && isAuthorizedIn(
          folded.roster,
          author,
          folded.ownerHex,
          channelIdHex,
          Permissions.MENTION_EVERYONE,
        )
      ),
    }),
    [folded, community, dissolvedAtMs],
  );
}

/**
 * One channel's timeline, local-first from the decrypted rumor store and
 * folded with moderation in memory. Wraps are never persisted.
 *
 * LOCAL-FIRST IS THE LOADING CONTRACT: the queryFn resolves on the store read;
 * park drain and relay catch-up repaint via `setQueryData` and report as sync
 * activity, never `isLoading`.
 */
export function useChannelTimeline(
  community: Community | undefined,
  channel: Channel | undefined,
  /** Known from the URL on first render, so the snapshot can seed before a {@link Channel} exists. */
  routeChannelIdHex?: string | null,
  focus?: ChannelTimelineFocus,
) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const moderation = useChatModeration(community);
  // The snapshot is keyed by reader: it's read before any key proves membership.
  const { user: readingUser } = useCurrentUser();
  // CORD-04 §8 pause; `useActivePause` schedules the `until` wake. Scalar so
  // the memo isn't defeated by a fresh object.
  const pauseSince = useActivePause(community)?.since;

  const channelIdHex = channel?.idHex ?? routeChannelIdHex ?? null;
  // Cutoffs included: retirement can change without the epoch set changing.
  const epochSig = channel?.streams.map((s) => `${s.epoch}:${s.retiredAt ?? ""}`).join(",") ?? "";
  const queryKey = useMemo(() => channelKey(channelIdHex), [channelIdHex]);
  const focusIds = useMemo(
    () => [...new Set([focus?.threadRoot, focus?.messageId].filter((id): id is string => Boolean(id)))],
    [focus?.threadRoot, focus?.messageId],
  );
  const focusSig = focusIds.join(",");

  // Seed from the persisted window before the fold chain resolves (see timelineSnapshot).
  const viewerPubkey = readingUser?.pubkey;
  useEffect(() => {
    if (!viewerPubkey || !channelIdHex) return;
    void prewarmTimelineSnapshot(queryClient, viewerPubkey, channelIdHex, channelKey(channelIdHex));
  }, [viewerPubkey, channelIdHex, queryClient]);

  // Physically purge expired messages (CORD-08 §3); self-gated per community.
  useEffect(() => {
    if (community?.idHex) void sweepExpiredCommunityRumors(community.idHex).catch(() => undefined);
  }, [community?.idHex]);

  // Keeps a live re-read from turning `hasMore` back on.
  const endReachedRef = useRef(false);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // Wakes the fold (reads Date.now()) when a held future-dated message's time arrives.
  const [revealTick, setRevealTick] = useState(0);

  useEffect(() => {
    endReachedRef.current = false;
    setHasMore(true);
    setIsLoadingOlder(false);
  }, [channelIdHex]);

  // A new stream key may unlock history: reset failures/exhaustion and force a round.
  useEffect(() => {
    if (!channelIdHex) return;
    forgetChatSkips();
    endReachedRef.current = false;
    void clearStreamExhausted(channelIdHex);
    invalidateSyncTopic(`c2:${channelIdHex}`);
    queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochSig]);

  // The sync scheduler owns catch-up; register the `c2:` context BEFORE the
  // want so a round never starts without it. Freshness is a durable stamp.
  useEffect(() => {
    if (!community || !channel) return;
    return setChannelSyncContext(channel.idHex, { nostr, community, channel });
  }, [nostr, community, channel]);
  useSyncTopic(community && channel ? `c2:${channel.idHex}` : undefined);

  // WireSync decrypts live wraps and rings `c2:<idHex>`; we just re-read.
  // `c2park:<streamPk>` covers wraps the wire parked (spec not yet past a
  // rekey), drained by the queryFn's peekPendingWraps pass.
  useWireScopes((scopes) => {
    if (!channelIdHex) return;
    const mine =
      scopes.has(`c2:${channelIdHex}`) ||
      scopes.has(`c2cur:${channelIdHex}`) ||
      (channel?.streams.some((s) => scopes.has(`c2park:${s.group.pk}`)) ?? false);
    if (mine) {
      void queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
    }
  });

  // Exact route-target lookup in its own key, so `/m/<id>` changes always look up.
  const focusQuery = useQuery<OpenedChat[]>({
    ...STORE_READ,
    queryKey: ["concord", "channel-focus", community?.idHex ?? null, channelIdHex, focusSig],
    queryFn: ({ signal }) =>
      queryChannelRumorsByIds(community!.idHex, channelIdHex!, focusIds, { signal }),
    enabled: Boolean(community && channel && channelIdHex && focusIds.length > 0),
    staleTime: Infinity,
  });

  const query = useQuery<OpenedChat[]>({
    queryKey,
    // Keyed: older pages shift every index (see shareRows).
    structuralSharing: shareByRumorId,
    // Store-read policy: no offline pause or backoff behind the skeleton.
    ...STORE_READ,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    // Keep previous data only for THIS channel, decided from the previous query's
    // key (a ref would be stale since this closure re-runs every pending render).
    placeholderData: (prev, prevQuery) =>
      prevQuery && hashKey(prevQuery.queryKey) === hashKey(queryKey) ? prev : undefined,
    // No refetch timer: live via the wire, catch-up via the scheduler.
    queryFn: async ({ signal }) => {
      const cursorKeyId = channelIdHex ?? "";

      // Drain natively parked wraps AFTER the store paint (it opens another IDB and
      // decrypts). Decode without the abort signal; ack only what decoded.
      const drainParked = async () => {
        const parked = await peekPendingWraps(channel!.streams.map((s) => s.group.pk));
        if (parked.length === 0) return;
        const opened = await openChatBatch(parked, channel!);
        // The ack DELETES the parked wrap, so only after the write succeeds.
        if (!(await writeRumors(community!.idHex, opened))) return;
        const openedWrapIds = new Set(opened.map((o) => o.wrapId));
        ackPendingWraps(parked.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
      };

      const composeFromStore = async (extra?: OpenedChat[]): Promise<OpenedChat[]> => {
        // Only the NEWEST page: older pages are already cached, and re-reading them
        // made every live message cost the whole window.
        const [rumors, saved] = await Promise.all([
          queryChannelRumors(community!.idHex, channelIdHex!, {
            limit: WINDOW_SIZE,
            signal,
          }),
          readStreamCursor(cursorKeyId),
        ]);
        setHasMore(!endReachedRef.current && (rumors.length >= WINDOW_SIZE || !saved?.exhausted));
        // A snapshot seed is replaced, not merged into: a row only it holds was never stored.
        const prev = takeSnapshotSeed(viewerPubkey, channelIdHex!)
          ? []
          : (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter((m) => m.channelIdHex === channelIdHex);
        // A cursor for a dropped cache would skip rows; restart it from this page.
        const held = pageCursors.get(cursorKeyId);
        const cursor = lowerCursor(cursorHolds(held, prev) ? held : undefined, rumors);
        if (cursor) pageCursors.set(cursorKeyId, cursor);
        else pageCursors.delete(cursorKeyId);
        // Fold in freshly-decrypted events directly (don't race the write). The
        // cutoff filter re-applies to rows stored before a rotation was known.
        return filterEpochCutoff(upsert(prev, extra ? upsert(rumors, extra) : rumors), channel!);
      };

      const existing = queryClient.getQueryData<OpenedChat[]>(queryKey);

      if (existing && existing.length > 0) {
        void (async () => {
          if (signal.aborted) return;
          queryClient.setQueryData<OpenedChat[]>(queryKey, await composeFromStore());
          await drainParked();
        })().catch(() => undefined);
        return existing;
      }

      // An empty store is a SYNC state, not a loading one: history comes from the scheduler's backfill.
      const local = await composeFromStore();
      void drainParked().catch(() => undefined);
      return local;
    },
  });

  // Sends that never sealed live only in the outgoing record, so a reload still shows them (failed).
  // Identity-stable: an outgoing change that adds no such row re-renders nothing.
  const unsealed = useSyncExternalStore(subscribeOutgoing, () => unsealedOutgoingRows(viewerPubkey, channelIdHex));

  // Focused rows paint immediately and are retained in the channel cache after `/m/` clears.
  // Keyed per channel so a switch-back returns the same array (downstream memos bail).
  const raw = useKeyedMemo(
    channelIdHex,
    () => {
      const base = unsealed.length > 0 ? upsert(query.data, unsealed) : (query.data ?? EMPTY_RAW);
      return channel ? filterEpochCutoff(upsert(base, focusQuery.data ?? EMPTY_RAW), channel) : base;
    },
    [query.data, focusQuery.data, channel, unsealed],
  );
  useEffect(() => {
    const rows = focusQuery.data;
    if (!channel || !rows || rows.length === 0) return;
    // Only ADD to a window the channel read produced: seeding an empty cache
    // would resolve the query to these rows alone and break the permalink jump.
    const old = queryClient.getQueryData<OpenedChat[]>(queryKey);
    if (!old || old.length === 0) return;
    // Terminates: a refused row never grows the window.
    const next = filterEpochCutoff(upsert(old, rows), channel);
    if (next.length === old.length) return;
    queryClient.setQueryData<OpenedChat[]>(queryKey, next);
  }, [channel, focusQuery.data, query.data, queryClient, queryKey]);

  // Content-compared inside, so churn doesn't rewrite it.
  useEffect(() => {
    if (viewerPubkey && channelIdHex && raw.length > 0) {
      void persistTimelineSnapshot(viewerPubkey, channelIdHex, raw);
    }
  }, [viewerPubkey, channelIdHex, raw]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!hasMore || isLoadingOlder) return 0;
    const before = raw.filter((m) => m.kind === KIND_MESSAGE || m.kind === KIND_POLL).length;
    const cursorKeyId = channelIdHex ?? "";
    setIsLoadingOlder(true);
    try {
      // One bounded store read below the cursor; relays only when the store runs short.
      const cached = queryClient.getQueryData<OpenedChat[]>(queryKey) ?? [];
      const held = pageCursors.get(cursorKeyId);
      const cursor = cursorHolds(held, cached) ? held : undefined;
      let added: OpenedChat[] = [];
      let localFull = false;
      if (cursor) {
        const page = await queryChannelPageBefore(community!.idHex, channelIdHex!, {
          until: cursor.until,
          skip: cursor.ids,
          limit: WINDOW_SIZE,
        });
        added = page.events;
        localFull = page.full;
      }

      let exhausted = false;
      if (!localFull) {
        const saved = await readStreamCursor(cursorKeyId);
        exhausted = !!saved?.exhausted;
        if (!exhausted) {
          const controller = new AbortController();
          const older = await backfillStore(nostr, community!.relays, channel!, controller.signal, {
            until: saved?.oldest,
            maxPages: LOAD_OLDER_MAX_PAGES,
          });
          const opened = await openChatBatch(older.events, channel!);
          writeRumors(community!.idHex, opened);
          exhausted = older.exhausted;

          // Never touches `newest` (the scheduler's job). The merge is monotonic and
          // serialized per scope in `updateStreamCursor`, so concurrent writers merge.
          void updateStreamCursor(cursorKeyId, {
            oldest: older.oldest,
            exhausted: older.exhausted ? true : undefined,
          });
          added = upsert(added, opened);
        }
      }

      const next = lowerCursor(cursor, added);
      if (next) pageCursors.set(cursorKeyId, next);
      endReachedRef.current = !localFull && exhausted;
      setHasMore(!endReachedRef.current);

      const prev = (queryClient.getQueryData<OpenedChat[]>(queryKey) ?? []).filter(
        (m) => m.channelIdHex === channelIdHex,
      );
      const merged = filterEpochCutoff(upsert(prev, added), channel!);
      queryClient.setQueryData<OpenedChat[]>(queryKey, merged);
      const after = merged.filter((m) => m.kind === KIND_MESSAGE || m.kind === KIND_POLL).length;
      return Math.max(0, after - before);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [hasMore, isLoadingOlder, raw, nostr, community, channel, channelIdHex, queryClient, queryKey]);

  const optimisticDeleted = useQuery<string[]>({
    queryKey: deletedKey(channelIdHex),
    // Populated imperatively via setQueryData; the no-op queryFn only silences a dev warning.
    queryFn: () => [],
    enabled: false,
    initialData: [],
  }).data;

  // Channel first-seen map: a flood fills WINDOW_SIZE, so every author in it
  // would look new (see `queryChannelFirstSeen`). One indexed read per open.
  const firstSeen = useQuery({
    ...STORE_READ,
    queryKey: ["concord-channel-first-seen", community?.idHex ?? null, channelIdHex],
    queryFn: ({ signal }) =>
      queryChannelFirstSeenCached(community!.idHex, channelIdHex!, {
        sinceMs: Date.now() - FLOOD_HISTORY_WINDOW_MS,
        limit: FLOOD_HISTORY_MAX_ROWS,
        signal,
      }),
    enabled: !!community?.idHex && !!channelIdHex,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  }).data;

  // Re-fold when the persisted quarantine warms or grows (see quarantineMemory.ts).
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);

  // Lower bound on the room's age for the drown rule (FloodOptions.establishedSinceMs),
  // so a TOTAL nuke still folds. Oldest of: (1) oldest held root rotation
  // (unforgeable, often absent); (2) earliest store activity in `firstSeen`
  // (best-effort; evading it collapses the wave's timespan the pace gate reads).
  const establishedSinceMs = useMemo(() => {
    let oldest: number | undefined;
    for (const r of community?.heldRoots ?? []) {
      if (typeof r.retiredAt === "number") {
        const ms = r.retiredAt * 1000;
        if (oldest === undefined || ms < oldest) oldest = ms;
      }
    }
    if (firstSeen) for (const ms of firstSeen.values()) if (oldest === undefined || ms < oldest) oldest = ms;
    return oldest;
  }, [community?.heldRoots, firstSeen]);

  // Rows wait for the Banlist (CORD-04 §4) so a snapshot or store read that
  // beats the control fold never paints a banned author.
  const moderated = moderation.ready ? raw : EMPTY_RAW;

  // Keyed per channel so a switch-back returns the cached fold.
  const folded: FoldedTimeline = useKeyedMemo(channelIdHex, () => {
    void memoryRev;
    void revealTick;
    const result = foldTimeline(moderated, moderation, {
      ...(readingUser?.pubkey !== undefined ? { self: readingUser.pubkey } : {}),
      ...(firstSeen ? { firstSeen } : {}),
      ...(establishedSinceMs !== undefined ? { establishedSinceMs } : {}),
      ...(pauseSince !== undefined ? { pauseSince } : {}),
    });
    // Past sessions' verdicts keep yesterday's wall folded after a refresh.
    const remembered = community?.idHex && channelIdHex
      ? recallQuarantined(community.idHex, channelIdHex)
      : undefined;
    let quarantined = result.quarantined;
    if (remembered) {
      quarantined = new Set(quarantined);
      for (const id of remembered) quarantined.add(id);
      // Re-assert staff/self immunity over recalled verdicts.
      const immune = (a: string) => a === readingUser?.pubkey || Boolean(moderation?.isStaff?.(a));
      for (const m of result.messages) if (quarantined.has(m.rumorId) && immune(m.author)) quarantined.delete(m.rumorId);
    }
    const merged = quarantined === result.quarantined ? result : { ...result, quarantined };
    if (optimisticDeleted && optimisticDeleted.length > 0) {
      const hidden = new Set(optimisticDeleted);
      return { ...merged, messages: merged.messages.filter((m) => !hidden.has(m.rumorId)) };
    }
    return merged;
  }, [moderated, moderation, optimisticDeleted, readingUser?.pubkey, firstSeen, establishedSinceMs, pauseSince, community?.idHex, channelIdHex, memoryRev, revealTick]);

  // Wake the fold when a held future-dated message (FUTURE_HOLD_MS) comes due;
  // nothing else re-renders this timeline for it.
  const nextRevealMs = folded.nextRevealMs;
  useEffect(() => {
    if (nextRevealMs === undefined) return;
    // +1ms so the wake lands strictly past the fold's ceiling.
    const ms = nextRevealMs - Date.now() + 1;
    if (ms <= 0) {
      setRevealTick((n) => n + 1);
      return;
    }
    // Clamp to setTimeout's max, or far-future dates fire immediately.
    const t = setTimeout(() => setRevealTick((n) => n + 1), Math.min(ms, 2_147_483_647));
    return () => clearTimeout(t);
  }, [nextRevealMs]);

  // Persist verdicts (merge-only) whose evidence won't reload. PAUSE-collapsed
  // ids are excluded: a merge-only memory would make a transient pause
  // permanent (violating CORD-04 §8 "MUST NOT drop").
  useEffect(() => {
    if (!community?.idHex || !channelIdHex || folded.quarantined.size === 0) return;
    const entries: Array<[string, number]> = [];
    for (const m of moderated) {
      if (folded.quarantined.has(m.rumorId) && !folded.paused.has(m.rumorId)) entries.push([m.rumorId, m.ms]);
    }
    if (entries.length > 0) rememberQuarantined(community.idHex, channelIdHex, entries);
  }, [folded.quarantined, folded.paused, moderated, community?.idHex, channelIdHex]);

  // Who this client has seen speak, and since when — the media hold's probation
  // clock (mediaTrust.ts). After the local read, so a channel isn't seeded empty.
  const sightingsRev = useSyncExternalStore(subscribeSightings, sightingsRevision);
  const localReadDone = !query.isPending && moderation.ready;
  useEffect(() => {
    if (!community?.idHex || !channelIdHex || !localReadDone) return;
    const observed: Array<[string, number]> = folded.messages.map((m) => [m.author, m.ms]);
    if (firstSeen) observed.push(...firstSeen);
    recordSightings(community.idHex, channelIdHex, observed);
  }, [folded.messages, firstSeen, localReadDone, community?.idHex, channelIdHex, sightingsRev]);

  // A focus target already in the window needs no lookup to paint, so opening a
  // thread from a visible row doesn't drop the timeline back to its skeleton.
  const focusMissing = useMemo(
    () => focusIds.length > 0 && focusIds.some((id) => !raw.some((m) => m.rumorId === id)),
    [focusIds, raw],
  );

  return {
    folded,
    /** The RAW rows, pre-fold; a Pin needs the Edit rumor itself (CORD-04 §7). */
    raw: moderated,
    // The LOCAL reads only (rows + control fold); network catch-up is sync
    // activity. Gated on `channel` since a disabled query stays `isPending` forever.
    isLoading:
      Boolean(channel) &&
      (query.isPending || !moderation.ready || (focusMissing && focusQuery.isPending)),
    loadOlder,
    hasMore,
    isLoadingOlder,
  };
}

interface WrapPublisher {
  relay(url: string): { event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown> };
}

/** NIP-01 machine-readable refusals: the relay answered, so a re-send won't change its mind. */
const NIP01_REFUSAL = /^(duplicate|pow|blocked|rate-limited|invalid|restricted|mute|error|auth-required):/;
/** Delay before re-sending a delivered wrap to the relays that never answered it. */
const SILENT_RELAY_RETRY_MS = 30_000;

/** Publishes keep running this long after the failed decision so a late ACK clears "failed". */
const LATE_ACK_GRACE_MS = 20_000;

/**
 * Broadcast a wrap, driving send status via `onStatus`: any accept clears it;
 * no accept within the budget sets "failed", but a LATE accept within the
 * grace window still clears it. Never throws.
 */
export function broadcastWrap(
  nostr: WrapPublisher,
  relays: string[],
  wrap: NostrEvent,
  method: string | undefined,
  onStatus: (status: SendStatus | undefined) => void,
  opts?: {
    /** Every relay that said OK (or `duplicate:`), trusted or not. */
    onAccept?: (url: string) => void;
    /** Whether a relay's OK alone clears the status; others only feed `onAccept`. */
    countsAsDelivered?: (url: string) => boolean;
  },
): void {
  if (relays.length === 0) {
    onStatus("failed");
    return;
  }
  const decisionMs = publishTimeoutMs(method);
  const hardMs = decisionMs + LATE_ACK_GRACE_MS;
  const started = Date.now();
  let accepted = false;
  let settled = 0;
  /** Relays that never answered (timeout, dead socket), as opposed to refusing it. */
  const silent: string[] = [];

  const decide = setTimeout(() => {
    if (!accepted) onStatus("failed");
  }, decisionMs);

  for (const url of relays) {
    void nostr
      .relay(url)
      .event(wrap, { signal: AbortSignal.timeout(hardMs) })
      // NIP-01 says a duplicate is OK true, but relays that answer false still HAVE it.
      .catch((reason) => {
        if (reason instanceof Error && /^duplicate:/.test(reason.message)) return;
        throw reason;
      })
      .then(() => {
        logSync("send", `wrap ${wrap.id.slice(0, 8)} → ${url}: accepted in ${sinceMs(started)}`);
        opts?.onAccept?.(url);
        if (opts?.countsAsDelivered && !opts.countsAsDelivered(url)) return;
        if (!accepted) {
          accepted = true;
          clearTimeout(decide);
          onStatus(undefined);
        }
      })
      .catch((reason) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (!NIP01_REFUSAL.test(message)) silent.push(url);
        logSync("send", `wrap ${wrap.id.slice(0, 8)} → ${url}: FAILED (${message}) in ${sinceMs(started)}`);
      })
      .finally(() => {
        settled += 1;
        if (settled < relays.length) return;
        // All relays answered with no accept: fail now.
        if (!accepted) {
          clearTimeout(decide);
          onStatus("failed");
          return;
        }
        // Delivered, so nothing else will re-send it: give the relays that never
        // answered one more copy, as one accept may be a relay that drops it.
        if (silent.length > 0) {
          setTimeout(() => {
            for (const url of silent) {
              void nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(hardMs) }).catch(() => undefined);
            }
          }, SILENT_RELAY_RETRY_MS);
        }
      });
  }
}

/**
 * Drive a visible send's outgoing record from `broadcastWrap`: any accept means
 * it landed; "failed" keeps the record (and its wrap) for Retry and the resume.
 */
/** (Re-)broadcast a recorded send's signed wrap under the outgoing-record callbacks. */
export function rebroadcastOutgoing(nostr: WrapPublisher & VerifyPool, rec: OutgoingRecord, method: string | undefined): void {
  if (!rec.wrap) return;
  putOutgoing(rec);
  const tracked = outgoingBroadcast(nostr, rec.rumorId, method);
  broadcastWrap(nostr, rec.relays, rec.wrap, method, tracked.onStatus, tracked);
}

export function outgoingBroadcast(nostr: WrapPublisher & VerifyPool, rumorId: string, method: string | undefined) {
  const acked: string[] = [];
  const rebroadcast = (rec: OutgoingRecord) => rebroadcastOutgoing(nostr, rec, method);
  return {
    onAccept: (url: string) => {
      acked.push(url);
      // A late accept joins a read-back already queued.
      if (getOutgoing(rumorId)?.verifyAt !== undefined) verifyOutgoing(nostr, rumorId, [url], rebroadcast);
    },
    countsAsDelivered: isRelayTrusted,
    onStatus: (status: SendStatus | undefined) => {
      if (status === undefined) {
        updateOutgoing(rumorId, { state: "verifying" });
        verifyOutgoing(nostr, rumorId, acked, rebroadcast);
      } else if (status === "failed") {
        failOutgoing(rumorId);
        // Only distrusted relays took it: shown failed until a read-back finds it.
        if (acked.length > 0) verifyOutgoing(nostr, rumorId, acked, rebroadcast);
      }
    },
  };
}

/**
 * Send one chat-plane rumor: insert optimistically, sign the seal (remote for
 * NIP-46), wrap under the CURRENT epoch key, broadcast fire-and-forget. A visible
 * rumor is tracked in `outgoing.ts` until a relay is seen to hold it.
 */
export function useSendMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel?.idHex ?? null;
  // CORD-08 timer at send time; an unlanded fold reads as OFF (the signed tag governs).
  const { data: folded } = useControlFold(community);
  const timerSecs = messageExpirationOf(folded?.metadata);

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
      expiration,
      bypassRateLimit,
    }: {
      content: string;
      /** 9 message (default), 7 reaction, 5 delete, 3302 edit, 1111 thread reply. */
      kind?: number;
      /**
       * Thread parent: makes this a NIP-22 kind-1111 comment ({@link buildConcordCommentTags}),
       * NOT a kind-9 `q` (reserved for NIP-C7 quote-replies).
       */
      replyTo?: { id: string; kind: number; pubkey: string; tags: string[][] };
      /** `e`-target for reactions / deletes / edits. */
      target?: string;
      /** Kind of the `e`-target for deletes (NIP-09 `k` tag); defaults to message. */
      targetKind?: number;
      /** NIP-25 `p` for reactions; on the encrypted rumor, so nothing leaks to relays. */
      targetPubkey?: string;
      /** Extra rumor tags appended verbatim (NIP-30 emoji, NIP-92 imeta, …). */
      extraTags?: string[][];
      /** Override the ms timestamp (edits keep the original's place). */
      ms?: number;
      /**
       * Override the NIP-40 deadline. A number pins it (edits keep the original's);
       * `null` pins none; `undefined` computes from the community timer.
       */
      expiration?: number | null;
      /** Skip the send budget (retries are recovery, not new content). */
      bypassRateLimit?: boolean;
    }) => {
      if (!user) throw new Error("Sign in to send a message.");
      if (!community || !channel) throw new Error("No channel selected.");
      // CORD-02 §9: gated at publish because `canWrite` is undefined on first tick. Local and sticky.
      if ((await dissolvedAt(community.idHex)) !== undefined) {
        throw new Error("This community has been dissolved; it accepts no new messages.");
      }

      const effectiveKind = replyTo ? KIND_COMMENT : kind;
      // Rate-limit before the optimistic insert/seal so a block leaves nothing to
      // reconcile; backstop for paths the composer doesn't check.
      if (!bypassRateLimit && isRateLimitedKind(effectiveKind)) {
        const waitMs = consumeSend(community.idHex);
        if (waitMs > 0) throw new SendRateLimitError(waitMs);
      }
      const effectiveMs = ms ?? Date.now();
      const tags: string[][] = [...channelBindingTags(channel.idHex, channel.current.epoch)];
      if (replyTo) tags.push(...buildConcordCommentTags(replyTo));
      if (target) tags.push(["e", target]);
      // NIP-25 `p` on the encrypted rumor, never the wrap.
      if (kind === KIND_REACTION && targetPubkey) tags.push(["p", targetPubkey]);
      if (kind === KIND_DELETE && target) tags.push(["k", String(targetKind ?? KIND_MESSAGE)]);
      if (extraTags) tags.push(...extraTags);
      // CORD-08 §2: durable chat rumors (not deletes/notices) sign a NIP-40
      // deadline; the wrap repeats it so relays purge ciphertext. Override wins.
      const expiresAt =
        expiration !== undefined ? (expiration ?? undefined) : chatExpiresAt(effectiveKind, effectiveMs, timerSecs);
      if (expiresAt !== undefined) tags.push(["expiration", String(expiresAt)]);

      const rumor: NostrRumor = buildRumor({ kind: effectiveKind, content, tags, pubkey: user.pubkey, ms: effectiveMs });
      // Render immediately, before the (possibly remote) seal; failures flip to "failed".
      const isVisible = effectiveKind === KIND_MESSAGE || effectiveKind === KIND_COMMENT || effectiveKind === KIND_POLL;
      const opened: OpenedChat = {
        rumorId: rumor.id,
        author: user.pubkey,
        kind: effectiveKind,
        content,
        tags,
        ms: effectiveMs,
        createdAt: rumor.created_at,
        // Placeholders until sealed; not persisted before then.
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
      const record: OutgoingRecord | undefined = isVisible
        ? {
            rumorId: rumor.id,
            viewer: user.pubkey,
            communityIdHex: community.idHex,
            channelIdHex: channel.idHex,
            kind: effectiveKind,
            content,
            tags,
            ms: effectiveMs,
            createdAt: rumor.created_at,
            epoch: String(channel.current.epoch),
            state: "signing",
            relays: community.relays,
            updatedAt: Date.now(),
          }
        : undefined;
      if (record) {
        // Only a local key answers inside the grace; a remote signer's send is written now.
        putOutgoing(record, true, { deferPersist: user.method === "nsec" });
        queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) => upsert(old, [opened]));
      }

      logSync("send", `sealing rumor ${rumor.id.slice(0, 8)} (kind ${effectiveKind}) — signer: ${user.method}`);
      const sealStarted = Date.now();
      let seal: NostrEvent;
      try {
        seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      } catch (err) {
        logSync("send", `sealing ${rumor.id.slice(0, 8)} FAILED in ${sinceMs(sealStarted)}: ${err instanceof Error ? err.message : String(err)}`);
        if (record) {
          failOutgoing(rumor.id);
          return { rumorId: rumor.id, wrap: undefined };
        }
        throw err; // reactions/edits/deletes: callers own the rollback
      }
      logSync("send", `sealed ${rumor.id.slice(0, 8)} in ${sinceMs(sealStarted)} — wrapping + broadcasting to ${community.relays.length} relay(s)`);
      const wrap = wrapSeal(seal, channel.current.group, expiresAt !== undefined ? { expiration: expiresAt } : undefined);

      // The wrap is authored by the stream key, so mark it ours before its push arrives.
      await markOwnWebPushEvent(wrap.id);

      const sealed: OpenedChat = { ...opened, seal, wrapId: wrap.id, streamPk: wrap.pubkey };
      if (record) putOutgoing({ ...record, state: "sending", wrap });
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) => replaceRow(old, sealed));
      // Persist so a mid-flight refresh keeps it (and self-deletes apply via NIP-09).
      writeRumors(community.idHex, [sealed], { local: true });

      if (record) {
        const tracked = outgoingBroadcast(nostr, rumor.id, user.method);
        broadcastWrap(nostr, community.relays, wrap, user.method, tracked.onStatus, tracked);
      } else {
        broadcastWrap(nostr, community.relays, wrap, user.method, () => undefined);
      }

      return { rumorId: rumor.id, wrap: wrap as NostrEvent | undefined };
    },
  });
}

export function useMessageActions(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  // Own Grant head, which a moderation delete cites (CORD-04 §5).
  const { data: folded } = useControlFold(community);
  const channelIdHex = channel?.idHex ?? null;
  const { mutateAsync: send } = useSendMessage(community, channel);

  // Re-broadcast under the SAME rumor id so a slow-ACKed original dedupes:
  // the recorded wrap verbatim when sealed, else re-seal (`buildRumor`
  // reproduces the id from the ms-less tags). Visible kinds only.
  const resend = useCallback(
    (msg: OpenedChat) => {
      if (!user || !community || !channel) return;
      const prior = getOutgoing(msg.rumorId);
      const record: OutgoingRecord = prior ?? {
        rumorId: msg.rumorId,
        viewer: user.pubkey,
        communityIdHex: community.idHex,
        channelIdHex: channel.idHex,
        kind: msg.kind,
        content: msg.content,
        tags: withoutMsTag(msg.tags),
        ms: msg.ms,
        createdAt: msg.createdAt,
        epoch: String(msg.epoch),
        state: "failed",
        relays: community.relays,
        updatedAt: Date.now(),
      };
      void (async () => {
        try {
          let wrap = record.wrap;
          if (!wrap) {
            let seal = msg.seal && msg.seal.sig ? msg.seal : undefined;
            if (!seal) {
              putOutgoing({ ...record, state: "signing" }, true, { deferPersist: user.method === "nsec" });
              const rumor = buildRumor({
                kind: record.kind,
                content: record.content,
                tags: record.tags,
                pubkey: user.pubkey,
                ms: record.ms,
              });
              seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
            }
            // Mirror the rumor's NIP-40 onto the re-wrap (CORD-08 §2).
            const expTag = record.tags.find((t) => t[0] === "expiration")?.[1];
            const expiration = expTag !== undefined && /^[0-9]+$/.test(expTag) ? Number(expTag) : undefined;
            wrap = wrapSeal(seal, channel.current.group, expiration !== undefined ? { expiration } : undefined);
            await markOwnWebPushEvent(wrap.id);
            // Persist so a mid-flight refresh keeps it.
            writeRumors(community.idHex, [{ ...msg, seal, wrapId: wrap.id, streamPk: wrap.pubkey }], { local: true });
            queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old) =>
              replaceRow(old, { ...msg, seal, wrapId: wrap!.id, streamPk: wrap!.pubkey }),
            );
          }
          // A manual retry starts the read-back over.
          putOutgoing({ ...record, state: "sending", wrap, verifyAt: undefined, acked: undefined, verifyAttempts: 0 });
          const tracked = outgoingBroadcast(nostr, record.rumorId, user.method);
          broadcastWrap(nostr, community.relays, wrap, user.method, tracked.onStatus, tracked);
        } catch {
          failOutgoing(record.rumorId);
        }
      })();
    },
    [nostr, user, community, channel, channelIdHex, queryClient],
  );

  /** The row to act on: the cached one, else the record (an unsealed send restored after a reload). */
  const rowFor = useCallback(
    (id: string): OpenedChat | undefined => {
      const cached = (queryClient.getQueryData<OpenedChat[]>(channelKey(channelIdHex)) ?? []).find((m) => m.rumorId === id);
      if (cached) return cached;
      const rec = getOutgoing(id);
      return rec && rec.channelIdHex === channelIdHex ? recordToRow(rec) : undefined;
    },
    [queryClient, channelIdHex],
  );

  const retry = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const msg = rowFor(id);
      if (!msg) return;
      // `broadcastWrap` re-asserts "failed" only if this attempt finds no relay too.
      if (msg.epoch === channel.current.epoch) {
        resend(msg);
        return;
      }
      // The epoch rotated, retiring the id's binding: re-send as a fresh rumor.
      // Comments keep their NIP-22 thread tags (minus the channel binding `send` re-adds).
      const isComment = msg.kind === KIND_COMMENT;
      // Strip `expiration` and `ms` too; the re-send computes fresh ones.
      const threadTags = isComment
        ? msg.tags.filter(([n]) => n !== "channel" && n !== "epoch" && n !== "expiration" && n !== "ms")
        : undefined;
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.rumorId !== id),
      );
      discardOutgoing(id);
      void removeRumors(community.idHex, [id]).catch(() => undefined);
      void send({
        content: msg.content,
        kind: msg.kind,
        extraTags: threadTags,
        // A failed burst must not exhaust the budget for retrying it.
        bypassRateLimit: true,
      }).catch(() => undefined);
    },
    [user, community, channel, channelIdHex, queryClient, send, resend, rowFor],
  );

  // Gone from the screen, the record and the store: it never reached a relay,
  // so a stored copy would come back after a reload looking sent.
  const discard = useCallback(
    (id: string) => {
      queryClient.setQueryData<OpenedChat[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.rumorId !== id),
      );
      discardOutgoing(id);
      if (community) void removeRumors(community.idHex, [id]).catch(() => undefined);
    },
    [queryClient, channelIdHex, community],
  );

  const deleteMessage = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      // Deleting someone else's message cites the Grant (CORD-04 §5) so stale
      // peers can verify; self-deletes never cite.
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
        // Couldn't publish; unhide.
        queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) => old.filter((d) => d !== id));
      });
    },
    [user, community, channel, channelIdHex, queryClient, send, folded],
  );

  return { retry, discard, deleteMessage };
}

/** Send status by rumor id for one channel, from the persisted outgoing records. */
export function useSendStatus(channel: Channel | undefined): SendStatusMap {
  const { user } = useCurrentUser();
  const viewer = user?.pubkey;
  const channelIdHex = channel?.idHex ?? null;
  return useSyncExternalStore(subscribeOutgoing, () => outgoingStatusMap(viewer, channelIdHex));
}
