import { useNostr } from "@nostrify/react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { useSendStatusMap } from "@/hooks/useSendStatusMap";
import { useTimelineSnapshotWriter } from "@/hooks/useTimelineSnapshot";
import {
  NIP29_PAGE_SIZE,
  NIP29_TIMELINE_KINDS,
  nip29PullFull,
  nip29SyncTopic,
  setNip29SyncContext,
} from "@/lib/nip29Sync";
import { isSigned } from "@/lib/nostrRumor";
import { STORE_READ } from "@/lib/storeQuery";
import { nip29SnapshotScope, readTimelineSnapshot } from "@/lib/timelineSnapshot";
import { useSyncTopic } from "@/sync/useSyncTopic";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-09 deletion kind. */
const KIND_DELETE = 5;

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

/** Exact route targets read independently of the newest room window. */
export interface GroupMessageFocus {
  messageId?: string;
  threadRoot?: string;
}

/**
 * Sort ascending (oldest-first) and de-duplicate a message list by id.
 *
 * Later entries win, with one exception: a signed copy is never replaced by an
 * unsigned one. The local store drops `sig` (see `mainEventStore.ts`), and the
 * store copy is merged last, so without this the store's copy of an event we
 * just signed ourselves would overwrite the only republishable copy we hold —
 * and retrying a failed send would publish an empty signature.
 */
function sortDedupe(events: NostrRumor[]): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
  for (const e of events) {
    const prev = byId.get(e.id);
    if (prev && isSigned(prev) && !isSigned(e)) continue;
    byId.set(e.id, e);
  }
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
function paginationCursor(events: NostrRumor[]): number | undefined {
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
 * then announces `nip29:<groupId>` and this hook re-reads. The newest-page
 * top-up (first visit / deep gaps / dead-socket healing) is the sync
 * scheduler's `nip29:` topic (see `nip29Sync.ts`), wanted for the life of
 * this view; the only network the hook itself performs is explicit scroll-up
 * pagination, mirrored into the store by the relay pool's caching layer.
 *
 * Supports optimistic publishing: locally-signed messages are inserted
 * immediately with a `pending` status. Because we sign locally, the optimistic
 * event shares its id with the relay echo (which arrives via the wire), so
 * de-duplication is automatic.
 */
export function useGroupMessages(
  relayUrl: string | undefined,
  groupId: string | undefined,
  focus?: GroupMessageFocus,
) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const focusIds = useMemo(
    () => [...new Set([focus?.threadRoot, focus?.messageId].filter((id): id is string => Boolean(id)))],
    [focus?.threadRoot, focus?.messageId],
  );
  const focusSig = focusIds.join(",");

  // Backfill state. `cursor` is the next `until` to request; `hasMore` is false
  // once a page comes back short (the relay has no older history left).
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);

  // Last-known-good localStorage snapshot scope for this room: a pure READ
  // CACHE for the first frame of a cold launch (Android IndexedDB cold-opens
  // in seconds). Never an ingestion source — the store remains authoritative.
  const snapshotScope = relayUrl && groupId ? nip29SnapshotScope(relayUrl, groupId) : undefined;

  useEffect(() => {
    setHasMore(true);
    cursorRef.current = undefined;
  }, [relayUrl, groupId]);

  // The newest-page top-up (first visit, offline gaps, dead-socket healing)
  // is owned by the sync scheduler: this view registers the pool handle a
  // `nip29:` round needs, then declares standing interest in the topic. The
  // relay is part of the topic key — a group id means nothing without its
  // relay — and freshness is a durable stamp, so a room revisited inside the
  // fresh window is a pure store read. The context effect is declared BEFORE
  // the want, so a round never starts without it.
  const syncTopic = relayUrl && groupId ? nip29SyncTopic(relayUrl, groupId) : undefined;
  useEffect(() => {
    if (!syncTopic) return;
    return setNip29SyncContext(syncTopic, { nostr });
  }, [syncTopic, nostr]);
  const sync = useSyncTopic(syncTopic);

  const query = useQuery<NostrRumor[]>({
    // A pure store read now (see below): no offline pausing, no retry ladder
    // held at `isPending` — this query's loading state is a skeleton gate.
    ...STORE_READ,
    queryKey: messagesKey(relayUrl, groupId),
    queryFn: async ({ signal }) => {
      const store = await eventStore;

      // Anything already painted (older pagination pages, optimistic sends).
      // A queryFn return is an authoritative overwrite, so fold it in.
      const existing = queryClient.getQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId)) ?? [];

      // The store is the source of truth: the wire writes every incoming
      // event here before the bus asks us to re-read. Read the timeline and
      // the group's deletions in parallel so the local paint isn't gated on
      // two sequential IndexedDB round-trips.
      // Scoped to THIS relay: a group id is only meaningful on the relay that
      // hosts it, and the same id on another server is an unrelated channel, so
      // the read is aimed at that relay's tenant rather than a shared cache.
      const [cached, deletes] = await Promise.all([
        store.query(
          [{ kinds: NIP29_TIMELINE_KINDS, "#h": [groupId!], limit: Math.max(NIP29_PAGE_SIZE, existing.length) }],
          { relay: relayUrl },
        ),
        // Deletions: the store self-applies NIP-09 for same-author deletes, but
        // NIP-29 moderators delete others' messages — hide anything referenced
        // by a kind-5 in this group.
        store.query([{ kinds: [KIND_DELETE], "#h": [groupId!], limit: 200 }], { relay: relayUrl }),
      ]);
      const deletedIds = new Set(
        deletes.flatMap((d) => d.tags.filter(([n, v]) => n === "e" && v).map(([, v]) => v)),
      );

      const local = sortDedupe([...existing, ...cached]).filter((e) => !deletedIds.has(e.id));

      // No network here: the scheduler owns the newest-page pull (the topic
      // wanted above); its round mirrors results into the store and rings the
      // bus back into this queryFn. `hasMore` reflects the last round's page
      // fullness; a `loadOlder` probe refines it.
      const full = syncTopic ? nip29PullFull(syncTopic) : undefined;
      if (full !== undefined && !signal.aborted) setHasMore(full);

      // Seed the cursor from local history so scroll-up backfill works even
      // before any network pull lands. (The scheduler's pull is the NEWEST
      // page, so once its rows are in this read, the local oldest is at least
      // as deep a cursor as the pull could have offered.)
      if (cursorRef.current === undefined && local.length > 0) {
        cursorRef.current = paginationCursor(local);
      }
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
      const snap = readTimelineSnapshot<NostrRumor>(snapshotScope);
      // Only seed events that belong to THIS group (every timeline event
      // carries its `h` tag).
      const own = snap?.filter((e) => e.tags.some(([t, v]) => t === "h" && v === groupId));
      return own && own.length > 0 ? own : undefined;
    },
    initialDataUpdatedAt: 0,
    // No refetch timer or focus/reconnect backstops here: the scheduler
    // re-runs the topic's pull on its staleness interval and on focus/online
    // nudges while this view holds its want, and every round rings the bus
    // back into this query — dead-socket healing included.
    // Keep the previous render's messages painted ONLY when they belong to
    // THIS room (the previous query has the same key — e.g. a remount after
    // cache eviction), so a same-room reload never flashes the skeleton. A
    // channel switch means the previous query is a DIFFERENT room, so its
    // messages are dropped — the new channel paints from its own synchronous
    // snapshot (`initialData`) or a skeleton, never the outgoing channel's
    // timeline. Decided from the previous query's own key (race-free), NOT a
    // ref updated by an effect: this inline closure defeats TanStack's
    // placeholder memoization, so it re-runs on EVERY render while the new
    // room's first read is pending, and a ref would already point at the new
    // room by the second render.
    placeholderData: (prev, prevQuery) =>
      prevQuery && hashKey(prevQuery.queryKey) === hashKey(messagesKey(relayUrl, groupId))
        ? prev
        : undefined,
  });

  // Global message search can find a locally-persisted row far behind the
  // newest page. Resolve the route's exact ids from that same relay tenant so
  // the permalink does not need a network walk (and works offline). Keep this
  // result outside the ordinary query cache: a lone old hit must not drag its
  // pagination cursor across the unloaded gap.
  const focusQuery = useQuery<NostrRumor[]>({
    ...STORE_READ,
    queryKey: ["nip29", "message-focus", relayUrl, groupId, focusSig],
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      return store.query(
        [{ ids: focusIds, kinds: NIP29_TIMELINE_KINDS, "#h": [groupId!], limit: focusIds.length }],
        { relay: relayUrl, signal },
      );
    },
    enabled: Boolean(relayUrl && groupId && focusIds.length > 0),
    staleTime: Infinity,
  });

  const focusedData = useMemo(
    () => sortDedupe([...(query.data ?? []), ...(focusQuery.data ?? [])]),
    [query.data, focusQuery.data],
  );

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
      queryClient.setQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId), (old = []) => {
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
        [{ kinds: NIP29_TIMELINE_KINDS, "#h": [groupId], until, limit: NIP29_PAGE_SIZE }],
        { signal: AbortSignal.timeout(8000) },
      );

      // Anything genuinely new to us (the cursor boundary can re-return events).
      const existing = queryClient.getQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId)) ?? [];
      const existingIds = new Set(existing.map((e) => e.id));
      const fresh = older.filter((e) => !existingIds.has(e.id));

      if (older.length < NIP29_PAGE_SIZE) setHasMore(false);
      // Advance the cursor from the raw page (pre-dedupe) so a page that's all
      // boundary-overlap still moves us backwards in time.
      cursorRef.current = paginationCursor(older) ?? until - 1;

      if (fresh.length === 0) return 0;

      queryClient.setQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId), (old = []) =>
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
      queryClient.setQueryData<NostrRumor[]>(messagesKey(relayUrl, groupId), (old = []) =>
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

  // Loading skeleton gate: the local store read, plus the sync topic on a
  // cold first visit — an empty store is NOT authoritative for NIP-29 until
  // the scheduler's newest-page pull settles (history arrives via that pull,
  // not the wire's live `since` window). `pending` covers the whole span from
  // this view declaring interest to the round settling; a settled, errored,
  // or fresh-stamped topic releases the gate, so an empty room shows its
  // empty state instead of a skeleton forever.
  const isLoading =
    query.isLoading ||
    (focusIds.length > 0 && focusQuery.isLoading) ||
    ((query.data?.length ?? 0) === 0 && sync.status === "pending");

  return { ...query, ...helpers, data: focusedData, isLoading };
}
