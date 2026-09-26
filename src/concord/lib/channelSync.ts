/**
 * Concord channel history sync — the `c2:` sync-topic handler.
 *
 * The wire delivers LIVE wraps to the rumor store; this module owns the pull
 * side: history the wire's `since` window never covered (cold opens, offline
 * gaps), fetched as a three-pass relay round and decrypted into the rumor
 * store. It used to live inside `useChannel`'s queryFn, throttled by a
 * per-mount ref that reset on every channel switch — so channel-hopping
 * re-paged every relay each time. The sync scheduler now decides WHEN a round
 * runs (durable freshness stamp, min-interval, priority lanes); this module
 * only knows HOW.
 *
 * The handler is registered per topic-key prefix, but a round needs what the
 * topic string can't carry — the pool handle, the community's relays, the
 * channel's stream keys. The hook that wants `c2:<idHex>` registers that
 * context first ({@link setChannelSyncContext}); a run without context is an
 * ordering bug and fails loudly so the scheduler retries rather than stamping
 * the topic fresh.
 *
 * Results reach the UI the way every store write does: `writeRumors` rings
 * the wire bus once the batch commits, and the timeline re-reads. Nothing
 * here touches the query cache.
 */
import { openChatBatch } from "@/concord/lib/chat";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { whenAuthSettled } from "@/concord/lib/planeSync";
import {
  clearChannelExhausted,
  readChannelCursor,
  updateChannelCursor,
  writeRumors,
} from "@/concord/lib/rumorStore";
import type { Channel, Community } from "@/concord/lib/types";
import { beginSyncTask } from "@/lib/syncActivity";
import { registerSyncTopic } from "@/sync/syncManager";
import { emitWireScopes } from "@/wire/bus";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable Nostr client the round needs (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** Relay backfill page size. */
const BACKFILL_PAGE = 50;
/** EOSE race grace once the fastest relay returns a page. */
const BACKFILL_EOSE_GRACE_MS = 500;
/**
 * Older-history pages walked back-to-back in one round. Bounded so a huge
 * channel can't page relays forever in one go — the saved cursor resumes any
 * remainder on later rounds or on an explicit `loadOlder`.
 */
const BACKFILL_MAX_PAGES = 20;
/** Pages per `loadOlder` scroll-up when the local store is exhausted. */
export const LOAD_OLDER_MAX_PAGES = 6;

/**
 * Floor between two rounds for one channel, and how old the freshness stamp
 * may get before a standing view re-runs one (the old 5-min refetchInterval).
 * Durable in KV, so a channel switch-and-back inside the floor is a pure
 * store read — the per-mount throttle this replaces re-paged every relay.
 */
export const CHANNEL_SYNC_MIN_INTERVAL_MS = 30_000;
export const CHANNEL_SYNC_STALE_AFTER_MS = 5 * 60_000;

/**
 * The relay filter for one channel page — ONE filter, so the caller's single
 * per-relay `until` cursor stays a sound frontier.
 *
 * `authors` is the only relay-side dimension an adversary can't forge (the
 * wrap must be signed by the stream key), so it is the whole control surface:
 * a retired stream is asked for until this channel's history has verifiably
 * been swept to the bottom, and from then on (`freezeRetired`) its address
 * leaves the author set entirely — never asked for again, whatever timestamps
 * are pumped at it. The local store is the archive from that point, which is
 * what keeps CORD-03 §3's continuity across a rekey satisfied from disk.
 *
 * Deliberately NOT split into a live filter plus an `until`-capped retired
 * one. Capping retired streams at their cutoff only trims spam lazy enough
 * not to backdate (the decode/fold cutoffs are what actually refuse content),
 * and it costs correctness: two filters share one cursor here, so when both
 * return a full page the frontier jumps to the older filter's floor and the
 * newer filter's unread region is skipped and then persisted as covered.
 */
export function channelFilters(
  channel: Channel,
  opts: { limit: number; cursor?: number; since?: number; freezeRetired?: boolean },
): NostrFilter[] {
  const authors: string[] = [];
  for (const s of channel.streams) {
    if (s.retiredAt !== undefined && opts.freezeRetired) continue;
    authors.push(s.group.pk);
  }
  if (authors.length === 0) return [];
  const f: NostrFilter = { kinds: [KIND_WRAP], authors, limit: opts.limit };
  if (opts.cursor !== undefined) f.until = opts.cursor;
  if (opts.since !== undefined) f.since = opts.since;
  return [f];
}

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
export async function backfillStore(
  nostr: NostrLike,
  relays: string[],
  channel: Channel,
  signal: AbortSignal,
  opts: {
    until?: number;
    since?: number;
    maxPages?: number;
    freezeRetired?: boolean;
    beforeRelay?: (url: string) => Promise<void>;
    /**
     * Consume each page's wraps as it lands instead of accumulating them into
     * the returned `events`. A multi-page round over slow relays can run for
     * minutes; with this, the caller decrypts/stores page by page and the
     * timeline paints as history arrives rather than after the whole round.
     */
    onPage?: (events: NostrEvent[]) => Promise<void>;
    /**
     * Called after each page (once its `onPage` has resolved) with the
     * timestamp down to which EVERY relay still paging has now been read —
     * the shallowest relay's frontier. Not called once any relay has failed:
     * a failed relay's region is unread, and only the end-of-round verdict
     * may decide what that means for the cursor.
     */
    onProgress?: (coveredDownTo: number) => Promise<void>;
  } = {},
): Promise<{ oldest?: number; newest?: number; events: NostrEvent[]; count: number; exhausted: boolean; failed: boolean }> {
  const maxPages = opts.maxPages ?? BACKFILL_MAX_PAGES;
  let oldest: number | undefined;
  let newest: number | undefined;
  let active = relays.map((url) => ({ url, cursor: opts.until }));
  const collected: NostrEvent[] = [];
  let count = 0;
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
        const filters = channelFilters(channel, {
          limit: BACKFILL_PAGE,
          cursor: relay.cursor,
          since: opts.since,
          freezeRetired: opts.freezeRetired,
        });
        if (filters.length === 0) return { relay, events: [] as NostrEvent[], ok: true };
        try {
          // Per-relay auth gate (see syncChannelRound): each relay's page
          // waits only for ITS OWN stream AUTHs to settle, never for the
          // slowest relay's cap.
          await opts.beforeRelay?.(relay.url);
          if (pageSignal.aborted) return { relay, events: [] as NostrEvent[], ok: false };
          const events = await nostr
            .relay(relay.url)
            .query(filters, {
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
    const pageEvents: NostrEvent[] = [];
    for (const { relay, events, ok } of results) {
      if (!ok) {
        // Error or aborted — this relay's region was NOT read. Track the
        // failure (blocks exhaustion/cursor advancement) and drop it for this
        // run; a later round retries it.
        failed = true;
        continue;
      }
      pageEvents.push(...events);
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
    count += pageEvents.length;
    if (opts.onPage) {
      // Hand the page over as it lands (the caller stores it); nothing is
      // retained here, so a deep round's memory stays one page.
      if (pageEvents.length > 0) await opts.onPage(pageEvents);
    } else {
      collected.push(...pageEvents);
    }
    active = next;
    if (opts.onProgress && !failed && next.length > 0 && !signal.aborted) {
      await opts.onProgress(Math.max(...next.map((relay) => (relay.cursor ?? 0) + 1)));
    }
  }
  // `exhausted` means we verifiably reached the bottom: every relay ran to a
  // short/empty page AFTER we'd seen history. An all-empty run (no events
  // collected at all) is INCONCLUSIVE — a relay answering empty before NIP-42
  // AUTH completes, or a stale `until` cursor past the relay's data — and must
  // NOT seal the channel as exhausted, or a notification-only room (1 message,
  // no history yet) gets permanently stuck with just that message. Treat an
  // all-empty run like a failure so a later round retries it.
  const reachedBottom = active.length === 0 && !failed;
  const exhausted = reachedBottom && count > 0;
  return { oldest, newest, events: collected, count, exhausted, failed: failed || (reachedBottom && count === 0) };
}

/** Floor between two bus rings from one round's older-history pages. */
const OLDER_RING_MS = 1_500;

interface ThrottledRing {
  /** Note a write; rings now if the floor has passed, else once it does. */
  ring(): void;
  /** Ring now if a write is still unannounced. */
  flush(): void;
}

/** Ring `scope` on the wire bus at most once per `floorMs`, never dropping the last write. */
function throttledRing(scope: `c2:${string}`, floorMs: number): ThrottledRing {
  let last = 0;
  let owed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!owed) return;
    owed = false;
    last = Date.now();
    emitWireScopes([scope]);
  };
  return {
    ring() {
      owed = true;
      const wait = last + floorMs - Date.now();
      if (wait <= 0) fire();
      else timer ??= setTimeout(fire, wait);
    },
    flush: fire,
  };
}

/**
 * Channels whose LAST completed round fetched wraps but decrypted none — the
 * held stream keys can't open anything the relays return (a stranded invite, a
 * rekey this device hasn't caught up to). Without this, such a channel is
 * indistinguishable from a genuinely empty one: the round "succeeds" with zero
 * messages and the timeline renders "No messages yet" as a verdict. In-memory
 * only (a session-scoped diagnosis, re-derived by the next round); cleared the
 * moment any round decrypts something (e.g. after a rekey adoption re-runs the
 * topic with new keys).
 */
const decodeDeadEnds = new Set<string>();

/** Whether the channel's last sync round returned wraps none of which opened. */
export function channelDecodeDeadEnd(channelIdHex: string): boolean {
  return decodeDeadEnds.has(channelIdHex);
}

/** What a round needs beyond the topic string. Registered by the live view. */
export interface ChannelSyncContext {
  nostr: NostrLike;
  community: Community;
  channel: Channel;
}

const contexts = new Map<string, ChannelSyncContext>();

/**
 * Register the live context for `c2:<channelIdHex>` rounds. Returns a release;
 * a newer registration for the same channel is never clobbered by an older
 * mount's teardown.
 */
export function setChannelSyncContext(channelIdHex: string, ctx: ChannelSyncContext): () => void {
  contexts.set(channelIdHex, ctx);
  return () => {
    if (contexts.get(channelIdHex) === ctx) contexts.delete(channelIdHex);
  };
}

/**
 * One full catch-up round for a channel: newest page first (painted as soon as
 * its rumors commit), then the BRIDGE (the region between the saved cursor's
 * `newest` and the newest page — without it, an offline burst larger than one
 * page leaves a permanent hole; issue #19), then bounded older-history paging
 * resumed from the saved `oldest`.
 */
async function syncChannelRound(ctx: ChannelSyncContext, signal: AbortSignal): Promise<void> {
  const { nostr, community, channel } = ctx;
  const idHex = channel.idHex;
  // Report the round on the sync-activity signal, named after the channel
  // with a live decrypted-message count and scoped `c2:<id>` so the chat view
  // can tell "this room is catching up" from unrelated background sync.
  const task = beginSyncTask(`#${channel.name}`, { scope: `c2:${idHex}` });
  try {
    // Heal a POISONED cursor: `exhausted` with `oldest === 0` means it was
    // sealed without ever paging down (an all-empty backfill run — e.g. a
    // relay that answered empty before NIP-42 AUTH). Clearing `exhausted`
    // lets the round retry so a notification-only room finally pulls its
    // history instead of showing just the one delivered message.
    let saved = await readChannelCursor(idHex);
    if (saved?.exhausted && !saved.oldest) {
      saved = { ...saved, exhausted: false };
      void clearChannelExhausted(idHex);
    }

    // Retired-epoch freeze: once this channel's history has verifiably reached
    // bottom, retired stream addresses leave every REQ this round issues. An
    // ejected keyholder can sign wraps at those addresses forever (and forge
    // any timestamp) — the only spam-proof filter dimension is not asking. A
    // rekey adoption clears `exhausted` (see useChannelTimeline's epoch
    // effect), so each newly retired epoch still gets its one final sweep.
    const freezeRetired = Boolean(saved?.exhausted);

    // Hold each relay's pages until THAT relay has ACKED our stream AUTHs (if
    // it challenged) — a kind-1059 REQ racing NIP-42 gets CLOSED and reads
    // back as an empty page, which on a cold open paints "no messages" for a
    // channel that has plenty (the post-login empty-rooms bug). Gated PER
    // RELAY (backfillStore's beforeRelay): one unsettled relay must not hold
    // every relay's first page behind its full cap.
    const authGate = (url: string) => whenAuthSettled(url, () => channel.streams.map((s) => s.group));
    let synced = 0;
    const tick = () => {
      if (synced > 0) task.update({ detail: `${synced} ${synced === 1 ? "message" : "messages"}` });
    };
    // Decrypt + commit one fetched page. Every committed write rings the wire
    // bus (writeRumors), so the timeline re-reads and paints as each page
    // lands — a deep round over slow relays used to hold everything in memory
    // and write once at the very end, minutes after decryptable history was
    // already in hand.
    // A page that failed to commit must never be covered by a saved cursor.
    let writeFailed = false;
    const writePage = async (events: NostrEvent[], ring?: ThrottledRing) => {
      if (signal.aborted) return;
      const opened = await openChatBatch(events, channel, { signal });
      if (opened.length === 0) return;
      const stored = await writeRumors(community.idHex, opened, { ring: !ring });
      if (stored) ring?.ring();
      else writeFailed = true;
      synced += opened.length;
      tick();
    };

    // Pass 1: the newest page (no `until`), decrypted and committed first —
    // it's what the viewer sees on open, so it must not wait behind the deep
    // history passes. The awaited write rings the bus, and the timeline
    // re-reads.
    const newest = await backfillStore(nostr, community.relays, channel, signal, {
      maxPages: 1,
      freezeRetired,
      beforeRelay: authGate,
      onPage: writePage,
    });
    if (signal.aborted) return;

    // Pass 2 (the bridge): fetch the REGION BETWEEN the saved `newest` and
    // pass 1's oldest. Without it, an offline burst larger than one page
    // leaves a permanent hole — pass 3 resumes BELOW already-seen history
    // and the advanced cursor seals the gap forever (issue #19).
    let bridge: Awaited<ReturnType<typeof backfillStore>> = {
      events: [],
      count: 0,
      exhausted: true,
      failed: false,
    };
    if (saved?.newest && newest.oldest !== undefined && newest.oldest > saved.newest) {
      bridge = await backfillStore(nostr, community.relays, channel, signal, {
        until: newest.oldest - 1,
        since: saved.newest,
        freezeRetired,
        beforeRelay: authGate,
        onPage: writePage,
      });
      if (signal.aborted) return;
    }

    // Pass 3: page OLDER history back-to-back. Resume from the saved cursor
    // if we have one; otherwise (cold channel) resume from just below pass
    // 1's newest page rather than re-fetching that page.
    //
    // The saved `oldest` advances page by page (`onProgress`), not only when
    // the round completes. A round is aborted whenever the reader leaves the
    // channel, and an aborted round stamps nothing, so with the cursor saved
    // only at the end, every return to a channel with deep history re-paged —
    // and re-decrypted and re-wrote — the same twenty pages per relay, and
    // never got further while the reader kept moving.
    //
    // Its pages also ring the bus at most every OLDER_RING_MS rather than per
    // page: they land below anything on screen, and every ring re-runs each
    // community-wide reader (mentions, unread badges, threads) over the store.
    const resumeFrom = saved?.oldest ?? (newest.oldest !== undefined ? newest.oldest - 1 : undefined);
    const olderRing = throttledRing(`c2:${idHex}`, OLDER_RING_MS);
    let older: Awaited<ReturnType<typeof backfillStore>>;
    try {
      older = await backfillStore(nostr, community.relays, channel, signal, {
        until: resumeFrom,
        freezeRetired,
        beforeRelay: authGate,
        onPage: (events) => writePage(events, olderRing),
        onProgress: async (coveredDownTo) => {
          if (!writeFailed) await updateChannelCursor(idHex, { oldest: coveredDownTo });
        },
      });
    } finally {
      olderRing.flush();
    }
    if (signal.aborted) return;

    // Advance the persisted cursor (the store merge is monotonic: `newest`
    // only forward, `oldest` only back, `exhausted` sticky). `newest` moves
    // ONLY when the newest region is verifiably complete — pass 1 had no
    // relay failures and the bridge ran to exhaustion. An incomplete round
    // leaves `newest` where it was, so the next round re-bridges the same
    // region instead of sealing a hole.
    const complete = !newest.failed && bridge.exhausted;
    const top = Math.max(newest.newest ?? 0, bridge.newest ?? 0);
    await updateChannelCursor(idHex, {
      newest: complete && top > 0 ? top : undefined,
      oldest: older.oldest,
      exhausted: older.exhausted ? true : undefined,
    });

    // Keep the decode dead-end diagnosis current: a round that pulled wraps
    // and opened NONE of them means the held keys can't read this channel
    // right now (surfaced by the timeline's empty state); any opened rumor —
    // including pass 1's routine re-fetch of the newest page — clears it.
    const fetched = newest.count + bridge.count + older.count;
    if (synced > 0) decodeDeadEnds.delete(idHex);
    else if (fetched > 0) decodeDeadEnds.add(idHex);

    // Ring once the CURSOR has landed, and even when nothing decrypted:
    // `writeRumors` rings only for a non-empty batch, and it ran before this
    // write — so a round that only learned "no deeper history" (or learned it
    // after the last rumor was announced) would otherwise leave an
    // already-rendered timeline showing a stale scroll-up affordance until
    // some unrelated event rang the scope.
    //
    // On `c2cur:`, not `c2:`. Only the channel's own timeline reads the
    // cursor; the rumor store did not change here (writeRumors rang `c2:` for
    // anything that did). Ringing `c2:` re-ran every community-wide reader —
    // mentions, unread badges, threads, the members view — after every round,
    // i.e. on every channel open, for nothing.
    emitWireScopes([`c2cur:${idHex}`]);

    // A round that failed outright with nothing decrypted must not stamp the
    // topic fresh: the relays were likely wedged (a REQ swallowed by a
    // mid-flight NIP-42 handshake). Throw so the scheduler backs off briefly
    // and retries, instead of reading as a permanently empty room.
    if (synced === 0 && newest.failed && older.failed) {
      throw new Error("channel backfill reached no relay");
    }
  } finally {
    task.end();
  }
}

registerSyncTopic("c2:", {
  minIntervalMs: CHANNEL_SYNC_MIN_INTERVAL_MS,
  staleAfterMs: CHANNEL_SYNC_STALE_AFTER_MS,
  handler: async ({ topic, signal }) => {
    const ctx = contexts.get(topic.slice("c2:".length));
    // Context is registered before the want (same hook, earlier effect), so a
    // miss is an ordering bug — fail the run rather than stamping it fresh.
    if (!ctx) throw new Error(`no channel sync context for ${topic}`);
    await syncChannelRound(ctx, signal);
  },
});
