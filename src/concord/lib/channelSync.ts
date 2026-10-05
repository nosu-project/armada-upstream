/**
 * Concord channel history sync — the `c2:` sync-topic handler. The wire delivers
 * LIVE wraps; this pulls history the wire's `since` window never covered (cold
 * opens, offline gaps) as a three-pass relay round into the rumor store. The sync
 * scheduler decides WHEN; this module only knows HOW.
 *
 * A round needs context the topic string can't carry (pool, relays, stream keys),
 * registered first via {@link setChannelSyncContext}; a run without it fails loudly
 * so the scheduler retries. Results reach the UI via `writeRumors`' bus ring.
 */
import { openChatBatch } from "@/concord/lib/chat";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { notePlaneWrapsSeen, unseenPlaneWraps, whenAuthSettled } from "@/concord/lib/planeSync";
import {
  clearStreamExhausted,
  readStreamCursor,
  updateStreamCursor,
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
 * Older-history pages per round; the saved cursor resumes the rest later or on
 * `loadOlder`.
 */
const BACKFILL_MAX_PAGES = 20;
/** Pages per `loadOlder` scroll-up when the local store is exhausted. */
export const LOAD_OLDER_MAX_PAGES = 6;

/**
 * Floor between two rounds for one channel, and the freshness stamp's max age
 * for a standing view. Durable in KV, so a quick switch-and-back is a store read.
 */
export const CHANNEL_SYNC_MIN_INTERVAL_MS = 30_000;
export const CHANNEL_SYNC_STALE_AFTER_MS = 5 * 60_000;

/**
 * The relay filter for one channel page — ONE filter, so the single per-relay
 * `until` cursor stays a sound frontier.
 *
 * `authors` is the only unforgeable relay-side dimension. Retired streams are
 * asked for until history is verifiably swept to the bottom, then
 * (`freezeRetired`) dropped entirely; the local store is the archive from then on
 * (CORD-03 §3). Not split into a live + `until`-capped retired filter: two
 * filters sharing one cursor would skip the newer filter's unread region.
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
 * Backfill wraps with `until` pagination and per-relay cursors (a relay ignoring
 * `until` is culled after one non-progressing page). Returns oldest/newest
 * `created_at`, collected wraps, whether history is exhausted, and whether any
 * relay FAILED — failure must never count as exhaustion or advance a cursor past
 * the failed region. `since` bounds a pass from below (the bridge pass).
 *
 * Kind-1059 wraps are never mirrored into `armada-events`
 * (`NostrBatcher.cacheEvents` drops gift wraps); only decrypted rumors persist.
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
    /** Consume each page's wraps as it lands (so the timeline paints progressively) instead of accumulating. */
    onPage?: (events: NostrEvent[]) => Promise<void>;
    /**
     * After each page, the timestamp down to which EVERY still-paging relay has been
     * read. Not called once any relay has failed.
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
          // Per-relay auth gate: each relay waits only for ITS OWN stream AUTHs.
          await opts.beforeRelay?.(relay.url);
          if (pageSignal.aborted) return { relay, events: [] as NostrEvent[], ok: false };
          const events = await nostr
            .relay(relay.url)
            .query(filters, {
              signal: AbortSignal.any([pageSignal, AbortSignal.timeout(8000)]),
            });
          // Only a relay that HAS events starts the race clock; an instant empty EOSE must
          // not abort relays still mid-AUTH.
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
        // This relay's region was NOT read: block exhaustion/cursor advancement; retry later.
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
      // Hand over each page as it lands; memory stays one page.
      if (pageEvents.length > 0) await opts.onPage(pageEvents);
    } else {
      collected.push(...pageEvents);
    }
    active = next;
    if (opts.onProgress && !failed && next.length > 0 && !signal.aborted) {
      await opts.onProgress(Math.max(...next.map((relay) => (relay.cursor ?? 0) + 1)));
    }
  }
  // `exhausted` = verifiably reached the bottom after seeing history. An all-empty
  // run is INCONCLUSIVE (pre-AUTH empty answers, stale cursor) and must not seal
  // the channel, so it's treated as a failure.
  const reachedBottom = active.length === 0 && !failed;
  const exhausted = reachedBottom && count > 0;
  return { oldest, newest, events: collected, count, exhausted, failed: failed || (reachedBottom && count === 0) };
}

/** Floor between two bus rings from one round's older-history pages. */
const OLDER_RING_MS = 1_500;

interface ThrottledRing {
  /** Rings now if the floor has passed, else once it does. */
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
 * Channels whose last round fetched wraps but decrypted none (a stranded invite,
 * an un-adopted rekey), so the timeline doesn't present "No messages yet" as a
 * verdict. In-memory; cleared once any round decrypts something.
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
 * an older mount's teardown never clobbers a newer registration.
 */
export function setChannelSyncContext(channelIdHex: string, ctx: ChannelSyncContext): () => void {
  contexts.set(channelIdHex, ctx);
  return () => {
    if (contexts.get(channelIdHex) === ctx) contexts.delete(channelIdHex);
  };
}

/**
 * One catch-up round: the newest page first (painted immediately), then the
 * BRIDGE between the saved cursor's `newest` and that page (else an offline burst
 * leaves a permanent hole), then bounded older paging from the saved `oldest`.
 */
async function syncChannelRound(ctx: ChannelSyncContext, signal: AbortSignal): Promise<void> {
  const { nostr, community, channel } = ctx;
  const idHex = channel.idHex;
  // Scoped `c2:<id>` so the chat view can tell its own catch-up from other sync.
  const task = beginSyncTask(`#${channel.name}`, { scope: `c2:${idHex}` });
  try {
    // Heal a POISONED cursor: `exhausted` with `oldest === 0` was sealed by an
    // all-empty run and never paged; clear it so history gets pulled.
    let saved = await readStreamCursor(idHex);
    if (saved?.exhausted && !saved.oldest) {
      saved = { ...saved, exhausted: false };
      void clearStreamExhausted(idHex);
    }

    // Retired-epoch freeze: once history reached bottom, retired stream addresses
    // leave every REQ (an ejected keyholder can sign wraps there forever). A rekey
    // adoption clears `exhausted`, so each newly retired epoch gets one final sweep.
    const freezeRetired = Boolean(saved?.exhausted);

    // Hold each relay's pages until THAT relay ACKs our stream AUTHs: a kind-1059
    // REQ racing NIP-42 gets CLOSED and reads as empty.
    const authGate = (url: string) => whenAuthSettled(url, () => channel.streams.map((s) => s.group));
    let synced = 0;
    const tick = () => {
      if (synced > 0) task.update({ detail: `${synced} ${synced === 1 ? "message" : "messages"}` });
    };
    // Decrypt + commit per page (each write rings the bus). A page that failed to
    // commit must never be covered by a saved cursor.
    let writeFailed = false;
    const writePage = async (events: NostrEvent[], ring?: ThrottledRing) => {
      if (signal.aborted) return;
      // Skip wraps whose rumors are already stored (the wire's persisted memo).
      const fresh = await unseenPlaneWraps(events);
      if (fresh.length === 0 || signal.aborted) return;
      const opened = await openChatBatch(fresh, channel, { signal });
      if (opened.length === 0) return;
      const stored = await writeRumors(community.idHex, opened, { ring: !ring });
      if (stored) {
        ring?.ring();
        // Only wraps that OPENED: a failed one may be readable with a later key.
        notePlaneWrapsSeen(opened.flatMap((o) => o.wrapId ?? []));
      } else writeFailed = true;
      synced += opened.length;
      tick();
    };

    // Pass 1: the newest page, committed first — it's what the viewer sees.
    const newest = await backfillStore(nostr, community.relays, channel, signal, {
      maxPages: 1,
      freezeRetired,
      beforeRelay: authGate,
      onPage: writePage,
    });
    if (signal.aborted) return;

    // Pass 2 (the bridge): the region between the saved `newest` and pass 1's oldest.
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

    // Pass 3: older history, from the saved cursor or just below pass 1. `oldest` is
    // saved page by page (`onProgress`), since leaving the channel aborts the round.
    // Rings are throttled to OLDER_RING_MS: these pages are off-screen and every
    // ring re-runs community-wide readers.
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
          if (!writeFailed) await updateStreamCursor(idHex, { oldest: coveredDownTo });
        },
      });
    } finally {
      olderRing.flush();
    }
    if (signal.aborted) return;

    // The cursor merge is monotonic. `newest` advances ONLY when the newest region
    // is verifiably complete (no pass-1 failures, bridge exhausted).
    const complete = !newest.failed && bridge.exhausted;
    const top = Math.max(newest.newest ?? 0, bridge.newest ?? 0);
    await updateStreamCursor(idHex, {
      newest: complete && top > 0 ? top : undefined,
      oldest: older.oldest,
      exhausted: older.exhausted ? true : undefined,
    });

    // A round that pulled wraps and opened none marks a decode dead end; any opened
    // rumor clears it.
    const fetched = newest.count + bridge.count + older.count;
    if (synced > 0) decodeDeadEnds.delete(idHex);
    else if (fetched > 0) decodeDeadEnds.add(idHex);

    // Ring once the cursor lands, even with nothing decrypted, so a stale scroll-up
    // affordance updates. On `c2cur:`, not `c2:`: only the timeline reads the
    // cursor, and `c2:` would re-run every community-wide reader.
    emitWireScopes([`c2cur:${idHex}`]);

    // Total failure with nothing decrypted: throw so the scheduler retries rather
    // than stamping a likely-wedged topic fresh.
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
    // A missing context is an ordering bug (it's registered before the want).
    if (!ctx) throw new Error(`no channel sync context for ${topic}`);
    await syncChannelRound(ctx, signal);
  },
});
