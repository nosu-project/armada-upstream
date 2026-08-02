/**
 * Concord V2 channel history sync — the `c2:` sync-topic handler.
 *
 * The wire delivers LIVE wraps to the rumor store; this module owns the pull
 * side: history the wire's `since` window never covered (cold opens, offline
 * gaps), fetched as a three-pass relay round and decrypted into the rumor
 * store. It used to live inside `useChannel2`'s queryFn, throttled by a
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
import { openChatBatch } from "@/concord-v2/lib/chat";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { whenAuthSettled } from "@/concord-v2/lib/planeSync";
import {
  clearChannelExhausted,
  readChannelCursor,
  updateChannelCursor,
  writeRumors,
} from "@/concord-v2/lib/rumorStore";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
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

function channelFilter(channel: ChannelV2, extra?: Partial<NostrFilter>): NostrFilter {
  return { kinds: [KIND_WRAP], authors: channel.streams.map((s) => s.group.pk), ...extra };
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
          // Per-relay auth gate (see syncChannelRound): each relay's page
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
        // run; a later round retries it.
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
  // all-empty run like a failure so a later round retries it.
  const reachedBottom = active.length === 0 && !failed;
  const exhausted = reachedBottom && collected.length > 0;
  return { oldest, newest, events: collected, exhausted, failed: failed || (reachedBottom && collected.length === 0) };
}

/** What a round needs beyond the topic string. Registered by the live view. */
export interface ChannelSyncContext {
  nostr: NostrLike;
  community: CommunityV2;
  channel: ChannelV2;
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

    // Pass 1: the newest page (no `until`), decrypted and committed first —
    // it's what the viewer sees on open, so it must not wait behind the deep
    // history passes. The awaited write rings the bus, and the timeline
    // re-reads.
    const newest = await backfillStore(nostr, community.relays, channel, signal, {
      maxPages: 1,
      beforeRelay: authGate,
    });
    if (signal.aborted) return;
    const firstOpened = await openChatBatch(newest.events, channel, { signal });
    if (signal.aborted) return;
    await writeRumors(community.idHex, firstOpened);
    synced += firstOpened.length;
    tick();

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
      bridge = await backfillStore(nostr, community.relays, channel, signal, {
        until: newest.oldest - 1,
        since: saved.newest,
        beforeRelay: authGate,
      });
      if (signal.aborted) return;
    }

    // Pass 3: page OLDER history back-to-back. Resume from the saved cursor
    // if we have one; otherwise (cold channel) resume from just below pass
    // 1's newest page rather than re-fetching that page.
    const resumeFrom = saved?.oldest ?? (newest.oldest !== undefined ? newest.oldest - 1 : undefined);
    const older = await backfillStore(nostr, community.relays, channel, signal, {
      until: resumeFrom,
      beforeRelay: authGate,
    });
    if (signal.aborted) return;

    const opened = await openChatBatch([...bridge.events, ...older.events], channel, { signal });
    if (signal.aborted) return;
    await writeRumors(community.idHex, opened);
    synced += opened.length;
    tick();

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

    // Ring once the CURSOR has landed, and even when nothing decrypted:
    // `writeRumors` rings only for a non-empty batch, and it ran before this
    // write — so a round that only learned "no deeper history" (or learned it
    // after the last rumor was announced) would otherwise leave an
    // already-rendered timeline showing a stale scroll-up affordance until
    // some unrelated event rang the scope.
    emitWireScopes([`c2:${idHex}`]);

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
