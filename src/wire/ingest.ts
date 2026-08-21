import { openChatBatch } from "@/concord/lib/chat";
import { KIND_MESSAGE, KIND_REACTION } from "@/concord/lib/kinds";
import type { StreamKeyView } from "@/concord/lib/derive";
import { notePlaneWrapsJunk, notePlaneWrapsSeen, openPlaneWrapsChunked, unseenPlaneWraps } from "@/concord/lib/planeSync";
import { parkPendingWraps, writeOpened, writeRumors } from "@/concord/lib/rumorStore";
import { isRelayScoped } from "@/lib/db/relayScope";
import { bufferLiveDmWraps } from "@/lib/nip17/dm17Store";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { KIND_STREAM_MESSAGE_V2 } from "@/buzz/kinds";
import { reactionContentKey } from "@/hooks/useReactions";
import { dmThreadScope, emitWireScopes } from "@/wire/bus";
import { feedNotifyCandidates, type NotifyCandidate } from "@/wire/notify";
import { isCIEventKind, matchCIEventRepository } from "@/lib/ci";
import { firstImetaMime, isThreadReply } from "@/lib/notificationPreview";
import { chatRoute } from "@/lib/routes";
import { isGitRepositoryAttachedAt, matchGitTicketRepository, parseGitComment, parseGitStatusEvent, parseGitTicket } from "@/lib/gitActivity";

import type { OpenedChat } from "@/concord/lib/chat";
import type { WireSpec } from "@/wire/spec";
import type { Channel } from "@/concord/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";

/** Gift-wrap kinds (Concord / NIP-59) — never persisted sealed. */
const WRAP_KINDS = new Set([1059, 21059]);
/** NIP-59 gift-wrap kind — the DM candidate's reported kind for a NIP-17 wrap. */
const KIND_DM_WRAP = 1059;
/** Legacy NIP-04 direct message kind (Armada's DM plane). */
const KIND_DM = 4;
/** NIP-88 poll kind — a channel-activity message in NIP-29 timelines. */
const KIND_POLL = 1068;

/** Preview text length cap for a foreground notification body. */
const PREVIEW_MAX = 140;

function preview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}\u2026` : t;
}

/**
 * The minimal store surface the wire writes to.
 *
 * `relay` is the relay the event arrived from. NIP-29 data is stored per-relay
 * (a group id names nothing without its relay), so an ingest that cannot say
 * where an event came from cannot store its group-scoped events at all — which
 * is why every transport below carries the relay through (see
 * `db/relayScope.ts`).
 */
export interface WireEventStore {
  event(event: NostrEvent, opts?: { signal?: AbortSignal; relay?: string }): Promise<void>;
}

export interface WireSinks {
  /** The shared plaintext event store (ArmadaDB `main` + per-relay tenants). */
  eventStore: Promise<WireEventStore>;
  /** The current spec (decrypt map + scope naming). */
  getSpec: () => WireSpec | undefined;
  /** The logged-in user's pubkey (for mention detection / self-suppression). */
  getSelfPubkey?: () => string | undefined;
}

/** First value of a tag, if any. */
function tagValue(ev: NostrEvent, name: string): string | undefined {
  return tagValueIn(ev.tags, name);
}

/**
 * Plaintext events already ingested this session, so a duplicate delivery
 * costs nothing.
 *
 * The wire re-REQs every filter on a quiet rotation with a backward `since`
 * overlap (`WireSync`'s QUIET_ROTATE_MS / CURSOR_OVERLAP_SECONDS), and one
 * filter fans out to every relay carrying it — so the SAME event arrives many
 * times over. Measured on a live idle client: 72% of kind-0 deliveries, 74%
 * of kind-4, and 93% of the NIP-34 git kinds were copies of an event already
 * in hand. The store dedupes by id, but only once the write reaches it, so
 * every copy still paid a store round-trip AND re-emitted its scope — and a
 * scope is what drives the React Query invalidations downstream, so a
 * duplicate that changed nothing still re-read and re-rendered.
 *
 * Both wrap paths already dedupe this way (`unseenPlaneWraps`,
 * `bufferLiveDmWraps`' session-seen ids); plaintext was the gap.
 *
 * Session-scoped and bounded, like the other id memos. It may only suppress a
 * write the store would have rejected as a duplicate anyway — see
 * {@link plainSeenKey} for the one case where the id alone is NOT enough.
 */
const seenPlain = new Set<string>();
const SEEN_PLAIN_CAP = 20_000;

/**
 * The dedupe key for a plaintext event.
 *
 * The id alone, EXCEPT for relay-scoped events. A NIP-29 event is filed into
 * its source relay's own tenant (`relayScope.ts`), so the same id arriving
 * from a second relay is a genuinely different row that must still be
 * written — dedupe those per (id, relay), which still absorbs that relay's
 * own replay without starving the other tenant.
 */
function plainSeenKey(ev: NostrEvent, relay: string | undefined): string {
  return isRelayScoped(ev) ? `${ev.id}|${relay ?? ""}` : ev.id;
}

/** Test seam: forget every ingested id. */
export function _resetIngestDedupeForTests(): void {
  seenPlain.clear();
}

/** The same, over bare tags (a decrypted rumor isn't a `NostrEvent`). */
function tagValueIn(tags: readonly string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name && t[1]) return t[1];
  return undefined;
}

/** The bus scope a plaintext event belongs to, if any. */
function scopeOf(ev: NostrEvent, spec: WireSpec | undefined): string | undefined {
  const ticket = parseGitTicket(ev);
  const ticketRepository = ticket && spec ? matchGitTicketRepository(ticket, spec.gitByRepository) : undefined;
  if (ticketRepository) return `git:${ticketRepository.coordinate}`;
  const comment = parseGitComment(ev);
  if (comment) {
    const address = spec?.gitRootById.get(comment.ticketId);
    if (address) return `git:${address}`;
  }
  const status = parseGitStatusEvent(ev);
  if (status) {
    const address = spec?.gitRootById.get(status.ticketId);
    if (address) return `git:${address}`;
  }
  // CI runs and job results carry the repository coordinates themselves, so
  // they scope without waiting for a root to be discovered first.
  const ciRepository = spec ? matchCIEventRepository(ev, spec.gitByRepository) : undefined;
  if (ciRepository) return `git:${ciRepository.coordinate}`;
  const h = tagValue(ev, "h");
  if (h) return `nip29:${h}`;
  if (ev.kind === 4) return "dm";
  return undefined;
}

/**
 * The wire's single ingestion point. EVERY transport funnels through here —
 * the web socket manager, the APK service's live `relayEvent` feed, and its
 * buffered drain — so there is exactly one routing rule:
 *
 *   - Concord wraps whose stream key we hold → decrypt → rumor store.
 *   - Concord wraps we can't open yet (control/invite planes, key not derived yet)
 *     → parked pending store, drained later by whoever holds the key.
 *   - Everything else (NIP-29 kinds, DMs) → the event store,
 *     which routes by scope: NIP-29 to `opts.relay`'s own tenant, the rest to
 *     the shared cache. The store applies NIP-09 deletions itself.
 *
 * After the store write, the affected conversation scopes are announced on the
 * wire bus; hooks re-read the store. Writes are idempotent (stores dedupe by
 * id), so overlapping transports are harmless.
 *
 * `opts.relay` is the relay this batch arrived from, and every transport is
 * expected to supply it: without it the store has nowhere honest to put a
 * group-scoped event and drops it (see `db/relayScope.ts`). The batch is one
 * relay's worth for exactly that reason — callers with events from several
 * relays must call once per relay.
 *
 * `opts.live` (STREAMED live post-EOSE vs a round's stored replay) is accepted
 * for transport parity but not acted on: the notifier's own session-floor and
 * per-room high-water mark suppress replayed re-alerts.
 */
export async function ingestWireEvents(
  sinks: WireSinks,
  events: NostrEvent[],
  opts?: { live?: boolean; relay?: string },
): Promise<void> {
  if (events.length === 0) return;
  const spec = sinks.getSpec();
  const self = sinks.getSelfPubkey?.();
  const scopes = new Set<string>();
  const candidates: NotifyCandidate[] = [];

  // Split wraps from plaintext; group decryptable wraps per channel so the
  // (chunked, memoized) decode runs one batch per channel. Control- and
  // guestbook-plane wraps (each its own author set) are collected per community
  // for a fold wake and a memberlist wake respectively.
  const wrapsByChannel = new Map<Channel, NostrEvent[]>();
  const ctlWraps: NostrEvent[] = [];
  const gbWraps: NostrEvent[] = [];
  const toPark: NostrEvent[] = [];
  const plain: NostrEvent[] = [];
  const dmWraps: NostrEvent[] = [];
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || typeof ev.kind !== "number") continue;
    if (WRAP_KINDS.has(ev.kind)) {
      const channel = spec?.concordByPk.get(ev.pubkey);
      if (channel) {
        const list = wrapsByChannel.get(channel);
        if (list) list.push(ev);
        else wrapsByChannel.set(channel, [ev]);
      } else if (spec?.concordCtlByPk.has(ev.pubkey)) {
        ctlWraps.push(ev);
      } else if (spec?.concordGbByPk.has(ev.pubkey)) {
        gbWraps.push(ev);
      } else if (self && ev.kind === KIND_DM_WRAP && ev.tags.some(([n, v]) => n === "p" && v === self)) {
        // A NIP-17 gift wrap addressed to the viewer (kind-1059, `#p` = self —
        // the wire's DM filter). The wire can't decrypt it (that needs the
        // user's NIP-44 + the consent gate, both owned by useDm17). Rather than
        // make useDm17 RE-FETCH the same wrap from the relays (a second
        // round-trip that re-pays NIP-42 auth on gating relays — the ~10-20s
        // live-DM latency), BUFFER the raw wrap in hand and ring `dm:wrap`.
        // useDm17 drains and decrypts it directly (no re-query); its store write
        // then rings `dm` for the re-read. (Two scopes deliberately: `dm:wrap` =
        // "live wraps are buffered, decrypt them"; `dm` = "the store changed,
        // re-read" — so decryption isn't re-triggered by its own store write.)
        // It is NOT parked (parking treats it as a dead Concord pending wrap).
        dmWraps.push(ev);
      } else {
        // A wrap for a stream we hold no key for yet (Concord control/invite plane,
        // or a just-joined channel whose spec hasn't refreshed) — park it.
        toPark.push(ev);
      }
    } else {
      plain.push(ev);
    }
  }
  if (dmWraps.length > 0) {
    // The buffer dedupes by session-seen id: the wire's wrap filter rewinds
    // `since` by the NIP-59 backdate window (stampRoundSince), so every fresh
    // round REPLAYS recent wraps — only genuinely new ones ring the doorbell.
    // Ring `dm:wrap` so useDm17 drains and decrypts the in-hand wrap (it holds
    // the NIP-44 keys + the consent gate); a wrap can't be attributed to a
    // sender here without unwrapping, so ingest never fires a DM candidate.
    const freshDmWraps = bufferLiveDmWraps(dmWraps);
    if (freshDmWraps.length > 0) scopes.add("dm:wrap");
  }

  // Concord: decrypt with the owning channel's stream keys → the owning community's
  // rumor-store tenant.
  for (const [channel, wraps] of wrapsByChannel) {
    // Skip wraps already stored, via the same persisted memo the control path
    // below uses. Rotated rounds replay recent wraps and `chat.ts`'s decode memo
    // is session-scoped, so every reload re-paid two NIP-44 decrypts and a
    // Schnorr verify for history already on disk.
    const unseen = await unseenPlaneWraps(wraps);
    if (unseen.length === 0) continue;
    const opened = await openChatBatch(unseen, channel);
    if (opened.length === 0) continue;
    // A channel only reaches `concordByPk` via the same spec input that registered
    // its community, so a miss means the spec was rebuilt underneath us. Skip
    // the write rather than guessing a tenant: the wraps are still on the relay
    // (and, on native, still parked), so the next sweep re-ingests them once
    // the channel's community is back in the spec. Guessing would file one
    // community's messages under another.
    const communityIdHex = spec?.concordCommunityByChannel.get(channel.idHex);
    if (!communityIdHex) continue;
    // Only the wraps that OPENED, and only once their rumors commit: a chat wrap
    // that failed is usually an epoch key we don't hold YET, so memoising it
    // would permanently skip one a later key could read. Chained rather than
    // awaited, so the scope ring stays as prompt as it was.
    void writeRumors(communityIdHex, opened).then((stored) => {
      // `wrapId` is optional only for a rumor read back OUT of the store; these
      // came straight off wraps.
      if (stored) notePlaneWrapsSeen(opened.flatMap((o) => o.wrapId ?? []));
    });
    scopes.add(`c2:${channel.idHex}`);
    // A banned member's message is still stored (the timeline folds it away on
    // read, like every other render surface) but must never raise a
    // notification — the one surface where hiding it isn't enough.
    const banned = communityIdHex ? spec?.concordBannedByCommunity.get(communityIdHex) : undefined;
    for (const c of concordCandidates(opened, channel, communityIdHex, self, banned)) candidates.push(c);
  }

  // Concord CONTROL: decrypt with the community's control-stream keys → opened-event
  // store, then ring `c2ctl:<idHex>`. useControlEvents listens on that scope
  // (even for a non-open community, whose rail button can't be invalidation-
  // reached) to re-seed from the store and re-fold — so a freshly-published
  // channel edition surfaces in the sidebar promptly, without waiting for the
  // slow control-plane sweep or a first message on the channel.
  if (ctlWraps.length > 0 && spec) {
    const byCommunity = new Map<
      string,
      { groups: StreamKeyView[]; refounded: boolean; wraps: NostrEvent[] }
    >();
    for (const ev of ctlWraps) {
      const entry = spec.concordCtlByPk.get(ev.pubkey);
      if (!entry) continue;
      const bucket = byCommunity.get(entry.idHex);
      if (bucket) bucket.wraps.push(ev);
      else {
        byCommunity.set(entry.idHex, {
          groups: entry.groups,
          refounded: entry.refounded,
          wraps: [ev],
        });
      }
    }
    for (const [idHex, { groups, refounded, wraps }] of byCommunity) {
      // Skip wraps already processed (the persisted plane memo, shared with
      // the sweep): rotated rounds replay recent control wraps every time, and
      // on the APK the native service delivers the same wraps a second time —
      // without the memo each replay re-paid the full decrypt+verify.
      const unseen = await unseenPlaneWraps(wraps);
      if (unseen.length === 0) continue;
      const opened = await openPlaneWrapsChunked(unseen, groups);
      let stored = true;
      if (opened.length > 0) {
        stored = await writeOpened(idHex, opened, "control", { refounded });
        scopes.add(`c2ctl:${idHex}`);
      }
      // Record the junk before memoing it: the memo stops the sweep ever
      // re-attempting these, so this is the only chance to count them.
      const openedIds = new Set(opened.map((e) => e.wrapId));
      notePlaneWrapsJunk(unseen.filter((w) => !openedIds.has(w.id)).map((w) => w.id));
      // Not memoised over a failed write: the memo is what stops these wraps
      // ever being decrypted again, so it must not outrun the store.
      if (stored) notePlaneWrapsSeen(unseen.map((w) => w.id));
    }
  }
  // Concord GUESTBOOK: decrypt with the community's guestbook-stream keys →
  // opened-event store, then ring `c2gb:<idHex>`. `useGuestbook` listens on
  // that scope to re-seed from the store and re-coalesce.
  //
  // This is the live path for a KICK, which is a guestbook directive and
  // nothing else — it publishes no control edition and rolls no epoch, so
  // NOTHING on the control plane's `c2ctl` sub ever announces one. Without
  // this the earliest a kicked member could learn of it was the plane's own
  // 60s poll (or the 5-minute background sweep, whichever came first).
  if (gbWraps.length > 0 && spec) {
    const byCommunity = new Map<string, { groups: StreamKeyView[]; wraps: NostrEvent[] }>();
    for (const ev of gbWraps) {
      const entry = spec.concordGbByPk.get(ev.pubkey);
      if (!entry) continue;
      const bucket = byCommunity.get(entry.idHex);
      if (bucket) bucket.wraps.push(ev);
      else byCommunity.set(entry.idHex, { groups: entry.groups, wraps: [ev] });
    }
    for (const [idHex, { groups, wraps }] of byCommunity) {
      const unseen = await unseenPlaneWraps(wraps);
      if (unseen.length === 0) continue;
      const opened = await openPlaneWrapsChunked(unseen, groups);
      let stored = true;
      if (opened.length > 0) {
        stored = await writeOpened(idHex, opened, "guestbook");
        scopes.add(`c2gb:${idHex}`);
      }
      const openedIds = new Set(opened.map((e) => e.wrapId));
      notePlaneWrapsJunk(unseen.filter((w) => !openedIds.has(w.id)).map((w) => w.id));
      // Not memoised over a failed write, for the same reason as control: the
      // memo is what stops these wraps ever being decrypted again.
      if (stored) notePlaneWrapsSeen(unseen.map((w) => w.id));
    }
  }

  // Wraps for streams we hold no key for (control plane, invites, or a
  // just-joined channel whose spec hasn't refreshed): park for the plane
  // hooks that do hold the keys. Peek+ack semantics keep this loss-proof.
  // Ring a doorbell naming the wrap's stream address: a hook that DOES hold
  // that stream's key (e.g. the active channel right after a rekey, before
  // the wire spec has refreshed its stream set) can drain the park instead
  // of sitting in dead air until the next poll.
  if (toPark.length > 0) {
    parkPendingWraps(toPark);
    for (const ev of toPark) scopes.add(`c2park:${ev.pubkey}`);
  }

  // Plaintext planes → the shared event store (NIP-09 applied by the store).
  // All writes are submitted BEFORE awaiting: NIndexedDB batches a burst of
  // event() calls into ONE idle-scheduled transaction, but only if none of
  // them is awaited first — a serial `await store.event(ev)` loop resolves
  // each call with that event's own flush, turning an N-event backfill into N
  // idle-window waits (starving up to the 1s rIC timeout each, on a busy
  // main thread) and N single-event transactions, and delaying the bus
  // emission below until the last one. See wire/ingestBatching.test.ts.
  if (plain.length > 0) {
    const store = await sinks.eventStore;
    // Only attached, well-formed NIP-34 roots belong to this plane: a broad or
    // malicious relay delivery must neither land in the store nor wake every
    // repository hook merely because it carries an `a` tag. Filtered up front
    // so the writes below stay one batched burst (see the note above).
    const storable = plain.filter(
      (ev) =>
        !(ev.kind === 1618 || ev.kind === 1621 || ev.kind === 1111 || (ev.kind >= 1630 && ev.kind <= 1633) || isCIEventKind(ev.kind)) ||
        scopeOf(ev, spec),
    );
    // Drop copies of events already ingested this session (see seenPlain).
    // Marked BEFORE the write so a burst carrying the same event twice keeps
    // only one; unmarked if the write throws, so a failed write is retried by
    // the next delivery rather than being deduped against nothing.
    const fresh = storable.filter((ev) => {
      const key = plainSeenKey(ev, opts?.relay);
      if (seenPlain.has(key)) return false;
      if (seenPlain.size >= SEEN_PLAIN_CAP) {
        // Oldest insertion first — `Set` iterates in insertion order.
        const oldest = seenPlain.keys().next();
        if (!oldest.done) seenPlain.delete(oldest.value);
      }
      seenPlain.add(key);
      return true;
    });
    const writes = fresh.map((ev) =>
      Promise.resolve()
        .then(() => store.event(ev, { relay: opts?.relay }))
        .catch(() => {
          // Duplicate or rejected — either way the store's state is authoritative.
          seenPlain.delete(plainSeenKey(ev, opts?.relay));
        })
    );
    for (const ev of fresh) {
      const scope = scopeOf(ev, spec);
      if (scope) scopes.add(scope);
      // The coarse `dm` scope refreshes the conversation list. Name the
      // affected peer separately so an open thread for somebody else does not
      // re-read its entire local history whenever any DM arrives.
      if (ev.kind === KIND_DM && self) {
        const peer = ev.pubkey === self ? tagValue(ev, "p") : ev.pubkey;
        if (peer) scopes.add(dmThreadScope(peer));
      }
      candidates.push(...plaintextCandidates(ev, spec, self));
    }
    // Await the shared flush so the bus only rings once the events are
    // durably readable — a doorbell before the commit would send hooks
    // re-reading a store that can't see these events yet.
    await Promise.all(writes);
  }

  if (scopes.size > 0) emitWireScopes(scopes);
  feedNotifyCandidates(candidates);
}

/** Build notify candidates for a batch of decrypted Concord chat rumors. */
function concordCandidates(
  opened: OpenedChat[],
  channel: Channel,
  communityIdHex: string | undefined,
  self: string | undefined,
  banned: Set<string> | undefined,
): NotifyCandidate[] {
  const out: NotifyCandidate[] = [];
  // A tap lands on the message, not merely the channel — so the path carries
  // the id. `communityIdHex` unknown leaves the path empty and the hook drops
  // the candidate; there is no channel-only route to fall back to.
  const room = communityIdHex
    ? ({ kind: "concord", communityId: communityIdHex, channelId: channel.idHex } as const)
    : undefined;
  const pathTo = (messageId: string | undefined) =>
    room ? chatRoute(messageId ? { ...room, messageId } : room) : "";
  for (const r of opened) {
    if (self && r.author === self) continue; // never notify on our own message
    if (banned?.has(r.author)) continue; // a banned member (CORD-04) never notifies
    const pTagsMe = Boolean(self) && r.tags.some(([n, v]) => n === "p" && v === self);

    // A reaction (kind 7) notifies ONLY when it p-tags the current user (i.e.
    // someone reacted to YOUR message). The reacted-to author is carried on the
    // encrypted rumor's `p` tag (NIP-25), invisible to the relay. Any other
    // non-message kind (edit/delete) still stays silent.
    if (r.kind === KIND_REACTION) {
      if (!pTagsMe) continue;
      out.push({
        plane: "c2",
        author: r.author,
        createdAt: r.createdAt,
        mention: true, // a reaction to your message is directed at you
        reaction: true,
        reactionEmoji: reactionContentKey(r.content),
        kind: r.kind,
        roomKey: `c2:${channel.idHex}`,
        readKey: channel.idHex,
        // A reaction is folded onto its target rather than rendered as a row,
        // so the link points at the message that was reacted to — the thing
        // the reader is being told about, and the only one of the two the
        // timeline can actually show.
        path: pathTo(tagValueIn(r.tags, "e")),
        eventId: r.rumorId,
        channelIdHex: channel.idHex,
      });
      continue;
    }
    if (r.kind !== KIND_MESSAGE) continue; // edits/deletes don't notify
    out.push({
      plane: "c2",
      author: r.author,
      createdAt: r.createdAt,
      mention: pTagsMe,
      kind: r.kind,
      body: preview(r.content),
      content: r.content,
      imetaMime: firstImetaMime(r.tags),
      threadReply: isThreadReply(r.kind, r.tags),
      roomKey: `c2:${channel.idHex}`,
      readKey: channel.idHex, // Concord read map is keyed by channel id hex
      path: pathTo(r.rumorId),
      eventId: r.rumorId,
      channelIdHex: channel.idHex,
    });
  }
  return out;
}

/**
 * Build a notify candidate for a plaintext event (NIP-29 chat or DM).
 * Returns undefined for events that shouldn't notify (self-authored,
 * non-activity kinds, deletions).
 */
function plaintextCandidates(
  ev: NostrEvent,
  spec: WireSpec | undefined,
  self: string | undefined,
): NotifyCandidate[] {
  if (self && ev.pubkey === self) return []; // never notify on our own message

  const git = gitCandidates(ev, spec);
  if (git.length) return git;

  // NIP-29 group chat / poll (and a Buzz stream-message v2, which reads the
  // same as kind 9 — see src/buzz/kinds.ts).
  const h = tagValue(ev, "h");
  if (h) {
    if (ev.kind !== KIND_GROUP_CHAT && ev.kind !== KIND_POLL && ev.kind !== KIND_STREAM_MESSAGE_V2) return [];
    // The relay URL isn't on the event; the notifier hook maps groupId → relay
    // (+ route + name) from the user's group list. Leave relayUrl unset here.
    return [{
      plane: "nip29",
      author: ev.pubkey,
      createdAt: ev.created_at,
      mention: Boolean(self) && ev.tags.some(([n, v]) => n === "p" && v === self),
      kind: ev.kind,
      body: preview(ev.content),
      content: ev.content,
      imetaMime: firstImetaMime(ev.tags),
      threadReply: isThreadReply(ev.kind, ev.tags),
      roomKey: "", // filled by the hook once the relay URL is known
      readKey: "", // filled by the hook (needs the relay URL)
      path: "", // ditto — the route names the relay
      eventId: ev.id,
      groupId: h,
    }];
  }

  // DM (kind 4): content is ciphertext here, so no body preview. A received DM
  // is authored by the peer; a sent DM (self) was filtered above.
  if (ev.kind === KIND_DM) {
    const peer = ev.pubkey;
    return [{
      plane: "dm",
      author: peer,
      createdAt: ev.created_at,
      mention: true, // a DM is inherently directed at the user
      kind: KIND_DM,
      roomKey: `dm:${peer}`,
      readKey: `dm:${peer}`,
      path: chatRoute({ kind: "dm", peer, messageId: ev.id }),
      eventId: ev.id,
      peer,
    }];
  }

  return [];
}

/** Route accepted Git activity to every independently-attached C2 channel. */
function gitCandidates(ev: NostrEvent, spec: WireSpec | undefined): NotifyCandidate[] {
  let repository: string | undefined;
  let ticketId: string | undefined;
  let ticketTitle: string | undefined;
  let action: string | undefined;
  const ticket = parseGitTicket(ev);
  if (ticket?.repositoryAddress) {
    repository = ticket.repositoryAddress.coordinate;
    ticketId = ticket.id;
    ticketTitle = ticket.subject;
    action = ticket.type === "issue" ? "opened an issue" : "opened a pull request";
  }
  const comment = parseGitComment(ev);
  if (comment) {
    repository = spec?.gitRootById.get(comment.ticketId);
    ticketId = comment.ticketId;
    action = "commented on a ticket";
  }
  const status = parseGitStatusEvent(ev);
  if (status) {
    repository = spec?.gitRootById.get(status.ticketId);
    ticketId = status.ticketId;
    // Repository owners are always trusted. Ticket-author/maintainer validation
    // is performed by the timeline once its root/announcement is available;
    // never surface an untrusted status here.
    if (!repository || (status.author !== repository.split(":")[1] && status.author !== spec?.gitRootAuthorById.get(status.ticketId))) return [];
    action = "changed a ticket status";
  }
  if (!repository || !action) return [];
  const attachments = spec?.gitByRepository.get(repository) ?? [];
  return attachments
    .filter((item): item is { channelId: string; communityId: string; attachment: import("@/lib/gitActivity").GitRepositoryAttachment } => Boolean(item.communityId) && isGitRepositoryAttachedAt(item.attachment, ev.created_at))
    .map(({ channelId, communityId, attachment }) => ({
      plane: "c2" as const,
      author: ev.pubkey,
      createdAt: ev.created_at,
      mention: false,
      kind: ev.kind,
      roomKey: `c2:${channelId}`,
      readKey: channelId,
      // `?ticket=` opens the ticket pane, not a message permalink — a git
      // activity event is not a row in the channel timeline.
      path: `${chatRoute({ kind: "concord", communityId, channelId })}?ticket=${encodeURIComponent(ticketId ?? ev.id)}`,
      channelIdHex: channelId,
      git: { action, repository: attachment.address.identifier, ticketId, ticketTitle },
      eventId: ev.id,
    }));
}
