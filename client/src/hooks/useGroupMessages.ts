import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { KIND_GROUP_CHAT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind — polls posted to the group render in the timeline. */
const KIND_POLL = 1068;
/** NIP-09 deletion kind. */
const KIND_DELETE = 5;

/** Event kinds shown in the group timeline. */
const TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];
/** Kinds the live subscription watches (timeline + deletions). */
const LIVE_KINDS = [KIND_GROUP_CHAT, KIND_POLL, KIND_DELETE];

/** How many messages to fetch per page (initial load and each backfill). */
const PAGE_SIZE = 30;

/**
 * How far back the live subscription's `since` reaches on mount. A few seconds
 * isn't enough: a message that already exists when the group opens (e.g. one
 * that arrived via an Android push and is several seconds/minutes old by the
 * time the user taps it) would fall outside a tiny window and never be replayed
 * by the live `req`. A wider lookback replays it; `sortDedupe` removes overlap
 * with the initial page so there are no duplicates.
 */
const LIVE_SINCE_LOOKBACK_SECONDS = 5 * 60;

/**
 * Largest gap (seconds) between the cursor message and the next-oldest before
 * we treat it as a stale-relay outlier and don't trust it as a cursor. Mirrors
 * Ditto's `getPaginationCursor` gap guard. 6 hours.
 */
const MAX_GAP_SECONDS = 6 * 60 * 60;

/** Delivery status of an optimistically-inserted (locally-published) message. */
export type SendStatus = "pending" | "failed";

/** Map of event id → send status, for optimistic/unconfirmed messages. */
export type SendStatusMap = Record<string, SendStatus>;

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
 * Chat messages (kind 9) and polls (kind 1068) for a NIP-29 group, with a
 * live subscription that appends incoming messages into the query cache and
 * scroll-up pagination that backfills older history on demand.
 *
 * The full timeline lives in a single TanStack cache entry (oldest-first).
 * - Initial load fetches the newest {@link PAGE_SIZE} messages.
 * - {@link loadOlder} fetches the next older page using an `until` cursor
 *   (Ditto's `useInfiniteQuery` pattern, flattened into one growing list since
 *   chat is bottom-anchored rather than top-anchored).
 * - The live `req` appends new messages as they arrive.
 *
 * Supports optimistic publishing: locally-signed messages can be inserted
 * immediately with a `pending` status (and later reconciled to confirmed when
 * the relay echoes the event back, or marked `failed` for retry). Because we
 * sign locally, the optimistic event shares its final id with the relay echo,
 * so de-duplication is automatic.
 *
 * Ported from Ditto's LiveStreamChat + useInfiniteQuery patterns, targeted at
 * the group's host relay only.
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

  const query = useQuery<NostrEvent[]>({
    queryKey: messagesKey(relayUrl, groupId),
    queryFn: async ({ signal }) => {
      const store = await eventStore;

      // Whatever is already in the cache (the live subscription merges new
      // messages in via `upsertMessage`, and prior fetches/backfills accumulate
      // here). We MUST fold this into our return value: a `queryFn` return is an
      // authoritative overwrite of the cache, so returning a bare local snapshot
      // would DROP any event the subscription delivered before it had been
      // mirrored into IndexedDB. Re-runs of this queryFn (cheap `staleTime` +
      // prop/`enabled` churn during initial load) made that the common case —
      // the "new message fetched but not shown until you re-focus the group" bug.
      const existing = queryClient.getQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId)) ?? [];

      // 1. LOCAL-FIRST: resolve from the append-only IndexedDB store immediately
      //    so `isLoading` reflects only the (fast) local read, never the relay
      //    round-trip. A refresh / channel switch paints the cached timeline at
      //    once instead of behind the skeleton. NostrBatcher mirrors every
      //    `#h`-scoped event the relay returns into this store, so it holds the
      //    group's history after the first visit. Merge with `existing` so a
      //    re-run never clobbers subscription-delivered messages.
      const cached = await store.query([
        { kinds: TIMELINE_KINDS, "#h": [groupId!], limit: PAGE_SIZE },
      ]);
      const local = sortDedupe([...existing, ...cached]);

      // 2. BACKGROUND refresh: fetch the newest page from the relay, mirror it
      //    into the store, and merge into the cache. NOT awaited — the network
      //    never gates the visible timeline. The merge is append-only (functional
      //    updater) so it can't drop live-subscription events either.
      void (async () => {
        if (signal.aborted) return;
        try {
          const events = await nostr.relay(relayUrl!).query(
            [{ kinds: TIMELINE_KINDS, "#h": [groupId!], limit: PAGE_SIZE }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
          );
          // A short first page means there's nothing older to backfill.
          setHasMore(events.length >= PAGE_SIZE);
          cursorRef.current = paginationCursor(events);
          if (signal.aborted || events.length === 0) return;
          queryClient.setQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId), (old = []) =>
            sortDedupe([...old, ...events]),
          );
        } catch {
          // Best-effort background refresh; the local-first result already rendered.
        }
      })();

      // Seed the cursor from local history too, so scroll-up backfill works even
      // before the network refresh lands.
      if (cursorRef.current === undefined && local.length > 0) {
        cursorRef.current = paginationCursor(local);
      }
      return local;
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 10_000,
    // Keep showing the previous channel's messages while the next loads, so
    // switching channels never flashes the skeleton (cache-first feel).
    placeholderData: (prev) => prev,
  });

  // Send-status for optimistic messages (kept in its own cache entry).
  const { data: status = {} } = useQuery<SendStatusMap>({
    queryKey: statusKey(relayUrl, groupId),
    queryFn: () => ({}),
    enabled: Boolean(relayUrl && groupId),
    staleTime: Infinity,
    gcTime: Infinity,
  });

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

  const setStatus = useCallback(
    (id: string, value: SendStatus | undefined) => {
      queryClient.setQueryData<SendStatusMap>(statusKey(relayUrl, groupId), (old = {}) => {
        if (value === undefined) {
          if (!(id in old)) return old;
          const next = { ...old };
          delete next[id];
          return next;
        }
        if (old[id] === value) return old;
        return { ...old, [id]: value };
      });
    },
    [queryClient, relayUrl, groupId],
  );

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

  // Live subscription for new messages. A relay echo of our own optimistic
  // event arrives here and clears its pending status (same id).
  useEffect(() => {
    if (!relayUrl || !groupId) return;
    const controller = new AbortController();

    (async () => {
      try {
        // `since` reaches back a generous window (not just a few seconds) so a
        // message that already exists when we open the group — e.g. the one that
        // triggered an Android notification, received natively and therefore NOT
        // in the WebView's IndexedDB nor the live stream's future — is still
        // replayed by this `req` and merged into the timeline. `sortDedupe`
        // collapses any overlap with the initial background page, so the wider
        // window is free of duplicates.
        const since = Math.floor(Date.now() / 1000) - LIVE_SINCE_LOOKBACK_SECONDS;
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: LIVE_KINDS, "#h": [groupId], since }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            if (event.kind === KIND_DELETE) {
              // NIP-09: drop any referenced messages from the timeline. The
              // relay already removed them from its store; this updates the
              // live cache (e.g. another client edited/deleted a message).
              for (const [name, id] of event.tags) {
                if (name === "e" && id) removeOptimistic(id);
              }
              continue;
            }
            upsertMessage(event);
            setStatus(event.id, undefined);
          }
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    return () => controller.abort();
  }, [nostr, relayUrl, groupId, upsertMessage, setStatus, removeOptimistic]);

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

  return { ...query, ...helpers };
}
