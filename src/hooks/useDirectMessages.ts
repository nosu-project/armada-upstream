import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useEventStore } from "@/hooks/useEventStore";
import { useFollowList } from "@/hooks/useFollowList";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useDmRelaysFor } from "@/hooks/useDmRelayList";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { useTimelineSnapshotWriter } from "@/hooks/useTimelineSnapshot";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { decryptCached, getRenderedPlaintext, hasRenderedPlaintext, setRenderedPlaintext, type DecryptFn } from "@/hooks/dmRenderCache";
import { useDecryptConsent } from "@/hooks/useDecryptConsent";
import { mayBulkDecrypt, signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { setDecryptConsent } from "@/lib/decryptConsent";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";
import { dmThreadSnapshotScope, readTimelineSnapshot } from "@/lib/timelineSnapshot";
import { isDmSynced, markDmSynced } from "@/lib/dmSynced";
import { markOwnWebPushEvent } from "@/lib/webPushState";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-04 encrypted direct message kind. */
export const KIND_DM = 4;

/**
 * Minimum interval between relay top-up pulls. The wire delivers new DMs to
 * the shared store live; the queryFns' background pulls exist for history the
 * wire never covered and dead-socket healing — they must not re-fire on every
 * wire-bus invalidation.
 */
const PULL_MIN_INTERVAL_MS = 30_000;

/** How many kind-4 events to request per direction, per relay, per page. */
export const DM_PAGE_SIZE = 500;

/** The other participant of a DM event, from the viewer's perspective. */
export function dmCounterparty(event: NostrRumor, self: string): string | undefined {
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
export function nextDirectionCursor(events: NostrRumor[]): DirectionCursor {
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
 * and `#p:[self]` (received). The received direction is additionally scoped to
 * `authors:[...follows]` so DMs from strangers are never fetched — only people
 * the viewer follows (kind 3) can reach them. A direction whose cursor is
 * `null` (exhausted) is omitted. `undefined` means no `until` (first page).
 *
 * When `follows` is empty, the received filter is omitted entirely (an empty
 * `authors` would match nobody anyway, and some relays reject an empty array).
 */
export function buildDmFilters(self: string, cursor: RelayCursor | undefined, follows: string[]) {
  const filters: { kinds: number[]; authors?: string[]; "#p"?: string[]; limit: number; until?: number }[] = [];
  const sent = cursor?.sent;
  const received = cursor?.received;
  if (sent !== null) {
    filters.push({ kinds: [KIND_DM], authors: [self], limit: DM_PAGE_SIZE, ...(typeof sent === "number" ? { until: sent } : {}) });
  }
  if (received !== null && follows.length > 0) {
    filters.push({ kinds: [KIND_DM], authors: follows, "#p": [self], limit: DM_PAGE_SIZE, ...(typeof received === "number" ? { until: received } : {}) });
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
  /**
   * Stable render key for a message whose `id` changes during its lifetime: an
   * optimistic send starts with a placeholder id and adopts the signed event id
   * once signing finishes. Set to the placeholder id at insert and carried
   * across the swap, so the row is never remounted mid-send.
   */
  renderKey?: string;
}

/**
 * Whether an empty kind-4 thread is still waiting on its first relay pull —
 * i.e. "no messages" is not yet a verdict.
 *
 * This is a SYNC signal, not a loading one. It used to be OR'd into the hook's
 * `isLoading` (the timeline's skeleton), which made a relay round — up to the
 * 8s pull timeout, and reliably the whole of it on a cold Android launch
 * against unauthenticated relays — look like a disk read in progress. A
 * conversation carrying its entire history on the NIP-17 plane has no local
 * kind-4 rows at all, so this was true for every modern DM, and the merged
 * transport's `isLoading || dm17.isLoading` then held the skeleton over rumors
 * that were already read and folded. See `shouldShowDmTimelineLoading`.
 */
export function isEmptyThreadAwaitingPull(
  messageCount: number,
  waitingForInitialPull: boolean,
): boolean {
  return messageCount === 0 && waitingForInitialPull;
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
export function mergeDmEvents(prev: NostrRumor[], incoming: NostrRumor[]): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
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
 * decryption. Already-memoized plaintext (`getRenderedPlaintext`) is filled in
 * immediately; everything else is an `encrypted: true` placeholder. This gives
 * the thread its full structure and correct scroll length on the very first
 * frame — the actual plaintext streams in afterwards (see `decryptThreadRows`).
 *
 * Returned oldest-first (render order).
 */
export function buildThreadPlaceholders(events: NostrRumor[]): DecryptedDM[] {
  const rows: DecryptedDM[] = [];
  for (const event of events) {
    const base = { id: event.id, pubkey: event.pubkey, created_at: event.created_at };
    const cached = getRenderedPlaintext(event.id);
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
  events: NostrRumor[],
  self: string,
  peer: string,
  decrypt: DecryptFn,
  eager: number,
  onRow: (row: DecryptedDM) => void,
  preflight?: (targets: { id: string; counterparty: string; ciphertext: string }[]) => Promise<boolean>,
  onAllFailed?: () => void,
): Promise<void> {
  // Newest-first so the eager window is the newest messages (the visible
  // bottom). Decrypts within the window are fired CONCURRENTLY — they are not
  // serialized, so the thread fills in together rather than waterfalling one
  // row at a time. Each row still streams into the UI the instant its own
  // decrypt resolves (order of arrival is whatever the signer returns first).
  const ordered = [...events].sort((a, b) => b.created_at - a.created_at);
  const window = ordered.slice(0, eager);

  // Consent gate: the not-yet-shown rows are the only ones that could poke the
  // signer. Ask the preflight whether we may decrypt them; if it declines, the
  // rows stay encrypted placeholders (the UI offers manual "Decrypt"/"Decrypt
  // all"). Already-shown rows are skipped either way — no signer contact.
  if (preflight) {
    const pending = window
      .filter((event) => getRenderedPlaintext(event.id) === undefined)
      .map((event) => ({
        id: event.id,
        counterparty: event.pubkey === self ? peer : event.pubkey,
        ciphertext: event.content,
      }));
    if (pending.length > 0 && !(await preflight(pending))) return;
  }

  let attempted = 0;
  let failed = 0;
  await Promise.all(
    window.map(async (event) => {
      if (getRenderedPlaintext(event.id) !== undefined) return; // already shown
      const counterparty = event.pubkey === self ? peer : event.pubkey;
      attempted++;
      try {
        const content = await decryptCached(counterparty, event, decrypt);
        onRow({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, content });
      } catch {
        // Keep as a placeholder; retried lazily when it scrolls into view.
        failed++;
      }
    }),
  );

  // A signer that rejects EVERY decrypt (e.g. an extension set to "never ask
  // again → reject") would otherwise leave the thread lingering on skeletons
  // and re-poke on every scroll. Treat a wholesale failure as the signer
  // declining, so the UI flips to the manual "Decrypt" / "Decrypt all"
  // affordances and stops auto-retrying. A partial failure is just transient.
  if (attempted > 0 && failed === attempted) onAllFailed?.();
}

/**
 * Convenience: build placeholders then fully resolve the eager window into a
 * single array (no streaming). Used where a batch result is wanted (the IDB
 * seed) or in tests. Returned oldest-first; failures stay placeholders.
 */
export async function buildThreadRows(
  events: NostrRumor[],
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
  follows: string[],
  signal: AbortSignal,
): Promise<{ url: string; events: NostrRumor[]; cursor: RelayCursor }> {
  const filters = buildDmFilters(self, cursor, follows);
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
  follows: string[],
  signal: AbortSignal,
): Promise<{ events: NostrRumor[]; cursors: RelayCursors }> {
  const byId = new Map<string, NostrRumor>();
  const nextCursors: RelayCursors = {};

  const results = await Promise.allSettled(
    relays.map((url) => queryRelayDmPage(nostr, url, self, cursors[url], follows, signal)),
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
 * Query every relay individually for a fixed filter set and merge events by id.
 *
 * Same reason as {@link queryRelaysDmPage} but with no cursor bookkeeping (used
 * for thread history and older-page pulls): a pooled `group(relays).query`
 * aborts the WHOLE fan-out `eoseTimeout` ms (300 in this app) after the FIRST
 * relay EOSEs (NPool.query forces the pool's eoseTimeout), which guillotines an
 * auth-gated relay before it can finish its NIP-42 challenge→sign→re-REQ — so
 * its messages are silently dropped, worst on a cold/reconnecting mobile
 * socket. Per-relay `NRelay1.query` has no cross-relay timer: each relay gets
 * the full `signal` budget. Best-effort per relay: a failure contributes nothing.
 */
async function queryRelaysMerged(
  nostr: NostrPool,
  relays: string[],
  filters: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrRumor[]> {
  const byId = new Map<string, NostrRumor>();
  const results = await Promise.allSettled(
    relays.map((url) => nostr.relay(url).query(filters, { signal })),
  );
  for (const r of results) {
    if (r.status === "fulfilled") for (const e of r.value) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/**
 * The list of DM conversations for the current user: every distinct
 * counterparty with the latest message and its timestamp. Built client-side
 * from kind-4 events on the DM relay (no caching service, unlike Primal).
 */
export function useDMConversations(options?: { decryptPreviews?: boolean }) {
  // Previews decrypt each conversation's latest message, which is a signer
  // round-trip (and the first thing that could open the decrypt-consent
  // prompt). The DMs list is the ONLY consumer that needs them, so previews are
  // opt-in: the always-mounted unread-dot consumer (useHasUnreadDMs) leaves
  // them off, so nothing pokes the signer — or the prompt — until the user
  // actually opens DMs.
  const decryptPreviews = options?.decryptPreviews ?? false;
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { mutedPubkeys, ready: muteReady } = useMutedPubkeys();
  const { data: followData } = useFollowList();
  const { consent } = useDecryptConsent();
  const relays = effectiveDmRelays(config);
  const relayKey = relays.join(",");

  // People the viewer follows (kind 3). All received-DM queries are scoped to
  // these authors so DMs from strangers are never fetched — friends-only is a
  // permanent, relay-level constraint, not a client-side view filter. Sorted +
  // joined into a stable key so effects/queries don't churn on set reordering.
  const follows = useMemo(() => [...(followData?.pubkeys ?? [])].sort(), [followData?.pubkeys]);
  const followsKey = follows.join(",");
  // Read inside the queryFn (and the un-awaited background pull) so both always
  // see the current set without `follows` being a queryFn dependency.
  const followsRef = useRef(follows);
  followsRef.current = follows;

  // NOTE: `followsKey` is deliberately NOT part of the query key. The follow
  // list resolves asynchronously, so on every cold load it goes empty → real,
  // and keying on it made that transition swap TanStack to a fresh cache entry
  // with no placeholder — dropping the merged event set back to the 30-item
  // `initialData` snapshot and visibly collapsing/re-sorting the conversation
  // list a beat after it painted. Follows are read from a ref instead, and a
  // change re-runs THIS entry's queryFn (below), so the wider author set merges
  // on top of what's already rendered.
  const queryKey = ["dm", "conversations", user?.pubkey, relayKey];

  // Per-relay, per-direction pagination cursors for the "load older
  // conversations" backfill. Kept in a ref (not state) so advancing them
  // doesn't re-render; `loadMore` reads/writes them. Reset when the
  // user/relays change.
  const cursorsRef = useRef<RelayCursors>({});
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const lastPullRef = useRef(0);
  // Tracks the follow set the cache was last fetched with. `undefined` means
  // "this hook instance hasn't observed one yet" — the mount pass must not
  // invalidate, since the query is already fetching with the current set.
  const fetchedFollowsRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    cursorsRef.current = {};
    lastPullRef.current = 0;
    setHasMore(true);
    // Follows aren't in the query key, so a follow-list change has to re-run
    // the queryFn explicitly: the received-DM filters widen to the new authors
    // and the results merge (append-only) into the rendered list.
    const prevFollows = fetchedFollowsRef.current;
    fetchedFollowsRef.current = followsKey;
    if (prevFollows !== undefined && prevFollows !== followsKey && user?.pubkey) {
      void queryClient.invalidateQueries({ queryKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, relayKey, followsKey, queryClient]);

  const query = useQuery<NostrRumor[]>({
    queryKey,
    enabled: !!user?.pubkey,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;
      const firstSync = !isDmSynced("nip04", pubkey);
      const store = await eventStore;
      // Newest known follow set at execution time (not fetch-scheduling time).
      const scopedFollows = followsRef.current;

      // 1. LOCAL-FIRST: the wire funnels every kind-4 into IndexedDB (and
      //    NostrBatcher mirrors pull results), so the conversation list paints
      //    from the store — the query stays pending until this read resolves,
      //    so the list's first paint is already correctly ordered. Received DMs
      //    are scoped to followed authors (friends-only), matching the relay
      //    queries below.
      const cachedEvents = await store.query([
        { kinds: [KIND_DM], authors: [pubkey], limit: DM_PAGE_SIZE },
        ...(scopedFollows.length > 0
          ? [{ kinds: [KIND_DM], authors: scopedFollows, "#p": [pubkey], limit: DM_PAGE_SIZE }]
          : []),
      ]);
      const prev = queryClient.getQueryData<NostrRumor[]>(queryKey) ?? [];
      const local = mergeDmEvents(prev, cachedEvents);

      // 2. THROTTLED BACKGROUND refresh: query EACH relay individually (not a
      //    pooled group) for its newest page, merge all in, and seed the
      //    per-relay cursors so "load older" can page each relay
      //    independently. NOT awaited — the network never gates the visible
      //    list. Throttled so wire-bus invalidations stay local-only.
      const pullDue = Date.now() - lastPullRef.current >= PULL_MIN_INTERVAL_MS;
      if (pullDue) lastPullRef.current = Date.now();
      const pull = (async () => {
        if (!pullDue || signal.aborted || relays.length === 0) return;
        try {
          const { events, cursors } = await queryRelaysDmPage(
            nostr,
            relays,
            pubkey,
            {}, // first page per relay (no `until`)
            scopedFollows,
            AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          );
          if (signal.aborted) return;
          cursorsRef.current = cursors;
          setHasMore(hasMoreCursor(cursors));
          // Completed without throwing: the store has now seen whatever the
          // relays hold, so later loads may trust it and render store-first.
          markDmSynced("nip04", pubkey);
          if (events.length === 0) return;
          queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) => mergeDmEvents(old, events));
        } catch {
          // Best-effort; the local-first list already rendered. Deliberately
          // NOT marked synced — a timeout or offline start must not latch the
          // flag, or the next load would paint a false empty list.
        }
      })();

      // On the FIRST sync this device has nothing local to show, so the network
      // is the only source: await it rather than resolving to an empty list
      // that the pull then re-orders under the user. The pull writes its merge
      // through `setQueryData`, so re-read the cache and union it in — returning
      // the pre-pull `local` here would clobber that write.
      if (firstSync) {
        await pull;
        return mergeDmEvents(local, queryClient.getQueryData<NostrRumor[]>(queryKey) ?? []);
      }

      return local;
    },
    staleTime: 15_000,
    // No `initialData`. A localStorage snapshot used to seed the first frame
    // here, but it held only the newest 30 kind-4 events — a truncated,
    // NIP-17-blind slice of the list — so every load painted a deterministically
    // WRONG order that the store read then corrected a beat later. The
    // IndexedDB read is fast enough to block on; the list now paints once, in
    // its final order.
    // Backstop the live socket: a backgrounded mobile WebSocket can wedge with
    // no error and no event, silently stalling delivery. A periodic local-first
    // re-read heals the gap (matches the NIP-29/Concord hooks, which DMs had
    // been missing). Focus/reconnect catch up immediately rather than waiting
    // out the interval.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
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
        follows,
        AbortSignal.timeout(8000),
      );
      cursorsRef.current = cursors;
      const more = hasMoreCursor(cursors);
      setHasMore(more);
      if (events.length === 0) return 0;
      let added = 0;
      queryClient.setQueryData<NostrRumor[]>(queryKey, (old = []) => {
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
  }, [nostr, user?.pubkey, relayKey, followsKey, hasMore, queryClient]);

  // The wire holds the standing DM subscription and funnels every kind-4 into
  // the shared store; re-read when it announces a change. (The queryFn's relay
  // pull is independently throttled, so this stays a cheap local read.)
  useWireScopes((scopes) => {
    if (user?.pubkey && scopes.has("dm")) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

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
    const byPeer = new Map<string, { peer: string; latest: NostrRumor; mine: boolean }>();
    for (const event of query.data ?? []) {
      const peer = dmCounterparty(event, self);
      if (!peer || mutedPubkeys.has(peer)) continue;
      const sent = event.pubkey === self;
      const existing = byPeer.get(peer);
      if (!existing) {
        byPeer.set(peer, { peer, latest: event, mine: sent });
      } else {
        if (event.created_at > existing.latest.created_at) existing.latest = event;
        if (sent) existing.mine = true;
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
    queryKey: ["dm", "previews", self, previewKey, consent],
    enabled: decryptPreviews && !!self && !!user?.signer.nip04 && conversations.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const nip04 = user!.signer.nip04!;
      const out: Record<string, string> = {};

      // Consent gate: one decrypt per conversation would fan out across the
      // whole list on entry. Only the previews that aren't already cached could
      // poke the signer, so gate on those; a decline leaves previews blank
      // (the list renders an "Encrypted message" placeholder) until the user
      // opts in.
      const targets = conversations.map(({ peer, latest }) => ({
        counterparty: peer,
        ciphertext: latest.content,
      }));
      if (!(await mayBulkDecrypt(user!.signer, "nip04", targets, signerNeedsApproval(user!.method)))) return out;

      // Decrypt every conversation's latest message concurrently — the previews
      // don't depend on each other and the signer handles overlapping calls.
      await Promise.all(
        conversations.map(async ({ peer, latest }) => {
          try {
            out[peer] = await decryptCached(peer, latest, (cp, ct) => nip04.decrypt(cp, ct));
          } catch (err) {
            console.warn("DM preview decrypt failed", { peer, id: latest.id, err });
          }
        }),
      );
      return out;
    },
  });

  return {
    conversations,
    previews: previews.data ?? {},
    /** All fetched kind-4 ciphertext events (both directions), newest-first.
     *  Exposed so the conversation list can search across locally-decrypted
     *  history (pairing each event with its render-cache plaintext). */
    events: query.data ?? [],
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
 * conversation (kind-4 or NIP-17) is from the peer and newer than the thread's
 * last-read stamp. Drives the unread dot on the DMs button in the server rail.
 *
 * NIP-17 conversations are additionally narrowed to KNOWN peers (see
 * `useKnownDmPeers`), matching the kind-4 plane's relay-level friends-only
 * scoping — an unsolicited stranger's gift wrap must not light a dot for a
 * conversation the main list would never show. This is what keeps the request
 * tier from being an attention channel: a request is discovered by opening
 * DMs, never by the rail demanding it.
 */
export function useHasUnreadDMs(): boolean {
  const { user } = useCurrentUser();
  const { conversations } = useDMConversations();
  const { conversations: dm17Conversations } = useDm17Conversations();
  const { isKnown } = useKnownDmPeers();
  const { getLastRead } = useReadState();

  return useMemo(() => {
    if (!user) return false;
    if (
      conversations.some(
        (c) =>
          c.latest.pubkey !== user.pubkey &&
          c.latest.created_at > getLastRead(dmReadKey(c.peer)),
      )
    ) {
      return true;
    }
    return dm17Conversations.some(
      (c) =>
        isKnown(c.peer, c.mine) &&
        c.latest.author !== user.pubkey &&
        c.latest.createdAt > getLastRead(dmReadKey(c.peer)),
    );
  }, [user, conversations, dm17Conversations, isKnown, getLastRead]);
}

/**
 * Whether ONE conversation has unread messages, on the same terms as
 * {@link useHasUnreadDMs}: the peer sent the latest message and it is newer
 * than the thread's last-read stamp. Drives the dot on a DM pinned to the
 * community rail.
 *
 * The request-tier narrowing that hook applies to NIP-17 is deliberately
 * absent: a DM is only on the rail because the user put it there, which is a
 * stronger statement about the peer than following them, and a rail icon that
 * stayed dark for the one person the user singled out would be the bug.
 *
 * Both conversation queries are shared by key with the ones the rail already
 * mounts for its DMs button, so a rail full of DMs costs no extra fetching.
 */
export function useDmPeerUnread(peer: string | undefined): boolean {
  const { user } = useCurrentUser();
  const { conversations } = useDMConversations();
  const { conversations: dm17Conversations } = useDm17Conversations();
  const { getLastRead } = useReadState();

  return useMemo(() => {
    if (!user || !peer) return false;
    const lastRead = getLastRead(dmReadKey(peer));
    const kind4 = conversations.find((c) => c.peer === peer);
    if (kind4 && kind4.latest.pubkey !== user.pubkey && kind4.latest.created_at > lastRead) {
      return true;
    }
    const dm17 = dm17Conversations.find((c) => c.peer === peer);
    return Boolean(
      dm17 && dm17.latest.author !== user.pubkey && dm17.latest.createdAt > lastRead,
    );
  }, [user, peer, conversations, dm17Conversations, getLastRead]);
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
  const { consent, declined } = useDecryptConsent();
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
    () => ["dm", "thread", self, peer, relayKey, consent] as const,
    [self, peer, relayKey, consent],
  );
  // Last-known-good localStorage snapshot of this thread's newest decrypted
  // rows (plaintext at rest — same trust level as the signer's persistent
  // decrypt cache; see timelineSnapshot.ts).
  const threadSnapshotScope = self && peer ? dmThreadSnapshotScope(self, peer) : undefined;
  const threadPullRef = useRef(0);
  // An empty first store read is not authoritative until the initial relay
  // pull settles. Track that pull itself instead of a sticky "done" bit: a
  // cached empty React Query result can be fresh on remount, in which case no
  // queryFn runs and a reset done-bit would leave the skeleton up forever.
  const [waitingForInitialPull, setWaitingForInitialPull] = useState(false);
  useEffect(() => {
    threadPullRef.current = 0;
    setWaitingForInitialPull(false);
  }, [self, peer, relayKey]);

  const query = useQuery<DecryptedDM[]>({
    queryKey,
    // The queryFn returns on the store read and leaves the relay pull running
    // behind it, so this is a store read and takes the store-read policy: no
    // retry ladder held at `isPending` over on-disk history (see storeQuery).
    ...STORE_READ,
    enabled: !!self && !!peer && !!user?.signer.nip04,
    queryFn: async ({ signal }) => {
      const nip04 = user!.signer.nip04!;
      const store = await eventStore;

      // 1. LOCAL-FIRST: read this thread's kind-4 set from the shared store
      //    (fed by the wire; mirrored pulls land there too), narrow to this
      //    peer, and return placeholders IMMEDIATELY so the thread structure
      //    paints on the first frame. Decryption of the newest screenful
      //    streams in via the plaintext cache. Both directions carry an
      //    `authors` filter (self for sent, the peer for received) so a thread
      //    never pulls in a stranger's kind-4 events.
      const localEvents = await store.query([
        { kinds: [KIND_DM], authors: [self!], "#p": [peer!], limit: 1000 },
        { kinds: [KIND_DM], authors: [peer!], "#p": [self!], limit: 1000 },
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
          (targets) => mayBulkDecrypt(user!.signer, "nip04", targets, signerNeedsApproval(user!.method)),
          () => { if (signerNeedsApproval(user!.method)) setDecryptConsent("declined"); },
        );
      }

      // 2. THROTTLED BACKGROUND refresh: query the relays for newer DMs, merge
      //    into the cache, stream their decrypts in. NOT awaited; skipped
      //    within the pull window so wire-bus invalidations stay local-only.
      //    The waiting flag is raised only for a cold empty read with a pull
      //    actually in flight; a throttle-skipped/cached empty read is settled.
      const pullDue = Date.now() - threadPullRef.current >= PULL_MIN_INTERVAL_MS;
      if (pullDue) threadPullRef.current = Date.now();
      if (pullDue && localPlaceholders.length === 0 && !signal.aborted) {
        setWaitingForInitialPull(true);
      }
      void (async () => {
        if (!pullDue || signal.aborted) return;
        try {
          // Recipient-scoped both ways (relays only serve the viewer's own
          // kind-4 set): sent = `authors:[self] #p:[peer]`, received =
          // `authors:[peer] #p:[self]`. The `authors` constraint keeps the query
          // to this one conversation and never pulls a stranger's DMs.
          const events = await queryRelaysMerged(
            nostr,
            relays,
            [
              { kinds: [KIND_DM], authors: [self!], "#p": [peer!], limit: 1000 },
              { kinds: [KIND_DM], authors: [peer!], "#p": [self!], limit: 1000 },
            ],
            AbortSignal.any([signal, AbortSignal.timeout(8000)]),
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
            (targets) => mayBulkDecrypt(user!.signer, "nip04", targets, signerNeedsApproval(user!.method)),
            () => { if (signerNeedsApproval(user!.method)) setDecryptConsent("declined"); },
          );
        } catch {
          // Best-effort background refresh; the local-first result already rendered.
        } finally {
          setWaitingForInitialPull(false);
        }
      })();

      return localPlaceholders;
    },
    staleTime: 10_000,
    // Seed with the last visit's decrypted screenful from the localStorage
    // snapshot — a pure first-paint read cache. The snapshot rows also prime
    // the plaintext render memo, so the queryFn's placeholder build keeps them
    // decrypted (mergeDmThread never downgrades a decrypted row) and
    // `decryptVisible` short-circuits instead of re-asking the signer.
    initialData: () => {
      const rows = readTimelineSnapshot<DecryptedDM>(threadSnapshotScope);
      if (rows) for (const r of rows) setRenderedPlaintext(r.id, r.content);
      return rows;
    },
    initialDataUpdatedAt: 0,
    // Backstop the live socket (see the conversations query above): heal a
    // wedged mobile WebSocket with a periodic local-first re-read, and catch up
    // on focus/reconnect.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // Keep the thread snapshot fresh with the newest DECRYPTED rows — encrypted
  // placeholders are useless to persist, and a transient "sending"/"failed"
  // badge must not be frozen into the next launch's first paint.
  const threadSnapshotItems = useMemo(() => {
    if (!query.data) return undefined;
    const rows = query.data
      .filter((m) => !m.encrypted && !m.status)
      .map(({ id, pubkey, created_at, content }) => ({ id, pubkey, created_at, content }));
    return rows.length > 0 ? rows : undefined;
  }, [query.data]);
  useTimelineSnapshotWriter(threadSnapshotScope, threadSnapshotItems);

  // The wire funnels this thread's kind-4s into the store; re-read on change.
  // (The queryFn decrypts the newest rows and its pull is throttled.)
  useWireScopes((scopes) => {
    if (self && peer && scopes.has("dm")) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

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
      const events = await queryRelaysMerged(
        nostr,
        relays,
        [
          { kinds: [KIND_DM], authors: [self], "#p": [peer], until, limit: 500 },
          { kinds: [KIND_DM], authors: [peer], "#p": [self], until, limit: 500 },
        ],
        AbortSignal.timeout(8000),
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
        // The content-blind push server also observes our own relay echo. Mark
        // it before publish so this browser never presents an outgoing legacy
        // DM as a new incoming message.
        await markOwnWebPushEvent(event.id);
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
            // Pinned for the row's whole life, including across the id swap
            // below, so signing doesn't remount the row.
            renderKey: tempId,
            pubkey: self,
            created_at: createdAt,
            content: trimmed,
            status: "sending" as const,
          },
        ].sort((a, b) => a.created_at - b.created_at),
      );
      // NOTE: deliberately do NOT invalidate the conversation-list query here.
      // The optimistic thread render already shows the message, and invalidating
      // would trigger a refetch + re-decrypt of every conversation's preview for
      // no visible benefit; the conversation list re-orders on its next natural
      // refetch / live event.

      // Encrypt + sign, then render the real id and publish in the background.
      try {
        const content = await signer.nip04!.encrypt(peer, trimmed);
        const event = await signer.signEvent({
          kind: KIND_DM,
          content,
          tags: [["p", peer]],
          created_at: createdAt,
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
        setRenderedPlaintext(event.id, trimmed);

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
      setMessageStatus(id, "sending");

      void (async () => {
        try {
          // Re-encrypt + re-sign, same as send.
          const content = await signer.nip04!.encrypt(peer, failed.content);
          const event = await signer.signEvent({
            kind: KIND_DM,
            content,
            tags: [["p", peer]],
            created_at: failed.created_at,
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
   * concurrent calls for the same id share one signer round-trip (render-memo
   * in-flight dedup).
   */
  const decryptVisible = useCallback(
    (id: string) => {
      if (!self || !peer || !user?.signer.nip04) return;
      if (hasRenderedPlaintext(id)) {
        // Already decrypted this session — just make sure the row reflects it.
        const content = getRenderedPlaintext(id)!;
        queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
          old.map((m) => (m.id === id && m.encrypted ? { ...m, content, encrypted: false } : m)),
        );
        return;
      }
      // Consent declined: never auto-decrypt on scroll — that would turn
      // scrolling into the very storm the gate exists to prevent. The row stays
      // a placeholder with its own "Decrypt" button (`decryptOne`).
      if (declined) return;
      const nip04 = user.signer.nip04;
      void (async () => {
        const store = await eventStore;
        const [event] = await store.query([{ ids: [id] }]);
        if (!event) return;
        const counterparty = event.pubkey === self ? peer : event.pubkey;
        try {
          const content = await decryptCached(counterparty, event, (cp, ct) => nip04.decrypt(cp, ct));
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            old.map((m) => (m.id === id ? { ...m, content, encrypted: false } : m)),
          );
        } catch {
          // Leave it as a placeholder; it'll retry next time it enters view.
        }
      })();
    },
    [self, peer, user?.signer.nip04, eventStore, queryClient, queryKey, declined],
  );

  /**
   * Explicitly decrypt ONE message on the user's request (the per-message
   * "Decrypt" button shown when consent was declined). This is a direct user
   * action, so it bypasses the consent gate and touches the signer for exactly
   * that message — no bulk fan-out.
   */
  const decryptOne = useCallback(
    (id: string) => {
      if (!self || !peer || !user?.signer.nip04) return;
      const nip04 = user.signer.nip04;
      void (async () => {
        const store = await eventStore;
        const [event] = await store.query([{ ids: [id] }]);
        if (!event) return;
        const counterparty = event.pubkey === self ? peer : event.pubkey;
        try {
          const content = await decryptCached(counterparty, event, (cp, ct) => nip04.decrypt(cp, ct));
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            old.map((m) => (m.id === id ? { ...m, content, encrypted: false } : m)),
          );
        } catch {
          // Leave it as a placeholder; the button stays available to retry.
        }
      })();
    },
    [self, peer, user?.signer.nip04, eventStore, queryClient, queryKey],
  );

  /**
   * Explicitly decrypt EVERY still-encrypted message in the thread (the
   * "Decrypt all" banner shown when consent was declined). A direct user action:
   * it bypasses the gate and — since the user has asked for it here — flips the
   * global consent to allowed so future threads decrypt without re-asking.
   */
  const decryptAll = useCallback(() => {
    if (!self || !peer || !user?.signer.nip04) return;
    const nip04 = user.signer.nip04;
    setDecryptConsent("allowed");
    void (async () => {
      const store = await eventStore;
      const rows = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
      const encryptedIds = rows.filter((m) => m.encrypted).map((m) => m.id);
      if (encryptedIds.length === 0) return;
      const events = await store.query([{ ids: encryptedIds }]);
      let ok = 0;
      await Promise.all(
        events.map(async (event) => {
          const counterparty = event.pubkey === self ? peer : event.pubkey;
          try {
            const content = await decryptCached(counterparty, event, (cp, ct) => nip04.decrypt(cp, ct));
            patchRow(queryClient, queryKey, {
              id: event.id,
              pubkey: event.pubkey,
              created_at: event.created_at,
              content,
            });
            ok++;
          } catch {
            // Skip; the row stays a placeholder with its own button.
          }
        }),
      );
      // The signer refused everything (e.g. "never ask again → reject"): undo
      // the optimistic "allowed" so the banner and per-message buttons return
      // instead of the thread silently sitting on skeletons.
      if (events.length > 0 && ok === 0 && signerNeedsApproval(user!.method)) setDecryptConsent("declined");
    })();
  }, [self, peer, user, eventStore, queryClient, queryKey]);

  return {
    messages: query.data ?? [],
    // The skeleton stands for the LOCAL read and nothing else: the queryFn
    // resolves on the store read and leaves the relay pull running behind it,
    // so this clears as soon as there is something on disk to paint.
    isLoading: query.isLoading,
    // …and the pull it left running is reported separately, so an empty thread
    // says "Catching up…" instead of a premature "No messages yet".
    syncing: isEmptyThreadAwaitingPull(query.data?.length ?? 0, waitingForInitialPull),
    error: query.error,
    send: send.mutateAsync,
    isSending: send.isPending,
    retry,
    loadOlder,
    hasMore,
    isLoadingOlder,
    decryptVisible,
    /** Explicitly decrypt one message (the per-message "Decrypt" button). */
    decryptOne,
    /** Explicitly decrypt every encrypted row + grant consent ("Decrypt all"). */
    decryptAll,
    /** Whether the user declined bulk decryption (drives the manual controls). */
    decryptDeclined: declined,
    /** Whether any rendered row is still an encrypted placeholder. */
    hasEncrypted: (query.data ?? []).some((m) => m.encrypted),
  };
}
