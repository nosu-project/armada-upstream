import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useDmRelaysFor } from "@/hooks/useDmRelayList";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { decryptCached, getCachedPlaintext, hasCachedPlaintext, setCachedPlaintext, type DecryptFn } from "@/lib/plaintextCache";
import { runExclusive } from "@/lib/signerQueue";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-04 encrypted direct message kind. */
export const KIND_DM = 4;

/** How many kind-4 events to request per direction, per relay, per page. */
export const DM_PAGE_SIZE = 500;

/** The other participant of a DM event, from the viewer's perspective. */
export function dmCounterparty(event: NostrEvent, self: string): string | undefined {
  if (event.pubkey !== self) return event.pubkey; // received: peer is the sender
  // sent: peer is the first `p` tag
  return event.tags.find(([name]) => name === "p")?.[1];
}

/**
 * A pagination cursor for one direction of one relay's DM stream. `undefined`
 * means "start from the top (no `until`)"; a number is the `until` for the next
 * page; `null` means EXHAUSTED — that relay returned a short page, so there is
 * nothing older. The undefined-vs-null distinction matters: a relay that fails
 * or times out is left `undefined` (retryable next pass), never marked `null`,
 * so a flaky relay doesn't permanently hide older history.
 */
export type DirectionCursor = number | null | undefined;

/** Per-relay sent/received cursors. */
export interface RelayCursor {
  sent: DirectionCursor;
  received: DirectionCursor;
}

/** All relays' cursors, keyed by relay URL. */
export type RelayCursors = Record<string, RelayCursor>;

/**
 * Compute the next `until` for a direction from the events a relay returned.
 * A short page (`< DM_PAGE_SIZE`) means we've reached the bottom → `null`
 * (exhausted). A full page means there may be more → the oldest event's
 * timestamp minus one second. An empty result is also exhausted.
 *
 * Per-relay, per-direction cursors (rather than a single global `until`) are
 * what keep pagination correct across heterogeneous relays: a single global
 * timestamp can skip ranges on a dense relay when a sparse relay returns much
 * older events. Each relay advances independently.
 */
export function nextDirectionCursor(events: NostrEvent[]): DirectionCursor {
  if (events.length < DM_PAGE_SIZE) return null;
  const oldest = Math.min(...events.map((e) => e.created_at));
  return Number.isFinite(oldest) ? oldest - 1 : null;
}

/** True if any relay/direction still has older pages to fetch. */
export function hasMoreCursor(cursors: RelayCursors): boolean {
  return Object.values(cursors).some((c) => c.sent !== null || c.received !== null);
}

/**
 * Build the self-scoped kind-4 filters for one relay given its cursor.
 * Relays only serve the viewer's own DMs, so we query `authors:[self]` (sent)
 * and `#p:[self]` (received). A direction whose cursor is `null` (exhausted) is
 * omitted. `undefined` means no `until` (first page).
 */
export function buildDmFilters(self: string, cursor: RelayCursor | undefined) {
  const filters: { kinds: number[]; authors?: string[]; "#p"?: string[]; limit: number; until?: number }[] = [];
  const sent = cursor?.sent;
  const received = cursor?.received;
  if (sent !== null) {
    filters.push({ kinds: [KIND_DM], authors: [self], limit: DM_PAGE_SIZE, ...(typeof sent === "number" ? { until: sent } : {}) });
  }
  if (received !== null) {
    filters.push({ kinds: [KIND_DM], "#p": [self], limit: DM_PAGE_SIZE, ...(typeof received === "number" ? { until: received } : {}) });
  }
  return filters;
}

/** A decrypted DM ready for rendering. */
export interface DecryptedDM {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  /**
   * Delivery state for messages we sent. Absent for received messages and for
   * sent messages that have been confirmed by the relay. `"sending"` while the
   * publish is in flight (rendered immediately on sign), `"failed"` if the
   * relay rejected it or the publish timed out (retryable).
   */
  status?: "sending" | "failed";
  /**
   * True when this row's ciphertext has NOT been decrypted yet — a viewport
   * placeholder. The thread eagerly decrypts only the newest screenful (the
   * visible window); older messages are surfaced as placeholders so the list
   * length and scroll position are correct, and each is decrypted lazily when
   * it scrolls into view (see `decryptVisible`). `content` is empty until then.
   */
  encrypted?: boolean;
}

/**
 * How many of the newest messages to decrypt eagerly. The thread is anchored to
 * the bottom (newest), so this is roughly one screenful plus headroom; older
 * messages are decrypted lazily as they scroll into view. Decryption is the
 * per-message signer round-trip, so bounding the eager set is what keeps opening
 * a long thread fast.
 */
const EAGER_DECRYPT_COUNT = 40;

/** Whether the current signer can do NIP-04 (required for DMs). */
export function useDMSupport(): boolean {
  const { user } = useCurrentUser();
  return !!user?.signer.nip04;
}

/**
 * Union raw kind-4 events with the previously-cached set, de-duplicated by id.
 *
 * This is the conversation-list merge floor: a sparse or empty relay read must
 * never SHRINK the list. Relays legitimately return partial pages or nothing on
 * a flaky connection — that doesn't mean conversations are gone. kind-4 events
 * are immutable, so a re-seen id is identical and last-write is harmless.
 */
export function mergeDmEvents(prev: NostrEvent[], incoming: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * Union a freshly-decrypted thread with the previously-cached thread,
 * de-duplicated by message id and sorted oldest-first.
 *
 * This is the thread merge floor: neither a sparse relay read nor a transient
 * mass-decrypt failure (a NIP-07 extension refusing a batch) may DROP messages
 * already decrypted and shown. Any optimistic `status` on a cached message is
 * preserved when the network echoes the same id back without one (the confirmed
 * publish path clears the badge explicitly).
 */
export function mergeDmThread(prev: DecryptedDM[], incoming: DecryptedDM[]): DecryptedDM[] {
  const merged = new Map<string, DecryptedDM>();
  for (const m of prev) merged.set(m.id, m);
  for (const m of incoming) {
    const existing = merged.get(m.id);
    // Never downgrade an already-decrypted row back to an encrypted placeholder:
    // if we have plaintext for this id, keep it (but still take any fresh status).
    if (existing && !existing.encrypted && m.encrypted) {
      merged.set(m.id, { ...existing, status: m.status ?? existing.status });
    } else {
      merged.set(m.id, { ...existing, ...m });
    }
  }
  return [...merged.values()].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Build placeholder rows for a conversation's events, synchronously and with no
 * decryption. Already-memoized plaintext (`getCachedPlaintext`) is filled in
 * immediately; everything else is an `encrypted: true` placeholder. This gives
 * the thread its full structure and correct scroll length on the very first
 * frame — the actual plaintext streams in afterwards (see `decryptThreadRows`).
 *
 * Returned oldest-first (render order).
 */
export function buildThreadPlaceholders(events: NostrEvent[]): DecryptedDM[] {
  const rows: DecryptedDM[] = [];
  for (const event of events) {
    const base = { id: event.id, pubkey: event.pubkey, created_at: event.created_at };
    const cached = getCachedPlaintext(event.id);
    rows.push(cached !== undefined ? { ...base, content: cached } : { ...base, content: "", encrypted: true });
  }
  return rows.sort((a, b) => a.created_at - b.created_at);
}

/**
 * Patch a single decrypted message into the thread cache by id, sorted
 * oldest-first. Used to stream each message in as it decrypts. Never downgrades
 * an already-decrypted row, and only flips `encrypted` off (keeps existing
 * optimistic `status`).
 */
function patchRow(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  row: DecryptedDM,
): void {
  queryClient.setQueryData<DecryptedDM[]>([...queryKey], (old = []) => {
    let found = false;
    const next = old.map((m) => {
      if (m.id !== row.id) return m;
      found = true;
      return { ...m, content: row.content, encrypted: undefined };
    });
    if (!found) next.push(row);
    return next.sort((a, b) => a.created_at - b.created_at);
  });
}

/**
 * Decrypt the newest `eager` placeholders of a conversation one at a time,
 * NEWEST-FIRST (the visible bottom), invoking `onRow` with each message the
 * instant its plaintext resolves so it can stream into the UI individually
 * instead of the whole batch appearing at once. Older messages are left as
 * placeholders for lazy, scroll-into-view decryption (`decryptVisible`).
 *
 * A decrypt failure is skipped (the row stays a placeholder and retries lazily),
 * so a transient signer hiccup never shrinks the thread. Cache hits are skipped
 * too (they're already plaintext from `buildThreadPlaceholders`).
 */
export async function decryptThreadRows(
  events: NostrEvent[],
  self: string,
  peer: string,
  decrypt: DecryptFn,
  eager: number,
  onRow: (row: DecryptedDM) => void,
): Promise<void> {
  // Newest-first so the eager window is the newest messages (the visible bottom)
  // and they reveal from the bottom up.
  const ordered = [...events].sort((a, b) => b.created_at - a.created_at);

  for (let i = 0; i < ordered.length && i < eager; i++) {
    const event = ordered[i];
    if (getCachedPlaintext(event.id) !== undefined) continue; // already shown
    const counterparty = event.pubkey === self ? peer : event.pubkey;
    try {
      const content = await decryptCached(self, counterparty, event, decrypt);
      onRow({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, content });
    } catch {
      // Keep as a placeholder; retried lazily when it scrolls into view.
    }
  }
}

/**
 * Convenience: build placeholders then fully resolve the eager window into a
 * single array (no streaming). Used where a batch result is wanted (the IDB
 * seed) or in tests. Returned oldest-first; failures stay placeholders.
 */
export async function buildThreadRows(
  events: NostrEvent[],
  self: string,
  peer: string,
  decrypt: DecryptFn,
  eager: number,
): Promise<DecryptedDM[]> {
  const byId = new Map<string, DecryptedDM>();
  for (const row of buildThreadPlaceholders(events)) byId.set(row.id, row);
  await decryptThreadRows(events, self, peer, decrypt, eager, (row) => {
    byId.set(row.id, row);
  });
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

/** The pool object from `useNostr` (relay/group accessors). */
type NostrPool = ReturnType<typeof useNostr>["nostr"];

/**
 * Query ONE relay for the viewer's DMs given its cursor, returning the events
 * and the relay's advanced cursor (per direction). A relay that errors/times
 * out throws, so the caller can leave its cursor `undefined` (retryable) rather
 * than marking it exhausted.
 */
async function queryRelayDmPage(
  nostr: NostrPool,
  url: string,
  self: string,
  cursor: RelayCursor | undefined,
  signal: AbortSignal,
): Promise<{ url: string; events: NostrEvent[]; cursor: RelayCursor }> {
  const filters = buildDmFilters(self, cursor);
  if (filters.length === 0) {
    return { url, events: [], cursor: { sent: null, received: null } };
  }
  const events = await nostr.relay(url).query(filters, { signal });
  const sentEvents = events.filter((e) => e.pubkey === self);
  const receivedEvents = events.filter((e) => e.pubkey !== self);
  return {
    url,
    events,
    cursor: {
      // A direction that was already exhausted (null) or had no filter stays put.
      sent: cursor?.sent === null ? null : nextDirectionCursor(sentEvents),
      received: cursor?.received === null ? null : nextDirectionCursor(receivedEvents),
    },
  };
}

/**
 * Query every relay individually (not as a pooled `group`), in parallel, and
 * merge all events by id. Returns the union plus each relay's advanced cursor.
 *
 * Per-relay querying (vs `nostr.group(relays).query`) is what lets the cursor
 * model work: a pooled query collapses all relays into one EOSE and one result,
 * so we can't tell which relay still has older pages. Querying each relay
 * separately lets a dense relay keep paging while a sparse one is already
 * exhausted. A failed relay is left with its previous cursor (retryable).
 */
async function queryRelaysDmPage(
  nostr: NostrPool,
  relays: string[],
  self: string,
  cursors: RelayCursors,
  signal: AbortSignal,
): Promise<{ events: NostrEvent[]; cursors: RelayCursors }> {
  const byId = new Map<string, NostrEvent>();
  const nextCursors: RelayCursors = {};

  const results = await Promise.allSettled(
    relays.map((url) => queryRelayDmPage(nostr, url, self, cursors[url], signal)),
  );

  results.forEach((result, i) => {
    const url = relays[i];
    if (!url) return;
    if (result.status === "fulfilled") {
      for (const e of result.value.events) byId.set(e.id, e);
      nextCursors[url] = result.value.cursor;
    } else {
      // Failed/timed-out: keep the prior cursor (or undefined) so the next pass
      // retries from where it was, never marking the relay exhausted.
      nextCursors[url] = cursors[url] ?? { sent: undefined, received: undefined };
    }
  });

  return { events: [...byId.values()], cursors: nextCursors };
}

/**
 * The list of DM conversations for the current user: every distinct
 * counterparty with the latest message and its timestamp. Built client-side
 * from kind-4 events on the DM relay (no caching service, unlike Primal).
 */
export function useDMConversations() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { mutedPubkeys, ready: muteReady } = useMutedPubkeys();
  const relays = effectiveDmRelays(config);
  const relayKey = relays.join(",");

  const queryKey = ["dm", "conversations", user?.pubkey, relayKey];

  // Per-relay, per-direction pagination cursors for the "load older
  // conversations" backfill. Kept in a ref (not state) so advancing them
  // doesn't re-render; `loadMore` reads/writes them. Reset when the
  // user/relays change.
  const cursorsRef = useRef<RelayCursors>({});
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  useEffect(() => {
    cursorsRef.current = {};
    setHasMore(true);
  }, [user?.pubkey, relayKey]);

  const query = useQuery<NostrEvent[]>({
    queryKey,
    enabled: !!user?.pubkey,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;
      const store = await eventStore;

      // 1. LOCAL-FIRST: our own kind-4 set is mirrored into IndexedDB by
      //    NostrBatcher, so the conversation list paints instantly from cache on
      //    reload instead of behind a relay round-trip.
      const cachedEvents = await store.query([
        { kinds: [KIND_DM], authors: [pubkey], limit: DM_PAGE_SIZE },
        { kinds: [KIND_DM], "#p": [pubkey], limit: DM_PAGE_SIZE },
      ]);
      const prev = queryClient.getQueryData<NostrEvent[]>(queryKey) ?? [];
      const local = mergeDmEvents(prev, cachedEvents);

      // 2. BACKGROUND refresh: query EACH relay individually (not a pooled
      //    group) for its newest page, merge all in, and seed the per-relay
      //    cursors so "load older" can page each relay independently. NOT
      //    awaited — the network never gates the visible list. Merge floor: a
      //    sparse/empty relay read can never SHRINK the list, and a conversation
      //    that only exists on one slow relay still gets filled in.
      void (async () => {
        if (signal.aborted || relays.length === 0) return;
        try {
          const { events, cursors } = await queryRelaysDmPage(
            nostr,
            relays,
            pubkey,
            {}, // first page per relay (no `until`)
            AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          );
          if (signal.aborted) return;
          cursorsRef.current = cursors;
          setHasMore(hasMoreCursor(cursors));
          if (events.length === 0) return;
          queryClient.setQueryData<NostrEvent[]>(queryKey, (old = []) => mergeDmEvents(old, events));
        } catch {
          // Best-effort; the local-first list already rendered.
        }
      })();

      return local;
    },
    staleTime: 15_000,
  });

  // Load an older page of conversations: advance each non-exhausted relay's
  // cursor one page and merge. Because each relay pages independently, a dense
  // relay keeps yielding history after a sparse one is exhausted — no global
  // cursor can skip its range.
  const loadMore = useCallback(async (): Promise<number> => {
    if (!user?.pubkey || loadingMoreRef.current || !hasMore || relays.length === 0) return 0;
    if (!hasMoreCursor(cursorsRef.current)) {
      setHasMore(false);
      return 0;
    }
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const { events, cursors } = await queryRelaysDmPage(
        nostr,
        relays,
        user.pubkey,
        cursorsRef.current,
        AbortSignal.timeout(8000),
      );
      cursorsRef.current = cursors;
      const more = hasMoreCursor(cursors);
      setHasMore(more);
      if (events.length === 0) return 0;
      let added = 0;
      queryClient.setQueryData<NostrEvent[]>(queryKey, (old = []) => {
        const merged = mergeDmEvents(old, events);
        added = merged.length - old.length;
        return merged;
      });
      return added;
    } catch {
      return 0;
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, relayKey, hasMore, queryClient]);

  // The live subscription below (since=now-5s) surfaces new conversations; the
  // local-first queryFn handles cold-load rendering, so no separate seed effect.

  // Live subscription so new conversations/messages surface without a refetch.
  useEffect(() => {
    if (!user?.pubkey) return;
    const pubkey = user.pubkey;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    (async () => {
      try {
        for await (const msg of nostr.group(relays).req(
          [
            { kinds: [KIND_DM], authors: [pubkey], since },
            { kinds: [KIND_DM], "#p": [pubkey], since },
          ],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            queryClient.setQueryData<NostrEvent[]>(queryKey, (old = []) =>
              old.some((e) => e.id === event.id) ? old : [...old, event],
            );
          }
        }
      } catch {
        // subscription closed
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, relayKey, queryClient]);

  const self = user?.pubkey ?? "";

  // Reduce raw events to one entry per counterparty (latest wins), dropping
  // conversations with anyone on the user's mute list (NIP-51 kind 10000) so
  // blocked people never show up in the DM list.
  //
  // Until the mute set is `ready` we return NOTHING (and report loading), so the
  // list never paints muted conversations and then yanks them out from under
  // the user. `ready` resolves instantly from the local cache for a returning
  // user; only a true cold start (no cache + network in flight) actually waits.
  const conversations = useMemo(() => {
    if (!muteReady) return [];
    const byPeer = new Map<string, { peer: string; latest: NostrEvent }>();
    for (const event of query.data ?? []) {
      const peer = dmCounterparty(event, self);
      if (!peer || mutedPubkeys.has(peer)) continue;
      const existing = byPeer.get(peer);
      if (!existing || event.created_at > existing.latest.created_at) {
        byPeer.set(peer, { peer, latest: event });
      }
    }
    return [...byPeer.values()].sort((a, b) => b.latest.created_at - a.latest.created_at);
  }, [query.data, self, mutedPubkeys, muteReady]);

  // Decrypt just the latest message of each conversation for the list preview.
  // Sequential decrypt (see thread loop) to avoid NIP-07 concurrency rejections.
  const previewKey = conversations
    .map((c) => `${c.peer}:${c.latest.id}`)
    .join(",");

  const previews = useQuery<Record<string, string>>({
    queryKey: ["dm", "previews", self, previewKey],
    enabled: !!self && !!user?.signer.nip04 && conversations.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const nip04 = user!.signer.nip04!;
      const out: Record<string, string> = {};
      for (const { peer, latest } of conversations) {
        try {
          out[peer] = await decryptCached(self, peer, latest, (cp, ct) => nip04.decrypt(cp, ct));
        } catch (err) {
          console.warn("DM preview decrypt failed", { peer, id: latest.id, err });
        }
      }
      return out;
    },
  });

  return {
    conversations,
    previews: previews.data ?? {},
    // Loading until the events query AND the mute set are both settled, so the
    // list shows a spinner rather than an unfiltered flash on cold start.
    isLoading: query.isLoading || !muteReady,
    error: query.error,
    /** Fetch an older page of conversations (per-relay cursor pagination). */
    loadMore,
    /** Whether any relay still has older conversation history to page. */
    hasMore,
    isLoadingMore,
  };
}

/**
 * Whether the user has any unread direct messages — the latest message in any
 * conversation is from the peer and newer than the thread's last-read stamp.
 * Drives the unread dot on the DMs button in the server rail.
 */
export function useHasUnreadDMs(): boolean {
  const { user } = useCurrentUser();
  const { conversations } = useDMConversations();
  const { getLastRead } = useReadState();

  return useMemo(() => {
    if (!user) return false;
    return conversations.some(
      (c) =>
        c.latest.pubkey !== user.pubkey &&
        c.latest.created_at > getLastRead(dmReadKey(c.peer)),
    );
  }, [user, conversations, getLastRead]);
}

/**
 * The decrypted message thread with a single peer, plus a `send` mutation.
 * Messages are kind-4 NIP-04 events on the DM relay, decrypted with the
 * signer's nip04 method.
 */
export function useDirectMessages(peer: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const relays = effectiveDmRelays(config);
  const relayKey = relays.join(",");

  // The peer's published NIP-17 DM inbox relays (kind 10050), if any. We READ
  // from our own relays (a relay only serves the viewer's own kind-4 events,
  // so the peer's relays wouldn't return our copies), but we WRITE to the union
  // of our relays and the peer's inbox — otherwise a message to someone who
  // doesn't read our relays silently never reaches them. Falls back to our own
  // relays when the peer has published no list.
  const peerDmRelays = useDmRelaysFor(peer);
  const writeRelays = useMemo(() => {
    const merged = [...relays, ...peerDmRelays];
    return [...new Set(merged)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayKey, peerDmRelays.join(",")]);

  const self = user?.pubkey;
  const queryKey = useMemo(
    () => ["dm", "thread", self, peer, relayKey] as const,
    [self, peer, relayKey],
  );

  const query = useQuery<DecryptedDM[]>({
    queryKey,
    enabled: !!self && !!peer && !!user?.signer.nip04,
    queryFn: async ({ signal }) => {
      const nip04 = user!.signer.nip04!;
      const store = await eventStore;

      // 1. LOCAL-FIRST: read our own kind-4 set from the append-only IndexedDB
      //    store (mirrored by NostrBatcher), narrow to this peer, and return
      //    placeholders IMMEDIATELY so the thread structure paints on the first
      //    frame after a refresh instead of behind the skeleton. Decryption of
      //    the newest screenful streams in via the plaintext cache.
      const localEvents = await store.query([
        { kinds: [KIND_DM], authors: [self!], limit: 1000 },
        { kinds: [KIND_DM], "#p": [self!], limit: 1000 },
      ]);
      const localThread = localEvents.filter((e) => dmCounterparty(e, self!) === peer);
      const prevLocal = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
      const localPlaceholders = mergeDmThread(prevLocal, buildThreadPlaceholders(localThread));
      if (localThread.length > 0) {
        void decryptThreadRows(
          localThread,
          self!,
          peer!,
          (cp, ct) => nip04.decrypt(cp, ct),
          EAGER_DECRYPT_COUNT,
          (row) => patchRow(queryClient, queryKey, row),
        );
      }

      // 2. BACKGROUND network refresh: query the relays for newer DMs, merge into
      //    the cache, stream their decrypts in. NOT awaited — the network never
      //    gates the visible thread.
      void (async () => {
        if (signal.aborted) return;
        try {
          // Query ONLY self-scoped filters (relays reject filters naming another
          // pubkey). Our own kind-4 set covers both directions.
          const events = await nostr.group(relays).query(
            [
              { kinds: [KIND_DM], authors: [self!], limit: 1000 },
              { kinds: [KIND_DM], "#p": [self!], limit: 1000 },
            ],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
          );
          const inThread = events.filter((e) => dmCounterparty(e, self!) === peer);
          if (signal.aborted || inThread.length === 0) return;
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            mergeDmThread(old, buildThreadPlaceholders(inThread)),
          );
          void decryptThreadRows(
            inThread,
            self!,
            peer!,
            (cp, ct) => nip04.decrypt(cp, ct),
            EAGER_DECRYPT_COUNT,
            (row) => patchRow(queryClient, queryKey, row),
          );
        } catch {
          // Best-effort background refresh; the local-first result already rendered.
        }
      })();

      return localPlaceholders;
    },
    staleTime: 10_000,
  });

  // Live subscription for new messages in this thread.
  useEffect(() => {
    if (!self || !peer || !user?.signer.nip04) return;
    const nip04 = user.signer.nip04;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    (async () => {
      try {
        for await (const msg of nostr.group(relays).req(
          [
            { kinds: [KIND_DM], authors: [self], since },
            { kinds: [KIND_DM], "#p": [self], since },
          ],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrEvent;
          // Only messages in this 1:1 conversation.
          if (dmCounterparty(event, self) !== peer) continue;
          const counterparty = event.pubkey === self ? peer : event.pubkey;
          let content: string;
          try {
            content = await decryptCached(self, counterparty, event, (cp, ct) => nip04.decrypt(cp, ct));
          } catch (err) {
            console.warn("DM live decrypt failed", { id: event.id, counterparty, err });
            continue;
          }
          const decrypted: DecryptedDM = {
            id: event.id,
            pubkey: event.pubkey,
            created_at: event.created_at,
            content,
          };
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            old.some((m) => m.id === decrypted.id)
              ? old
              : [...old, decrypted].sort((a, b) => a.created_at - b.created_at),
          );
        }
      } catch {
        // subscription closed
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, self, peer, user?.signer.nip04, relayKey, queryClient]);

  // Backfill older history for this conversation. Because relays only serve
  // your own DMs (self-scoped filters), we page the global self-DM stream with
  // an `until` cursor and narrow to this peer client-side. `hasMore` flips off
  // once a page comes back short.
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const oldestRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);

  // Reset the cursor when the peer/relays change.
  useEffect(() => {
    oldestRef.current = undefined;
    setHasMore(true);
  }, [self, peer, relayKey]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!self || !peer || !user?.signer.nip04) return 0;
    if (loadingRef.current || !hasMore) return 0;

    const nip04 = user.signer.nip04;
    // First backfill starts from the oldest message currently rendered.
    const current = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
    const until =
      oldestRef.current ??
      (current.length > 0 ? current[0].created_at - 1 : Math.floor(Date.now() / 1000));

    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      const events = await nostr.group(relays).query(
        [
          { kinds: [KIND_DM], authors: [self], until, limit: 500 },
          { kinds: [KIND_DM], "#p": [self], until, limit: 500 },
        ],
        { signal: AbortSignal.timeout(8000) },
      );

      if (events.length === 0) {
        setHasMore(false);
        return 0;
      }

      // Advance the cursor from the raw page (oldest event minus one second).
      const oldestEvent = Math.min(...events.map((e) => e.created_at));
      oldestRef.current = oldestEvent - 1;
      if (events.length < 500) setHasMore(false);

      const inThread = events.filter((e) => dmCounterparty(e, self) === peer);
      const existing = new Set(current.map((m) => m.id));
      const fresh = inThread.filter((e) => !existing.has(e.id));

      // Backfilled history is older than what's shown, so it's all lazy
      // placeholders (eager = 0) — each decrypts when it scrolls into view.
      // Already-memoized messages still come back decrypted (buildThreadRows
      // honors the cache regardless of position).
      const rows = await buildThreadRows(
        fresh,
        self,
        peer,
        (cp, ct) => nip04.decrypt(cp, ct),
        0,
      );

      if (rows.length === 0) return 0;

      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) => {
        const byId = new Map<string, DecryptedDM>();
        for (const m of [...rows, ...old]) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
      });
      return rows.length;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [self, peer, user?.signer.nip04, hasMore, queryClient, queryKey, nostr, relays]);

  /** Update a single optimistic message's delivery status in the cache. */
  const setMessageStatus = useCallback(
    (id: string, status: DecryptedDM["status"]) => {
      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
        old.map((m) => (m.id === id ? { ...m, status } : m)),
      );
    },
    [queryClient, queryKey],
  );

  // Publish a signed DM in the background and reconcile its optimistic status.
  // The message is already rendered (status "sending") before this runs, so the
  // composer can clear immediately and the UI never blocks on the relay.
  const publish = useCallback(
    async (event: NostrEvent) => {
      try {
        // Write to the union of our DM relays and the peer's published inbox
        // relays (kind 10050), so the message reaches the recipient even when
        // they don't read our relays.
        await nostr.group(writeRelays).event(event, { signal: AbortSignal.timeout(8000) });
        // Confirmed: drop the "sending" badge. The live subscription may also
        // echo this event back; dedup by id keeps it from duplicating.
        setMessageStatus(event.id, undefined);
        queryClient.invalidateQueries({ queryKey: ["dm", "conversations", user?.pubkey] });
      } catch (err) {
        setMessageStatus(event.id, "failed");
        throw err;
      }
    },
    [nostr, writeRelays, setMessageStatus, queryClient, user?.pubkey],
  );

  const send = useMutation({
    // Encrypt + sign, render immediately, then publish in the background. The
    // mutation resolves as soon as the message is signed and shown (so the
    // composer clears instantly); delivery success/failure is reflected via the
    // message's `status` rather than by blocking the caller on the relay OK.
    //
    // Signing is serialized through `signChainRef`: NIP-07 extensions reject
    // concurrent encrypt/signEvent calls, so when the user fires several
    // messages in a row we must sign them one at a time. Each message is
    // rendered as a "sending" placeholder up front (keyed by a temporary local
    // id) so the queue is visible instantly, then reconciled to the real signed
    // event id once its turn in the sign queue comes up.
    mutationFn: async (text: string) => {
      if (!user?.signer.nip04) throw new Error("NIP-04 encryption not supported by signer");
      if (!peer) throw new Error("No recipient");
      const trimmed = text.trim();
      if (!trimmed) return;

      const signer = user.signer;
      const self = user.pubkey;
      // Temporary client-side id for the optimistic placeholder; swapped for the
      // real event id after signing.
      const tempId = `pending:${crypto.randomUUID()}`;
      const createdAt = Math.floor(Date.now() / 1000);

      // Render the queued message immediately, in order, before it even starts
      // signing — so rapid-fire sends all appear at once.
      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
        [
          ...old,
          {
            id: tempId,
            pubkey: self,
            created_at: createdAt,
            content: trimmed,
            status: "sending" as const,
          },
        ].sort((a, b) => a.created_at - b.created_at),
      );
      // NOTE: deliberately do NOT invalidate the conversation-list query here.
      // Invalidating triggers a refetch + a re-decrypt of every conversation's
      // preview (each a NIP-07 round-trip) that contends with our in-flight
      // signing on the same extension — turning a burst of sends into a
      // thrash. The optimistic thread render already shows the message; the
      // conversation list re-orders on its next natural refetch / live event.

      // Encrypt + sign serialized against all other signer crypto for this
      // identity (extension-safe), then render the real id and publish in the
      // background.
      try {
        const event = await runExclusive(self, async () => {
          const content = await signer.nip04!.encrypt(peer, trimmed);
          return signer.signEvent({
            kind: KIND_DM,
            content,
            tags: [["p", peer]],
            created_at: createdAt,
          });
        });

        // Swap the placeholder for the real, signed event id (still "sending").
        queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
          old.map((m) =>
            m.id === tempId
              ? { ...m, id: event.id, created_at: event.created_at }
              : m,
          ),
        );

        // Seed the plaintext memo with what we just sent, keyed by the real
        // event id, so when the relay echoes this message back through the live
        // subscription (or a refetch) it's a cache hit — we never re-decrypt our
        // own outgoing message.
        setCachedPlaintext(event.id, trimmed);

        // Publish in the background; don't make the caller await the relay.
        void publish(event).catch(() => {
          // Failure is surfaced via the message's "failed" status (and retry).
        });
      } catch {
        // Encryption/signing failed (e.g. extension rejected) — mark the
        // placeholder failed so it can be retried, and don't throw (the send is
        // fire-and-forget from the composer's perspective).
        setMessageStatus(tempId, "failed");
      }
    },
  });

  /** Re-publish a message that previously failed to send. */
  const retry = useCallback(
    (id: string) => {
      const messages = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
      const failed = messages.find((m) => m.id === id && m.status === "failed");
      if (!failed || !user || !peer) return;
      const signer = user.signer;
      const self = user.pubkey;
      setMessageStatus(id, "sending");

      void (async () => {
        try {
          // Re-sign serialized against all other signer crypto, same as send.
          const event = await runExclusive(self, async () => {
            const content = await signer.nip04!.encrypt(peer, failed.content);
            return signer.signEvent({
              kind: KIND_DM,
              content,
              tags: [["p", peer]],
              created_at: failed.created_at,
            });
          });
          // The signed event id may differ from the placeholder id; reconcile.
          if (event.id !== id) {
            queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
              old.map((m) => (m.id === id ? { ...m, id: event.id } : m)),
            );
          }
          await publish(event);
        } catch {
          setMessageStatus(id, "failed");
        }
      })();
    },
    [queryClient, queryKey, user, peer, setMessageStatus, publish],
  );

  /**
   * Decrypt a placeholder message that has scrolled into view, filling its
   * plaintext into the thread. Called by the render layer's IntersectionObserver
   * for each `encrypted: true` row. Reads the raw ciphertext from the event
   * store (where NostrBatcher mirrors it), decrypts through the memo, and
   * patches just that row. Idempotent: a no-op once the id is decrypted, and
   * concurrent calls for the same id share one signer round-trip (plaintextCache
   * in-flight dedup).
   */
  const decryptVisible = useCallback(
    (id: string) => {
      if (!self || !peer || !user?.signer.nip04) return;
      if (hasCachedPlaintext(id)) {
        // Already decrypted this session — just make sure the row reflects it.
        const content = getCachedPlaintext(id)!;
        queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
          old.map((m) => (m.id === id && m.encrypted ? { ...m, content, encrypted: false } : m)),
        );
        return;
      }
      const nip04 = user.signer.nip04;
      void (async () => {
        const store = await eventStore;
        const [event] = await store.query([{ ids: [id] }]);
        if (!event) return;
        const counterparty = event.pubkey === self ? peer : event.pubkey;
        try {
          const content = await decryptCached(self, counterparty, event, (cp, ct) => nip04.decrypt(cp, ct));
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            old.map((m) => (m.id === id ? { ...m, content, encrypted: false } : m)),
          );
        } catch {
          // Leave it as a placeholder; it'll retry next time it enters view.
        }
      })();
    },
    [self, peer, user?.signer.nip04, eventStore, queryClient, queryKey],
  );

  return {
    messages: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    send: send.mutateAsync,
    isSending: send.isPending,
    retry,
    loadOlder,
    hasMore,
    isLoadingOlder,
    decryptVisible,
  };
}
