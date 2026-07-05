import { useNostr } from "@nostrify/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useConcordBanlist } from "@/concord-v1/hooks/useConcordModeration";
import { useConcordChannelEpochs } from "@/concord-v1/hooks/useConcordRekey";
import { useConcordRoster } from "@/concord-v1/hooks/useConcordRoster";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { useRotatorSecretKey } from "@/concord-v1/hooks/useRotatorSecretKey";
import { useSendStatusMap, useSendStatusMapValue, type SendStatus, type SendStatusMap } from "@/hooks/useSendStatusMap";
import { useTimelineSnapshotWriter } from "@/hooks/useTimelineSnapshot";
import { channelPseudonym } from "@/concord-v1/lib/derive";
import { channelWire, type ChannelWire } from "@/concord-v1/lib/wire";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import { concordSnapshotScope, readTimelineSnapshot } from "@/lib/timelineSnapshot";
import {
  openVerifiedInner,
  type OpenedMessage,
} from "@/concord-v1/lib/envelope";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_EDIT, KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_REACTION } from "@/concord-v1/lib/kinds";
import { canActOnMember, Permissions } from "@/concord-v1/lib/roles";
import type { Channel, Community } from "@/concord-v1/lib/types";

import { App as CapacitorApp } from "@capacitor/app";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Optimistic delivery status for a Concord message we sent, keyed by message id. */
export type ConcordSendStatus = SendStatus;
export type ConcordSendStatusMap = SendStatusMap;

/** Query key for a channel's decoded message list. */
function channelKey(channelIdHex: string | null) {
  return ["concord", "channel", channelIdHex] as const;
}

/** Query key for a channel's optimistic send-status map. */
function statusKey(channelIdHex: string | null) {
  return ["concord", "msg-status", channelIdHex] as const;
}

/**
 * Query key for a channel's optimistic-delete set: message ids the current user
 * has self-deleted locally, kept hidden until the relay echoes the delete back.
 */
function deletedKey(channelIdHex: string | null) {
  return ["concord", "msg-deleted", channelIdHex] as const;
}

/** The held epoch keys for a channel: every retained epoch, newest first. */
function readEpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The set of `#z` pseudonyms to subscribe/query for a v1 channel (one per held epoch). */
function channelPseudonyms(channel: Channel): string[] {
  return readEpochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

/** The append-plane kinds the message timeline folds (messages + edits + deletes). */
const MESSAGE_PLANE_KINDS = [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE, KIND_COMMUNITY_EDIT];

/** Moderation context the read path applies while folding. */
interface ModerationContext {
  /** Banned author pubkeys (hex): every event from them is dropped. */
  banned: Set<string>;
  /** Whether `deleter` is authorized to moderation-hide a message by `author`. */
  canHide: (deleter: string, author: string) => boolean;
}

/**
 * Fold a batch of ALREADY-OPENED Concord events into the channel timeline: drop
 * banned authors, apply edits (latest by ms, author-only) and deletes
 * (self-delete or authorized moderation-hide), and return the surviving
 * messages sorted by time plus the tombstone map (so a merge across fetches can
 * prune an already-known message whose author deleted it in THIS batch).
 *
 * Decoding (the expensive NIP-44 + verify) is done up front by the memoized
 * batch opener; this is the cheap, pure fold over the results.
 */
function foldOpened(
  opened: OpenedMessage[],
  moderation?: ModerationContext,
): { messages: OpenedMessage[]; deletes: Map<string, Set<string>> } {
  const byId = new Map<string, OpenedMessage>();
  // Tombstones: target message id → set of pubkeys that authored a delete for
  // it. A delete takes effect when authored by the message's OWN author
  // (cooperative self-delete) OR by an authorized moderator (moderation-hide).
  const deletes = new Map<string, Set<string>>();
  // Edits (3302): target id → newest {author, content, ms}. Applied only when
  // the edit's author IS the original message's author.
  const edits = new Map<string, { author: string; content: string; ms: number }>();
  for (const om of opened) {
    // Inbound ban enforcement: drop every event from a banned author.
    if (moderation?.banned.has(om.author)) continue;
    if (om.kind === KIND_COMMUNITY_DELETE) {
      const target = om.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      let authors = deletes.get(target);
      if (!authors) deletes.set(target, (authors = new Set()));
      authors.add(om.author);
      continue;
    }
    if (om.kind === KIND_COMMUNITY_EDIT) {
      const target = om.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      const prev = edits.get(target);
      if (!prev || om.ms > prev.ms) {
        edits.set(target, { author: om.author, content: om.content, ms: om.ms });
      }
      continue;
    }
    // Reactions are tallied elsewhere (useConcordReactions); keep them out of
    // the message timeline.
    if (om.kind === KIND_COMMUNITY_REACTION) continue;
    byId.set(om.messageId, om);
  }
  // Apply edits: only the original author may edit; latest edit (by ms) wins.
  for (const [id, edit] of edits) {
    const msg = byId.get(id);
    if (msg && edit.author === msg.author) {
      byId.set(id, { ...msg, content: edit.content });
    }
  }
  // Apply deletes: self-delete (author deleted their own) or an authorized
  // moderation-hide (a deleter who can act on the message's author).
  for (const [id, msg] of byId) {
    const deleters = deletes.get(id);
    if (!deleters) continue;
    const hidden =
      deleters.has(msg.author) ||
      (moderation && [...deleters].some((d) => moderation.canHide(d, msg.author)));
    if (hidden) byId.delete(id);
  }
  // Return the tombstone map too, so a merge across fetches can prune an
  // already-known message whose author published a delete in THIS batch.
  return { messages: [...byId.values()].sort((a, b) => a.ms - b.ms), deletes };
}

/**
 * Open + fold a batch of sealed outer events into the channel timeline. Decode
 * is memoized per wrapper id and chunked off the main thread (so re-reading the
 * append-only local store costs near-nothing after the first pass, and a large
 * first decode never freezes the UI); the surviving messages are then folded
 * (edits/deletes/bans applied) and returned sorted by time. Shared by the live
 * subscription, the network backfill, and the IndexedDB cache-first seed.
 */
async function openMessages(
  wire: ChannelWire,
  events: NostrEvent[],
  moderation?: ModerationContext,
  signal?: AbortSignal,
): Promise<{ messages: OpenedMessage[]; deletes: Map<string, Set<string>> }> {
  const opened = await wire.openBatch(events, { signal, kinds: MESSAGE_PLANE_KINDS });
  return foldOpened(opened, moderation);
}

/**
 * Read a channel's sealed blobs back from the append-only local event store and
 * fold them into the timeline. The store (NIndexedDB, `armada-events`) mirrors
 * every sealed outer the relays ever returned, so it is the complete local
 * source of truth — like Vector's SQLite. Reading + decoding from it (rather
 * than re-querying relays) is what makes a visited channel paint instantly and
 * survive offline; decode-once memoization makes repeat reads cheap.
 *
 * Bounded by `limit` (the newest N sealed blobs): a large channel must NOT
 * decrypt + verify its entire history before the first paint — that's what made
 * a big channel's loading skeleton hang. The `#z` tag index is walked
 * newest-first and stops at `limit`, so the cost scales with the visible window,
 * not the cache size. Scrolling up grows `limit` and re-reads. Returns whether
 * the store likely holds older blobs past this window (`hasMore`).
 */
async function readAndFold(
  store: { query: (filters: NostrFilter[]) => Promise<NostrEvent[]> },
  wire: ChannelWire,
  limit: number,
  moderation?: ModerationContext,
  signal?: AbortSignal,
): Promise<{ messages: OpenedMessage[]; deletes: Map<string, Set<string>>; hasMore: boolean }> {
  // Read the newest `limit` sealed blobs (messages + edits + deletes). The
  // planner walks the address index newest-first and stops at `limit`, so this
  // is cheap regardless of how much history the append-only store holds. Edits /
  // deletes for an in-window message are themselves recent (published after it),
  // so they fall inside the same newest window.
  //
  // The `kinds` constraint is REQUIRED: a channel's `#z` also carries
  // reactions (3301), typing, presence, and control events, which are far more
  // frequent than messages. Without `kinds`, the newest-`limit` window fills
  // with reactions and pushes actual messages out.
  const sealed = await store.query([wire.filter(MESSAGE_PLANE_KINDS, { limit })]);
  const hasMore = sealed.length >= limit;
  const folded = await openMessages(wire, sealed, moderation, signal);
  return { ...folded, hasMore };
}

/** A page size for relay backfill; the local store is unbounded, this just bounds each REQ. */
const BACKFILL_PAGE = 30;
/**
 * Grace (ms) after the FIRST relay returns a backfill page before the remaining
 * relays for that page are abandoned. NRelay1.query has no eoseTimeout, so this
 * is our per-page EOSE race (mirrors NPool's eoseTimeout): a fast relay caps the
 * wait on slow/aggregator relays instead of every page paying the 8s timeout.
 */
const BACKFILL_EOSE_GRACE_MS = 500;
/**
 * How many `until`-pages to walk per backfill pass, so one tick can't loop
 * forever. With a 30-event page that's up to 240 blobs per pass; the per-channel
 * cursor resumes paging older history on the next poll, so a large channel still
 * fills in fully over time without fetching thousands of blobs at once.
 */
const BACKFILL_MAX_PAGES = 8;

/**
 * How many of the newest sealed blobs to read + decode for the initial paint,
 * and how many more to reveal per scroll-up. Bounds the decrypt/verify cost to
 * the visible window so a large channel paints fast instead of decoding its
 * whole history up front. Mirrors NIP-29's PAGE_SIZE.
 */
const WINDOW_SIZE = 30;

/**
 * How many reaction blobs to read from the local store on channel open. Reactions
 * share a channel's `#z` with messages and outnumber them, so a large limit walks
 * deep into the tag index; 150 comfortably covers the ~30-message render window
 * while keeping the cold read fast (the network refresh rebuilds authoritatively).
 */
const LOCAL_REACTION_READ = 150;


/**
 * Backfill the local store from the relays, walking older history with `until`
 * pagination so a channel with more than {@link BACKFILL_PAGE} events isn't
 * permanently truncated to its newest page (the old single `limit: 500` query
 * silently lost everything older). Each relay query is mirrored into the local
 * store by NostrBatcher's `relay()` wrapper, so this just populates the
 * append-only store; the caller re-reads from the store afterward.
 *
 * Returns the OLDEST `created_at` seen across the pass, so a caller tracking a
 * per-channel backfill cursor can resume from there next time instead of
 * re-walking the same window.
 *
 * Progress is tracked PER-RELAY: a relay is dropped from later pages once it
 * stops returning events strictly older than the cursor we asked for. This is
 * essential because some relays in a community's relay list are general
 * aggregators that ignore the `until` cursor (or the `#z` filter) and return
 * their newest 30 events on every page — without per-relay culling, one such
 * relay forces the loop to burn its entire page budget (8 pages × N relays,
 * ~5–11s) on every single backfill, which is exactly what made opening a
 * channel and every 60s poll stall before new messages appeared.
 *
 * When `maxPages` is 1 (the default for the foreground "newest window" pass)
 * this is just a single cheap page per relay; deep history is walked only on
 * scroll-up via {@link loadOlder}.
 */
async function backfillStore(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  wire: ChannelWire,
  signal: AbortSignal,
  until?: number,
  maxPages: number = BACKFILL_MAX_PAGES,
): Promise<number | undefined> {
  let oldest: number | undefined;
  // Each relay walks its own cursor; a relay drops out once it stops yielding
  // strictly-older events (no progress) or returns a short page.
  let active = relays.map((url) => ({ url, cursor: until }));

  for (let page = 0; page < maxPages && active.length > 0; page++) {
    if (signal.aborted) break;

    // EOSE-race cap: NRelay1.query (per-relay) has no eoseTimeout, so a slow
    // relay would otherwise hold the whole page up to the 8s hard timeout. Once
    // the FASTEST relay returns this page, give the rest a short grace window,
    // then abandon them — their cursor just isn't advanced this pass and they're
    // retried next backfill. Mirrors the pool's eoseTimeout race.
    const pageController = new AbortController();
    const pageSignal = AbortSignal.any([signal, pageController.signal]);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const armGrace = () => {
      if (graceTimer === undefined) {
        graceTimer = setTimeout(() => pageController.abort(), BACKFILL_EOSE_GRACE_MS);
      }
    };

    const results = await Promise.all(
      active.map(async (relay) => {
        const filter: NostrFilter = wire.filter(MESSAGE_PLANE_KINDS, { limit: BACKFILL_PAGE });
        if (relay.cursor !== undefined) filter.until = relay.cursor;
        try {
          const r = await nostr
            .relay(relay.url)
            .query([filter], { signal: AbortSignal.any([pageSignal, AbortSignal.timeout(8000)]) });
          // First relay home starts the grace clock for the stragglers.
          armGrace();
          return { relay, events: r };
        } catch {
          return { relay, events: [] as NostrEvent[] };
        }
      }),
    );
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    const next: typeof active = [];
    for (const { relay, events } of results) {
      // Oldest event this relay returned that is strictly older than what we
      // asked for (defends against a relay that ignores `until`).
      let relayOldest = Infinity;
      let progressed = 0;
      for (const ev of events) {
        if (relay.cursor === undefined || ev.created_at < relay.cursor) {
          progressed += 1;
          if (ev.created_at < relayOldest) relayOldest = ev.created_at;
        }
      }
      if (Number.isFinite(relayOldest)) {
        if (oldest === undefined || relayOldest < oldest) oldest = relayOldest;
      }
      // Keep walking this relay only if it made real progress AND returned a
      // full page (more likely older history). A short page or a page with no
      // strictly-older events means this relay is done (or misbehaving).
      if (progressed > 0 && events.length >= BACKFILL_PAGE && relayOldest > 0) {
        next.push({ url: relay.url, cursor: relayOldest - 1 });
      }
    }
    active = next;
  }
  return oldest;
}

/**
 * Fetch + decrypt the messages of one Concord channel from the community's
 * relays. Queries every retained-epoch pseudonym (`#z`), opens each sealed outer
 * event under the matching epoch key (binding triad enforced), and returns the
 * verified messages sorted by time. Foreign/old-epoch blobs are silently
 * skipped (NoHeldEpoch), exactly as Vector's read path does.
 *
 * Cache-first: while the network query is in flight, the channel's sealed
 * events are read back from IndexedDB by their `#z` pseudonyms and decrypted
 * locally, so a channel we've visited renders instantly and survives a page
 * refresh (the relays only ever stored opaque blobs; decryption is local).
 */
export function useConcordChannelMessages(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const roster = useConcordRoster(community);
  const banlist = useConcordBanlist(community);
  const mySkHex = useRotatorSecretKey();
  // Catch up post-rekey epoch keys from the relays (the bundle only conveys the
  // current key at join). The read path opens messages under ALL retained
  // epochs, so a member who was present through a ban-rekey keeps reading.
  const caughtUp = useConcordChannelEpochs(community, channel, mySkHex);

  // Moderation context for the read path: drop banned authors' events, and let
  // an authorized moderator's 3305 hide another member's message. Verified
  // against the folded roster so a forged hide/ban has no effect.
  const moderation = useMemo(() => {
    const banned = banlist.data?.banned ?? new Set<string>();
    const r = roster.data;
    return {
      banned,
      canHide: (deleter: string, author: string) =>
        Boolean(r && canActOnMember(r.roster, deleter, r.ownerHex, author, Permissions.MANAGE_MESSAGES)),
    };
  }, [banlist.data, roster.data]);

  /**
   * The wire for this channel: addresses + filters + open/seal.
   * Carries the full held-epoch set: bundle seed ∪ caught-up rekeys.
   */
  const wire = useMemo(
    () => (community && channel ? channelWire(community, channel, caughtUp.data) : undefined),
    [community, channel, caughtUp.data],
  );

  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  // Epoch signature: changes when a rekey is caught up, so we can re-read.
  const epochSig = wire?.epochSig ?? "";
  const queryKey = ["concord", "channel", channelIdHex];
  // Last-known-good localStorage snapshot scope (instant cold-launch paint).
  const snapshotScope = channelIdHex ? concordSnapshotScope(channelIdHex) : undefined;

  // Per-channel backfill cursor (oldest created_at walked so far). Lets each
  // poll resume paging OLDER history into the local store instead of re-walking
  // the newest window every time, so a channel with >500 events fills in fully.
  const backfillCursor = useRef<Map<string, number | undefined>>(new Map());

  // Render/decode window: only the newest `windowLimit` sealed blobs are read +
  // decrypted for the initial paint, so a large channel doesn't decode its whole
  // history up front (the cause of the slow loading skeleton). Scrolling up grows
  // the window and re-reads. `hasMore` is true while the store likely holds older
  // blobs past the window. The window is held in a ref (read inside the queryFn)
  // mirrored by state (to drive `hasMore`/re-render).
  const windowLimitRef = useRef(WINDOW_SIZE);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  // The channel id whose initial store decode has completed. Until the cold read
  // resolves, the live subscription must NOT paint into an empty cache (that's
  // the "1 lonely message, then a blank second, then history snaps in" glitch on
  // a fresh open): a relay-forwarded message would replace the skeleton with a
  // single row while the (slower) IndexedDB read + decrypt is still in flight.
  // Live messages received during that window are persisted to the store by the
  // batcher anyway, so the resolving `composeFromStore` includes them.
  const initialLoadedRef = useRef<string | null>(null);

  // Reset the window to the newest page whenever the channel changes.
  useEffect(() => {
    windowLimitRef.current = WINDOW_SIZE;
    setHasMore(true);
    setIsLoadingOlder(false);
    initialLoadedRef.current = null;
  }, [channelIdHex]);

  // Re-read immediately when the held epoch set changes (a rekey was caught up),
  // rather than waiting for the next poll. Forget remembered decode FAILURES so
  // blobs previously skipped as `no-held-epoch` retry under the new keys.
  useEffect(() => {
    if (!channelIdHex || !wire) return;
    wire.forgetSkips();
    queryClient.invalidateQueries({ queryKey: ["concord", "channel", channelIdHex] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochSig]);

  // Live subscription for new messages — the same streaming `req()` NIP-29 chat
  // uses (useGroupMessages), so a member's message lands in the UI the instant
  // the relay forwards it instead of waiting for the 15s poll. Each arriving
  // sealed outer is opened incrementally (binding triad + moderation enforced)
  // and upserted into the existing query cache by message id; the periodic poll
  // remains a backstop for missed events / reconnection.
  useEffect(() => {
    if (!community || !channel || !channelIdHex || !wire || wire.addresses.length === 0) return;
    const w = wire;
    const relays = community.relays;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    /** Fold a batch of sealed outers into the cached timeline (assumes ready). */
    const fold = async (events: NostrEvent[]) => {
      if (events.length === 0) return;
      const { messages: opened, deletes } = await openMessages(w, events, moderation);
      if (opened.length === 0 && deletes.size === 0) return;
      queryClient.setQueryData<OpenedMessage[]>(queryKey, (old = []) => {
        const byId = new Map<string, OpenedMessage>();
        for (const m of old) byId.set(m.messageId, m);
        let changed = false;
        for (const m of opened) {
          if (moderation.banned.has(m.author)) continue;
          const existing = byId.get(m.messageId);
          // Skip if we already have an identical copy (the relay echoes our own
          // optimistic send and re-forwards on reconnect); upsert otherwise.
          if (existing && existing.content === m.content && existing.ms === m.ms) continue;
          byId.set(m.messageId, m);
          changed = true;
        }
        // Honor self-delete / authorized moderation-hide arriving live.
        for (const [id, deleters] of deletes) {
          const msg = byId.get(id);
          if (!msg) continue;
          if (deleters.has(msg.author) || [...deleters].some((d) => moderation.canHide(d, msg.author))) {
            byId.delete(id);
            changed = true;
          }
        }
        if (!changed) return old;
        // Clear optimistic "pending"/"failed" for anything the relay echoed back.
        const confirmed = opened.map((m) => m.messageId);
        if (confirmed.length > 0) {
          queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (s = {}) => {
            let touched = false;
            const next = { ...s };
            for (const id of confirmed) if (id in next) { delete next[id]; touched = true; }
            return touched ? next : s;
          });
        }
        return [...byId.values()].sort((a, b) => a.ms - b.ms);
      });
    };

    // Live events that arrive before the initial store decode resolves are
    // buffered, not dropped, then flushed the instant the timeline is ready — so
    // a message posted while a fresh channel is still loading appears right after
    // the history paints, not 1–2s later when the backfill happens to re-read it.
    const pending: NostrEvent[] = [];
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    const isReady = () =>
      initialLoadedRef.current === channelIdHex ||
      (queryClient.getQueryData<OpenedMessage[]>(queryKey)?.length ?? 0) > 0;

    const apply = async (events: NostrEvent[]) => {
      if (events.length === 0) return;
      if (!isReady()) {
        pending.push(...events);
        if (readyTimer === undefined) {
          readyTimer = setInterval(() => {
            if (controller.signal.aborted) {
              clearInterval(readyTimer);
              readyTimer = undefined;
              return;
            }
            if (isReady()) {
              clearInterval(readyTimer);
              readyTimer = undefined;
              const flush = pending.splice(0, pending.length);
              void fold(flush);
            }
          }, 100);
        }
        return;
      }
      await fold(events);
    };

    for (const url of relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [w.filter(MESSAGE_PLANE_KINDS, { since })],
            { signal: controller.signal },
          )) {
            if (msg[0] === "EVENT") await apply([msg[2] as NostrEvent]);
          }
        } catch {
          // Subscription ended (abort or relay closed) — the poll covers gaps.
        }
      })();
    }

    return () => {
      controller.abort();
      if (readyTimer !== undefined) clearInterval(readyTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community, channelIdHex, epochSig, moderation, queryClient]);

  // Android fast path: the background notification service already decrypted the
  // sealed Concord message to render its notification, and hands us the inner
  // event directly (via `concordMessage` live / the `concord` drain on resume).
  // We re-verify it fully here — the service only checked HMAC + channel/epoch
  // binding, NOT the inner Schnorr signature — then fold it straight in. This is
  // what makes a tapped notification's message appear the instant the channel
  // opens, with no second NIP-44 decrypt and no relay round-trip (the previous
  // path forced a re-decode/refetch, which is the lag you'd see on cold launch).
  useEffect(() => {
    if (!isNativeRuntime()) return;
    if (!community) return;
    if (!channel || !channelIdHex) return;
    const byEpoch = new Map<string, { epoch: bigint; key: Uint8Array }>();
    for (const ek of readEpochKeys(channel)) byEpoch.set(ek.epoch.toString(), ek);
    for (const ek of caughtUp.data ?? []) byEpoch.set(ek.epoch.toString(), ek);
    const allEpochKeys = [...byEpoch.values()];
    if (allEpochKeys.length === 0) return;
    let cancelled = false;

    // The pseudonyms this channel listens on — only fold inners whose outer `z`
    // matches one of ours (the service feeds inners for every subscribed channel).
    const ourZs = new Set(channelPseudonyms(channel));

    /** Verify a decrypted inner + bind/sig-check, then upsert it by message id. */
    const foldInner = (innerJson: string, z: string, outerId: string) => {
      if (cancelled || !ourZs.has(z)) return;
      let inner: NostrEvent;
      try {
        inner = JSON.parse(innerJson) as NostrEvent;
      } catch {
        return;
      }
      let opened: OpenedMessage;
      try {
        // Full trust re-established here: select held epoch by `z`, verify the
        // author's Schnorr signature, enforce the channel/epoch binding triad.
        opened = openVerifiedInner(inner, z, outerId, channel.id, allEpochKeys);
      } catch {
        return; // forged/unbound/undecodable — drop it
      }
      if (moderation.banned.has(opened.author)) return;
      if (opened.kind !== KIND_COMMUNITY_MESSAGE) return; // only chat renders here

      queryClient.setQueryData<OpenedMessage[]>(queryKey, (old = []) => {
        const existing = old.find((m) => m.messageId === opened.messageId);
        if (existing && existing.content === opened.content && existing.ms === opened.ms) {
          return old; // already have an identical copy (e.g. our own echo)
        }
        const byId = new Map(old.map((m) => [m.messageId, m]));
        byId.set(opened.messageId, opened);
        return [...byId.values()].sort((a, b) => a.ms - b.ms);
      });
      // Clear any optimistic pending/failed status the relay/native echoed back.
      queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (s = {}) => {
        if (!(opened.messageId in s)) return s;
        const next = { ...s };
        delete next[opened.messageId];
        return next;
      });
    };

    // Resume / cold-open: drain inners buffered while the WebView was down.
    const drain = () => {
      ArmadaNotification.drainConcord()
        .then(({ concord }) => {
          for (const c of concord ?? []) foldInner(c.inner, c.z, c.outerId);
        })
        .catch(() => undefined);
    };
    drain();

    let resumeHandle: { remove: () => void } | undefined;
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) drain();
    })
      .then((h) => {
        if (cancelled) h.remove();
        else resumeHandle = h;
      })
      .catch(() => undefined);

    // Live: a Concord message decrypted while the app is open.
    let handle: { remove: () => void } | undefined;
    ArmadaNotification.addListener("concordMessage", ({ inner, z, outerId }) =>
      foldInner(inner, z, outerId),
    )
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      handle?.remove();
      resumeHandle?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelIdHex, epochSig, moderation, queryClient]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    // Seed with the last visit's screenful from the synchronous localStorage
    // snapshot (already-decrypted OpenedMessages — same at-rest trust level as
    // the folded cache, see timelineSnapshot.ts). A cold launch paints the
    // channel on the first frame instead of behind the IndexedDB cold-open +
    // decrypt. Marked already-stale so the store read + relay refresh run
    // immediately and re-apply moderation/deletes on top of the seed.
    //
    // Only messages that actually BELONG to this channel are seeded: a snapshot
    // written by an older client during a room switch could hold another
    // channel's messages (the keepPreviousData race, see the snapshot writer
    // below), and seeding them would leak one room's timeline into another.
    initialData: () => {
      const snap = readTimelineSnapshot<OpenedMessage>(snapshotScope);
      if (!snap || !channelIdHex) return snap;
      const own = snap.filter((m) => m.channelId && bytesToHex(m.channelId) === channelIdHex);
      return own.length > 0 ? own : undefined;
    },
    initialDataUpdatedAt: 0,
    // Keep the previous channel's messages on screen while the next channel's
    // first read resolves, so switching never flashes a skeleton.
    placeholderData: keepPreviousData,
    // Backstop + backfill. The live subscription delivers NEW messages
    // instantly; this poll heals gaps (dropped subscription / missed event) and
    // walks OLDER history into the append-only local store via `until`
    // pagination, then renders from the store. Decode-once memoization keeps the
    // re-read cheap, so re-reading the whole local window each tick is fine.
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const w = wire!;
      const relays = community!.relays;
      const store = await eventStore;

      /**
       * Re-read the append-only local store, fold it together with whatever is
       * already shown (live/optimistic messages not yet in the store), apply
       * moderation + optimistic-delete + send-status reconciliation, and return
       * the timeline. Used for BOTH the immediate local-first result and the
       * post-backfill refresh.
       */
      const composeFromStore = async (): Promise<OpenedMessage[]> => {
        const { messages: opened, deletes, hasMore: more } = await readAndFold(
          store,
          w,
          windowLimitRef.current,
          moderation,
          signal,
        );
        setHasMore(more);

        // Union by message id with what's already shown; the store read wins on
        // conflict (it's verified), but a just-arrived live message / optimistic
        // send not yet in the store survives. Foreign-channel entries (from a
        // polluted pre-fix snapshot seed) are dropped, never merged forward.
        const prev = (queryClient.getQueryData<OpenedMessage[]>(queryKey) ?? []).filter(
          (m) => m.channelId && bytesToHex(m.channelId) === channelIdHex,
        );
        const byId = new Map<string, OpenedMessage>();
        for (const m of prev) byId.set(m.messageId, m);
        for (const m of opened) byId.set(m.messageId, m);
        for (const [id, msg] of byId) {
          // Drop banned authors and honor self-delete / authorized moderation-hide.
          if (moderation.banned.has(msg.author)) {
            byId.delete(id);
            continue;
          }
          const deleters = deletes.get(id);
          if (deleters && (deleters.has(msg.author) || [...deleters].some((d) => moderation.canHide(d, msg.author)))) {
            byId.delete(id);
          }
        }

        // Honor optimistic self-deletes: hide ids the user just deleted locally
        // until the relay's own delete event lands (at which point `readAndFold`
        // already drops the message and we can forget the optimistic hint).
        const optimisticDeleted =
          queryClient.getQueryData<string[]>(deletedKey(channelIdHex)) ?? [];
        if (optimisticDeleted.length > 0) {
          const stillHidden: string[] = [];
          for (const id of optimisticDeleted) {
            if (byId.has(id)) {
              byId.delete(id);
              stillHidden.push(id);
            }
            // else: the relay already dropped it; clear the optimistic hint.
          }
          if (stillHidden.length !== optimisticDeleted.length) {
            queryClient.setQueryData<string[]>(deletedKey(channelIdHex), stillHidden);
          }
        }

        // Reconcile optimistic send-status: clear "pending"/"failed" for any
        // message the relays have now echoed back into the local store.
        const status = queryClient.getQueryData<ConcordSendStatusMap>(statusKey(channelIdHex)) ?? {};
        const confirmed = opened.filter((m) => status[m.messageId]).map((m) => m.messageId);
        if (confirmed.length > 0) {
          queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (old = {}) => {
            const next = { ...old };
            for (const id of confirmed) delete next[id];
            return next;
          });
        }

        return [...byId.values()].sort((a, b) => a.ms - b.ms);
      };

      // 1. INSTANT PAINT: if React Query already holds this channel's timeline
      //    in memory (a return visit this session, or kept via placeholderData),
      //    render it immediately and refresh from the durable store + relays in
      //    the background. The local IndexedDB read can be slow on a cold WebView
      //    (seconds), and it must never gate the paint when we already have
      //    something good to show — the store/live results merge in on top.
      const existing = queryClient.getQueryData<OpenedMessage[]>(queryKey);

      const cursorKey = channelIdHex ?? "";

      /**
       * Walk the relays into the durable store and refresh the cache. Phase (a)
       * is one cheap EOSE-raced page per relay (surfaces NEW messages fast);
       * phase (b) is the bounded, resumable older-history walk. Each phase
       * re-reads the store and merges into the cache; never gates the paint.
       */
      const backfillAndRefresh = async () => {
        if (signal.aborted) return;
        // Re-reading the store is the slow part (seconds on a cold WebView), so
        // walk BOTH backfill phases first, then recompose ONCE — not after each.
        await backfillStore(nostr, relays, w, signal, undefined, 1); // newest page
        if (signal.aborted) return;
        const resumeFrom = backfillCursor.current.get(cursorKey);
        const oldest = await backfillStore(nostr, relays, w, signal, resumeFrom);
        if (oldest !== undefined && (resumeFrom === undefined || oldest < resumeFrom)) {
          backfillCursor.current.set(cursorKey, oldest);
        }
        if (signal.aborted) return;
        queryClient.setQueryData<OpenedMessage[]>(queryKey, await composeFromStore());
      };

      if (existing && existing.length > 0) {
        // Warm: paint what we have NOW; heal from the store + relays in the
        // background (the durable read can't gate the paint).
        initialLoadedRef.current = channelIdHex;
        void (async () => {
          if (signal.aborted) return;
          queryClient.setQueryData<OpenedMessage[]>(queryKey, await composeFromStore());
          await backfillAndRefresh();
        })().catch(() => undefined);
        return existing;
      }

      // Cold: nothing in memory yet. The durable store read IS the first paint;
      // then continue the relay backfill in the background.
      const local = await composeFromStore();
      initialLoadedRef.current = channelIdHex;
      void backfillAndRefresh().catch(() => undefined);
      return local;
    },
  });

  /**
   * Reveal an older page of history: grow the decode window by {@link WINDOW_SIZE}
   * and re-read the store, so the next-oldest sealed blobs are decrypted and
   * folded in. Resolves to the number of messages prepended (0 when nothing
   * older), so the timeline can hold the reading position. Like NIP-29's
   * `loadOlder`, but the "fetch" is a local decode rather than a relay round-trip.
   */
  const loadOlder = useCallback(async (): Promise<number> => {
    if (!hasMore || isLoadingOlder) return 0;
    const before = query.data?.length ?? 0;
    windowLimitRef.current += WINDOW_SIZE;
    setIsLoadingOlder(true);
    try {
      const result = await query.refetch();
      const after = result.data?.length ?? 0;
      return Math.max(0, after - before);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [hasMore, isLoadingOlder, query]);

  // Keep the localStorage snapshot fresh with the decoded timeline (debounced),
  // so the next cold launch paints this channel instantly. Disabled while the
  // query is showing the PREVIOUS channel's messages (keepPreviousData during a
  // room switch) — writing those under the new channel's scope is exactly the
  // cross-room pollution bug the seed filter above also guards against.
  useTimelineSnapshotWriter(snapshotScope, query.data, !query.isPlaceholderData);

  return { ...query, loadOlder, hasMore, isLoadingOlder };
}

/**
 * Send a sealed message into a Concord channel, optimistically and queueably.
 *
 * Mirrors the DM/NIP-29 behavior: a real message (kind 3300/3302) is rendered
 * immediately with `pending` status the moment its inner authorship event is
 * signed, the relay broadcast happens in the background, and the message is
 * reconciled (status cleared) when the relays echo it back on the next refetch.
 * A failed broadcast marks the message `failed` (retryable). Signing is
 * serialized through the per-identity signer queue so a burst of sends never
 * races on a NIP-07 extension.
 *
 * Non-message sends (reactions 3301, deletes 3305) don't render as chat rows,
 * so they skip the optimistic insert but still serialize their signing.
 */
export function useSendConcordMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  // The send wire seals at the CURRENT epoch only (no caught-up history needed).
  const wire = useMemo(
    () => (community && channel ? channelWire(community, channel) : undefined),
    [community, channel],
  );

  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));

  /** Broadcast a sealed outer to the community's relays. Throws if none accept. */
  const broadcast = useCallback(
    async (outer: NostrEvent) => {
      const results = await Promise.allSettled(
        community!.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
        ),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the message.");
      }
    },
    [nostr, community],
  );

  return useMutation({
    mutationFn: async ({
      content,
      kind = KIND_COMMUNITY_MESSAGE,
      reference,
      extraTags,
    }: {
      content: string;
      /** 3300 message (default), 3301 reaction, 3302 edit. */
      kind?: number;
      /** Target inner id for a reply/reaction/edit. */
      reference?: string;
      /** Extra inner tags appended verbatim (e.g. NIP-30 `emoji`, NIP-92 imeta). */
      extraTags?: string[][];
    }) => {
      if (!user) throw new Error("Sign in to send a message.");
      if (!community || !channel || !wire) throw new Error("No channel selected.");

      const signer = user.signer;
      const isChatMessage = kind === KIND_COMMUNITY_MESSAGE || kind === 3302;

      // The inner authorship proof is signed by the user's real identity,
      // then sealed for the wire.
      // Signing is serialized per-identity (extension-safe). If this throws
      // (signer rejected / sealing failed) it propagates to the caller before
      // anything is rendered; the composer shows a toast and keeps the draft.
      const ms = Date.now();
      const { opened, outer } = await wire.send(signer, user.pubkey, {
        content,
        ms,
        kind,
        reference,
        extraTags,
      });
      const innerId = opened.messageId;

      // Optimistically render real messages immediately. Unlike NIP-29, we do
      // NOT show a "pending" spinner: the broadcast is fire-and-forget and
      // near-instant, so the message is treated as sent the moment it's signed.
      // Only a genuine broadcast failure flips it to "failed" (with Retry).
      if (isChatMessage) {
        queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
          old.some((m) => m.messageId === opened.messageId)
            ? old
            : [...old, opened].sort((a, b) => a.ms - b.ms),
        );
      }

      // Broadcast in the background so the composer never blocks on the relay.
      // The echo reconciles the message content when it arrives; mark "failed"
      // only if no relay accepts.
      void broadcast(outer)
        .then(() => {
          if (channel) {
            queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
          }
        })
        .catch(() => {
          if (isChatMessage) setStatus(innerId, "failed");
        });

      return { outer, messageId: innerId, isChatMessage };
    },
  });
}

/**
 * Re-broadcast a Concord message that previously failed to send. The sealed
 * outer is reconstructed from the still-rendered optimistic message (we hold
 * the verified inner content + tags), re-signed through the signer queue, and
 * re-broadcast. The message id is preserved so it reconciles on refetch.
 */
export function useRetryConcordMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  const wire = useMemo(
    () => (community && channel ? channelWire(community, channel) : undefined),
    [community, channel],
  );

  const { setStatus } = useSendStatusMap(statusKey(channelIdHex));

  const retry = useCallback(
    (id: string) => {
      if (!user || !community || !channel || !wire) return;
      const messages = queryClient.getQueryData<OpenedMessage[]>(channelKey(channelIdHex)) ?? [];
      const msg = messages.find((m) => m.messageId === id);
      if (!msg) return;
      const signer = user.signer;
      setStatus(id, "pending");

      void (async () => {
        try {
          // Rebuild from the original content/tags; the wire re-derives the
          // binding tags, and the reply reference (if any) is in the original's
          // `e` tag.
          const reference = msg.tags.find((t) => t[0] === "e")?.[1];
          const { outer } = await wire.send(signer, user.pubkey, {
            content: msg.content,
            ms: msg.ms,
            kind: msg.kind,
            reference,
          });
          const results = await Promise.allSettled(
            community.relays.map((url) =>
              nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
            ),
          );
          if (!results.some((r) => r.status === "fulfilled")) {
            throw new Error("No relay accepted the message.");
          }
          // Optimistic: a relay accepted it, so clear "pending" now rather than
          // waiting for the polled echo to reconcile (matches the send path).
          setStatus(id, undefined);
          queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
        } catch {
          setStatus(id, "failed");
        }
      })();
    },
    [user, community, channel, wire, channelIdHex, queryClient, nostr, setStatus],
  );

  /** Drop a failed optimistic message from the channel view. */
  const discard = useCallback(
    (id: string) => {
      queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.messageId !== id),
      );
      setStatus(id, undefined);
    },
    [queryClient, channelIdHex, setStatus],
  );

  /**
   * Optimistically self-delete a message: hide it immediately, then publish the
   * sealed 3305 in the background. On failure, restore the message (and clear
   * the optimistic-delete hint) so it doesn't silently vanish. The hide is
   * recorded in the optimistic-delete set so a background refetch (which may
   * still see the message before the relay echoes the delete) keeps it hidden.
   */
  const deleteMessage = useCallback(
    (id: string) => {
      if (!user || !community || !channel || !wire) return;
      const signer = user.signer;

      const messages = queryClient.getQueryData<OpenedMessage[]>(channelKey(channelIdHex)) ?? [];
      const target = messages.find((m) => m.messageId === id);

      // Hide immediately: remove from the rendered list and remember the id so
      // a refetch before the relay confirms doesn't un-hide it.
      queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.messageId !== id),
      );
      queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
        old.includes(id) ? old : [...old, id],
      );

      const restore = () => {
        if (target) {
          queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
            old.some((m) => m.messageId === id)
              ? old
              : [...old, target].sort((a, b) => a.ms - b.ms),
          );
        }
        queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
          old.filter((d) => d !== id),
        );
      };

      void (async () => {
        try {
          const { outer } = await wire.send(signer, user.pubkey, {
            content: "",
            ms: Date.now(),
            kind: KIND_COMMUNITY_DELETE,
            reference: id,
          });
          const results = await Promise.allSettled(
            community.relays.map((url) =>
              nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
            ),
          );
          if (!results.some((r) => r.status === "fulfilled")) {
            throw new Error("No relay accepted the delete.");
          }
          queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
        } catch {
          // Couldn't publish the delete — bring the message back so the user
          // knows it wasn't removed.
          restore();
        }
      })();
    },
    [user, community, channel, wire, channelIdHex, queryClient, nostr],
  );

  return { retry, discard, deleteMessage };
}

/** Read a channel's optimistic send-status map (pending/failed by message id). */
export function useConcordSendStatus(channel: Channel | undefined): ConcordSendStatusMap {
  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  return useSendStatusMapValue(statusKey(channelIdHex));
}

/** A tallied reaction key: reactors plus the NIP-30 custom-emoji image URL (if any). */
export interface ConcordReactionTally {
  reactors: Set<string>;
  /** Custom-emoji image URL when the key is a `:shortcode:` (from the reaction's `emoji` tag). */
  url?: string;
}

/** target message id → emoji → {reactors, url}. */
type ReactionTallyMap = Map<string, Map<string, ConcordReactionTally>>;

/** Fold a batch of ALREADY-OPENED reaction events into a (cloned) tally map. */
function tallyReactions(base: ReactionTallyMap | undefined, opened: OpenedMessage[]): ReactionTallyMap {
  // Clone so we never mutate the cached object in place (React identity).
  const tally: ReactionTallyMap = new Map();
  if (base) {
    for (const [target, byEmoji] of base) {
      const cloned = new Map<string, ConcordReactionTally>();
      for (const [emoji, entry] of byEmoji) cloned.set(emoji, { reactors: new Set(entry.reactors), url: entry.url });
      tally.set(target, cloned);
    }
  }
  for (const om of opened) {
    const target = om.tags.find((t) => t[0] === "e")?.[1];
    if (!target || !om.content) continue;
    // NIP-30 custom emoji: content is `:shortcode:`, the `emoji` tag holds its
    // image URL (`["emoji", shortcode, url]`). Keep it so the pill renders the
    // image instead of the literal shortcode text.
    const url = om.tags.find((t) => t[0] === "emoji")?.[2];
    let byEmoji = tally.get(target);
    if (!byEmoji) tally.set(target, (byEmoji = new Map()));
    let entry = byEmoji.get(om.content);
    if (!entry) byEmoji.set(om.content, (entry = { reactors: new Set() }));
    entry.reactors.add(om.author);
    if (url && !entry.url) entry.url = url;
  }
  return tally;
}

/**
 * Load + tally reactions (kind 3301) for a channel, keyed per target message.
 *
 * Local-first + live, mirroring {@link useConcordChannelMessages} so reactions
 * paint WITH the timeline instead of arriving seconds later: the sealed reaction
 * blobs (mirrored into IndexedDB by the batcher) are read + decoded from the
 * local store immediately, then a background relay query reconciles, and a live
 * `req()` subscription upserts new reactions the instant they arrive. (The old
 * version was network-only with a 30s poll, so reactions lagged the first paint
 * by a relay round-trip and could take up to 30s to update.)
 */
export function useConcordReactions(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  const queryKey = ["concord", "reactions", channelIdHex];
  const persistKey = channelIdHex ? `reactions:${channelIdHex}` : null;
  const wire = useMemo(
    () => (community && channel ? channelWire(community, channel) : undefined),
    [community, channel],
  );
  // Address-set signature, so the live effect re-subscribes when a rekey is
  // caught up. Kept as a primitive dep.
  const zsSig = wire?.epochSig ?? "";

  // Restore the last persisted tally from IndexedDB on mount, so reactions paint
  // INSTANTLY on a refresh of a visited channel instead of waiting for the
  // (chunked) decode of up to 500 sealed reaction blobs. Seeds the query cache
  // only when empty; the decode-from-store result then replaces it.
  useEffect(() => {
    if (!persistKey || !channelIdHex) return;
    let cancelled = false;
    void readFolded<ReactionTallyMap>(persistKey).then((restored) => {
      if (cancelled || !restored) return;
      queryClient.setQueryData<ReactionTallyMap>(queryKey, (old) =>
        old && old.size > 0 ? old : restored,
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey, channelIdHex, queryClient]);

  // Live subscription: stream new reactions and fold them into the cached tally
  // the instant the relay forwards them (replaces waiting on the 30s poll).
  useEffect(() => {
    if (!community || !channel || !channelIdHex || !wire) return;
    const w = wire;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    const apply = async (events: NostrEvent[]) => {
      const opened = await w.openBatch(events, { signal: controller.signal, kinds: [KIND_COMMUNITY_REACTION] });
      if (opened.length === 0) return;
      queryClient.setQueryData<ReactionTallyMap>(queryKey, (old) => tallyReactions(old, opened));
    };

    for (const url of community.relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [w.filter([KIND_COMMUNITY_REACTION], { since })],
            { signal: controller.signal },
          )) {
            if (msg[0] === "EVENT") await apply([msg[2] as NostrEvent]);
          }
        } catch {
          // Subscription ended (abort or relay closed) — the poll covers gaps.
        }
      })();
    }

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community, channelIdHex, zsSig, queryClient]);

  const query = useQuery<ReactionTallyMap>({
    queryKey,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    // Backstop poll; the live subscription delivers new reactions instantly.
    refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const w = wire!;
      const store = await eventStore;

      // 1. LOCAL-FIRST: read mirrored reaction blobs from IndexedDB and tally
      //    them immediately, so reactions render with the timeline. Decode is
      //    chunked/yielding (decode-once memoized), so a cold backlog never
      //    blocks paint. (The persisted snapshot — seeded above — already paints
      //    instantly on a revisit while this decode runs.)
      //
      //    Limit 150, not 500: reactions and messages share one address, and a
      //    busy channel has several reactions per message, so collecting N
      //    reactions walks several×N index rows newest-first. The cost grows
      //    with the limit (measured ~70× slower at 500 than 60 on a
      //    reaction-heavy channel), and the only-render window is ~30 messages
      //    anyway. The authoritative network refresh below (and the persisted
      //    snapshot) cover anything older than this local top-up.
      const localSealed = await store.query([w.filter([KIND_COMMUNITY_REACTION], { limit: LOCAL_REACTION_READ })]);
      const localOpened = await w.openBatch(localSealed, { signal, kinds: [KIND_COMMUNITY_REACTION] });
      const local = tallyReactions(undefined, localOpened);

      // 2. BACKGROUND refresh from the relays (NOT awaited — never gates render).
      void (async () => {
        if (signal.aborted) return;
        try {
          const results = await Promise.all(
            community!.relays.map((url) =>
              nostr
                .relay(url)
                .query([w.filter([KIND_COMMUNITY_REACTION], { limit: 500 })], {
                  signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
                })
                .catch(() => [] as NostrEvent[]),
            ),
          );
          if (signal.aborted) return;
          const opened = await w.openBatch(results.flat(), { signal, kinds: [KIND_COMMUNITY_REACTION] });
          if (signal.aborted || opened.length === 0) return;
          // Authoritative rebuild from the full network set (not a merge), so a
          // reaction that was retracted upstream isn't retained. The live
          // subscription handles incremental adds between refreshes.
          queryClient.setQueryData<ReactionTallyMap>(queryKey, tallyReactions(undefined, opened));
        } catch {
          // Best-effort; the local-first tally already rendered.
        }
      })();

      return local;
    },
  });

  // Persist the tally so a future refresh paints reactions instantly from cache.
  // Keyed on size+a cheap signature so an identical re-tally doesn't churn writes.
  const lastWritten = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!persistKey || !query.data || query.data.size === 0) return;
    let sig = "";
    for (const [target, byEmoji] of query.data) {
      for (const [emoji, entry] of byEmoji) sig += `${target}:${emoji}:${entry.reactors.size};`;
    }
    if (sig === lastWritten.current) return;
    lastWritten.current = sig;
    void writeFolded(persistKey, query.data);
  }, [persistKey, query.data]);

  return query;
}
