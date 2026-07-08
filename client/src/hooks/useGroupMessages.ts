import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { useSendStatusMap } from "@/hooks/useSendStatusMap";
import { useTimelineSnapshotWriter } from "@/hooks/useTimelineSnapshot";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { nip29SnapshotScope, readTimelineSnapshot } from "@/lib/timelineSnapshot";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind — polls posted to the group render in the timeline. */
const KIND_POLL = 1068;
/** NIP-09 deletion kind. */
const KIND_DELETE = 5;

/** Event kinds shown in the group timeline. */
const TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];

/** How many messages to fetch per page (initial load and each backfill). */
const PAGE_SIZE = 30;

/**
 * Minimum interval between relay top-up pulls for one room. The wire delivers
 * new messages to the store live; this pull exists to fetch history the wire's
 * `since` window never covered (first visit, deep offline gaps) and to heal a
 * dead wire socket — it must NOT fire on every store-change invalidation.
 */
const PULL_MIN_INTERVAL_MS = 30_000;

/**
 * Largest gap (seconds) between the cursor message and the next-oldest before
 * we treat it as a stale-relay outlier and don't trust it as a cursor. Mirrors
 * Ditto's `getPaginationCursor` gap guard. 6 hours.
 */
const MAX_GAP_SECONDS = 6 * 60 * 60;

// Optimistic send-status types/storage are shared with Concord; re-exported
// here so existing importers (transport.ts) keep their path.
export type { SendStatus, SendStatusMap } from "@/hooks/useSendStatusMap";

function messagesKey(relayUrl: string | undefined, groupId: string | undefined) {
  return ["nip29", "messages", relayUrl, groupId] as const;
}

function statusKey(relayUrl: string | undefined, groupId: string | undefined) {
  return ["nip29", "msg-status", relayUrl, groupId] as const;
}

/** Sort ascending (oldest-first) and de-duplicate a message list by id. */
function sortDedupe(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Pick a safe `until` cursor for backfilling older messages from a page of
 * events. Returns the oldest event's `created_at - 1`, unless the oldest event
 * is separated from the rest of the page by a suspiciously large time gap (a
 * stale relay returning an ancient straggler) — in which case we step in to the
 * second-oldest so the cursor doesn't leap past real history. Mirrors Ditto's
 * gap-aware cursor.
 */
function paginationCursor(events: NostrEvent[]): number | undefined {
  if (events.length === 0) return undefined;
  const ascending = [...events].sort((a, b) => a.created_at - b.created_at);
  const oldest = ascending[0].created_at;
  const next = ascending[1]?.created_at;
  if (next !== undefined && next - oldest > MAX_GAP_SECONDS) {
    return next - 1;
  }
  return oldest - 1;
}

/**
 * Chat messages (kind 9) and polls (kind 1068) for a NIP-29 group, hydrated
 * from the shared IndexedDB event store.
 *
 * This hook holds NO sockets. The wire (WireSync) owns the standing per-relay
 * subscription and funnels every incoming event into the store; the wire bus
 * then announces `nip29:<groupId>` and this hook re-reads. The only network
 * this hook performs is PULLS: a throttled newest-page top-up (first visit /
 * deep gaps / dead-socket healing) and explicit scroll-up pagination — both of
 * which are mirrored into the store by the relay pool's caching layer.
 *
 * Supports optimistic publishing: locally-signed messages are inserted
 * immediately with a `pending` status. Because we sign locally, the optimistic
 * event shares its id with the relay echo (which arrives via the wire), so
 * de-duplication is automatic.
 */
export function useGroupMessages(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  // Backfill state. `cursor` is the next `until` to request; `hasMore` is false
  // once a page comes back short (the relay has no older history left).
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);
  const lastPullRef = useRef(0);
  // Whether this room's first store read has settled. Until it has, an empty
  // read reads as LOADING (skeleton), not an authoritative "no messages yet".
  // Keyed off the local READ (always runs in the queryFn), not the throttled
  // network pull (which can be skipped, deadlocking the skeleton).
  const [firstLoadDone, setFirstLoadDone] = useState(false);

  // Which relay the currently-rendered `query.data` belongs to. Used by
  // `placeholderData` below to decide whether the previous room's messages are
  // safe to keep painted during a switch: same server → yes (no skeleton
  // flash); different community → no (blank rather than show another
  // community's timeline).
  const dataRelayRef = useRef<string | undefined>(relayUrl);

  // Last-known-good localStorage snapshot scope for this room: a pure READ
  // CACHE for the first frame of a cold launch (Android IndexedDB cold-opens
  // in seconds). Never an ingestion source — the store remains authoritative.
  const snapshotScope = relayUrl && groupId ? nip29SnapshotScope(relayUrl, groupId) : undefined;

  useEffect(() => {
    lastPullRef.current = 0;
    setHasMore(true);
    cursorRef.current = undefined;
    setFirstLoadDone(false);
  }, [relayUrl, groupId]);

  const query = useQuery<NostrEvent[]>({
    queryKey: messagesKey(relayUrl, groupId),
    queryFn: async ({ signal }) => {
      const store = await eventStore;

      // Anything already painted (older pagination pages, optimistic sends).
      // A queryFn return is an authoritative overwrite, so fold it in.
      const existing = queryClient.getQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId)) ?? [];

      // The store is the source of truth: the wire writes every incoming
      // event here before the bus asks us to re-read.
      const cached = await store.query([
        { kinds: TIMELINE_KINDS, "#h": [groupId!], limit: Math.max(PAGE_SIZE, existing.length) },
      ]);

      // Deletions: the store self-applies NIP-09 for same-author deletes, but
      // NIP-29 moderators delete others' messages — hide anything referenced
      // by a kind-5 in this group.
      const deletes = await store.query([{ kinds: [KIND_DELETE], "#h": [groupId!], limit: 200 }]);
      const deletedIds = new Set(
        deletes.flatMap((d) => d.tags.filter(([n, v]) => n === "e" && v).map(([, v]) => v)),
      );

      const local = sortDedupe([...existing, ...cached]).filter((e) => !deletedIds.has(e.id));

      // Throttled background top-up: the newest relay page, for history the
      // wire's since-window never covered. NOT awaited (never gates paint);
      // the pool mirrors results into the store; merged append-only here.
      // `firstLoadDone` (the loading-skeleton gate) flips when this pull settles
      // — or immediately if it's throttled-skipped (a recent pull already ran).
      const now = Date.now();
      if (now - lastPullRef.current >= PULL_MIN_INTERVAL_MS) {
        lastPullRef.current = now;
        void (async () => {
          if (signal.aborted) return;
          try {
            const events = await nostr.relay(relayUrl!).query(
              [{ kinds: TIMELINE_KINDS, "#h": [groupId!], limit: PAGE_SIZE }],
              { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
            );
            setHasMore(events.length >= PAGE_SIZE);
            const cursor = paginationCursor(events);
            if (cursor !== undefined && (cursorRef.current === undefined || cursor < cursorRef.current)) {
              cursorRef.current = cursor;
            }
            if (signal.aborted || events.length === 0) return;
            queryClient.setQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId), (old = []) =>
              sortDedupe([...old, ...events]).filter((e) => !deletedIds.has(e.id)),
            );
          } catch {
            // Best-effort; the store-hydrated result already rendered.
          } finally {
            if (!signal.aborted) setFirstLoadDone(true);
          }
        })();
      } else if (!signal.aborted) {
        // Pull throttled-skipped: a recent pull already settled, so an empty
        // timeline is authoritative now (don't hang on the skeleton).
        setFirstLoadDone(true);
      }

      // Seed the cursor from local history so scroll-up backfill works even
      // before any network pull lands.
      if (cursorRef.current === undefined && local.length > 0) {
        cursorRef.current = paginationCursor(local);
      }
      // If the store already had messages, loading is done immediately. If it
      // was empty, the pull's `finally` (above) flips the gate once it settles —
      // an empty store read isn't authoritative, since NIP-29 history arrives
      // via this pull, not the wire's live `since` window.
      if (local.length > 0 && !signal.aborted) setFirstLoadDone(true);
      return local;
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 10_000,
    // Seed with the last visit's screenful from the synchronous localStorage
    // snapshot, so a cold launch paints the room instantly instead of behind
    // the IndexedDB cold-open skeleton. `initialDataUpdatedAt: 0` marks the
    // seed already-stale so the store-hydrating queryFn still runs immediately
    // and merges on top (append-only, so the seed can never mask fresher data).
    initialData: () => {
      const snap = readTimelineSnapshot<NostrEvent>(snapshotScope);
      // Only seed events that belong to THIS group (every timeline event
      // carries its `h` tag).
      const own = snap?.filter((e) => e.tags.some(([t, v]) => t === "h" && v === groupId));
      return own && own.length > 0 ? own : undefined;
    },
    initialDataUpdatedAt: 0,
    // Healing backstops: the wire owns liveness, but a half-dead socket (one
    // the OS severed while backgrounded) stalls silently — a periodic re-read
    // (whose throttled pull tops up from the relay) and a refetch on
    // focus/reconnect close that gap.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Keep showing the previous channel's messages while the next loads, so
    // switching channels within the SAME community never flashes the skeleton.
    // Switching to a DIFFERENT community drops the unrelated timeline instead.
    placeholderData: (prev) => (dataRelayRef.current === relayUrl ? prev : undefined),
  });

  // Track which relay the data now on screen belongs to, for the next switch's
  // `placeholderData` decision. Runs after render commits `query.data`.
  useEffect(() => {
    dataRelayRef.current = relayUrl;
  }, [relayUrl, query.data]);

  // Wire hydration: when this group's store changes, re-read it. (The queryFn
  // is a cheap local read; its relay pull is independently throttled.)
  useWireScopes((scopes) => {
    if (groupId && scopes.has(`nip29:${groupId}`)) {
      void queryClient.invalidateQueries({ queryKey: messagesKey(relayUrl, groupId) });
    }
  });

  // Send-status for optimistic messages (kept in its own cache entry, shared
  // with Concord via useSendStatusMap).
  const { status, setStatus } = useSendStatusMap(statusKey(relayUrl, groupId));

  // Keep the localStorage snapshot fresh with the rendered timeline (debounced).
  useTimelineSnapshotWriter(snapshotScope, query.data, !query.isPlaceholderData);

  const upsertMessage = useCallback(
    (event: NostrEvent) => {
      queryClient.setQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId), (old = []) => {
        if (old.some((e) => e.id === event.id)) return old;
        return sortDedupe([...old, event]);
      });
    },
    [queryClient, relayUrl, groupId],
  );

  /**
   * Fetch the next older page of history (scroll-up pagination). Resolves to
   * the number of messages prepended (0 when there's nothing older), so the
   * caller can preserve scroll position around the inserted rows.
   */
  const loadOlder = useCallback(async (): Promise<number> => {
    if (!relayUrl || !groupId) return 0;
    if (loadingRef.current || !hasMore) return 0;
    const until = cursorRef.current;
    if (until === undefined) return 0;

    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      const older = await nostr.relay(relayUrl).query(
        [{ kinds: TIMELINE_KINDS, "#h": [groupId], until, limit: PAGE_SIZE }],
        { signal: AbortSignal.timeout(8000) },
      );

      // Anything genuinely new to us (the cursor boundary can re-return events).
      const existing = queryClient.getQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId)) ?? [];
      const existingIds = new Set(existing.map((e) => e.id));
      const fresh = older.filter((e) => !existingIds.has(e.id));

      if (older.length < PAGE_SIZE) setHasMore(false);
      // Advance the cursor from the raw page (pre-dedupe) so a page that's all
      // boundary-overlap still moves us backwards in time.
      cursorRef.current = paginationCursor(older) ?? until - 1;

      if (fresh.length === 0) return 0;

      queryClient.setQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId), (old = []) =>
        sortDedupe([...fresh, ...old]),
      );
      return fresh.length;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [nostr, relayUrl, groupId, hasMore, queryClient]);

  /** Insert a locally-signed message immediately with `pending` status. */
  const insertOptimistic = useCallback(
    (event: NostrEvent) => {
      upsertMessage(event);
      setStatus(event.id, "pending");
    },
    [upsertMessage, setStatus],
  );

  /** Confirm a message delivered (clears its pending/failed status). */
  const markSent = useCallback((id: string) => setStatus(id, undefined), [setStatus]);

  /** Mark a message as failed to send (offers retry in the UI). */
  const markFailed = useCallback((id: string) => setStatus(id, "failed"), [setStatus]);

  /** Remove an optimistic message entirely (e.g. discard a failed send). */
  const removeOptimistic = useCallback(
    (id: string) => {
      queryClient.setQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId), (old = []) =>
        old.filter((e) => e.id !== id),
      );
      setStatus(id, undefined);
    },
    [queryClient, relayUrl, groupId, setStatus],
  );

  const helpers = useMemo(
    () => ({
      status,
      insertOptimistic,
      markSent,
      markFailed,
      removeOptimistic,
      loadOlder,
      hasMore,
      isLoadingOlder,
    }),
    [status, insertOptimistic, markSent, markFailed, removeOptimistic, loadOlder, hasMore, isLoadingOlder],
  );

  // Effective loading: the react-query load, OR a first cold visit where the
  // store hydrated empty and the first network top-up hasn't settled yet. This
  // keeps the timeline on its skeleton (not the "no messages yet" empty state)
  // until we've actually heard back from the relay — the wire may not have
  // ingested this room's history yet on a fresh app start.
  // Loading skeleton gate — see useConcordChannel for the full rationale. Hold
  // the skeleton while empty AND a load is genuinely in progress; never force
  // it while the query is idle-and-never-fetched.
  const isLoading =
    query.isLoading ||
    ((query.data?.length ?? 0) === 0 && (query.isFetching || query.isFetched) && !firstLoadDone);

  return { ...query, ...helpers, isLoading };
}
