import { openChatBatch } from "@/concord-v2/lib/chat";
import { KIND_MESSAGE, KIND_REACTION } from "@/concord-v2/lib/kinds";
import type { GroupKey } from "@/concord-v2/lib/derive";
import { notePlaneWrapsSeen, openPlaneWrapsChunked, unseenPlaneWraps } from "@/concord-v2/lib/planeSync";
import { parkPendingWraps, writeOpened, writeRumors } from "@/concord-v2/lib/rumorStore";
import { bufferLiveDmWraps } from "@/lib/nip17/dm17Store";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { KIND_COMMUNITY_MESSAGE } from "@/concord-v1/lib/kinds";
import { reactionContentKey } from "@/hooks/useReactions";
import { emitWireScopes } from "@/wire/bus";
import { feedNotifyCandidates, type NotifyCandidate } from "@/wire/notify";

import type { OpenedChat } from "@/concord-v2/lib/chat";
import type { WireSpec } from "@/wire/spec";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";

/** Gift-wrap kinds (Concord V2 / NIP-59) — never persisted sealed. */
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

/** The minimal store surface the wire writes to (armada-events). */
export interface WireEventStore {
  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
}

export interface WireSinks {
  /** The shared plaintext event store (armada-events IndexedDB). */
  eventStore: Promise<WireEventStore>;
  /** The current spec (decrypt map + scope naming). */
  getSpec: () => WireSpec | undefined;
  /** The logged-in user's pubkey (for mention detection / self-suppression). */
  getSelfPubkey?: () => string | undefined;
}

/** First value of a tag, if any. */
function tagValue(ev: NostrEvent, name: string): string | undefined {
  for (const t of ev.tags) if (t[0] === name && t[1]) return t[1];
  return undefined;
}

/** The bus scope a plaintext event belongs to, if any. */
function scopeOf(ev: NostrEvent, spec: WireSpec | undefined): string | undefined {
  const h = tagValue(ev, "h");
  if (h) return `nip29:${h}`;
  if (ev.kind === 4) return "dm";
  const z = tagValue(ev, "z");
  if (z) {
    // A control edition (kind-3308) carries the community's control `#z`, which
    // wakes the roster/metadata/banlist fold, NOT a channel timeline.
    const ctlCommunity = spec?.v1CtlByZ.get(z);
    if (ctlCommunity) return `c1ctl:${ctlCommunity}`;
    return `c1:${spec?.v1ByZ.get(z) ?? z}`;
  }
  return undefined;
}

/**
 * The wire's single ingestion point. EVERY transport funnels through here —
 * the web socket manager, the APK service's live `relayEvent` feed, and its
 * buffered drain — so there is exactly one routing rule:
 *
 *   - Concord V2 wraps whose stream key we hold → decrypt → rumor store.
 *   - V2 wraps we can't open yet (control/invite planes, key not derived yet)
 *     → parked pending store, drained later by whoever holds the key.
 *   - Everything else (NIP-29 kinds, DMs, sealed V1 outers) → armada-events.
 *     The store applies NIP-09 deletions itself.
 *
 * After the store write, the affected conversation scopes are announced on the
 * wire bus; hooks re-read the store. Writes are idempotent (stores dedupe by
 * id), so overlapping transports are harmless.
 *
 * `opts.live` marks events STREAMED live (post-EOSE / the APK's live feed) as
 * opposed to a round's stored replay (pre-EOSE / the APK's buffered drain).
 * Only live NIP-17 DM wraps produce notify candidates: their candidates are
 * stamped with the ingest wall clock (the wrap's own `created_at` is NIP-59
 * backdated), so a replayed wrap would look brand-new to the notifier and
 * re-alert on every fresh round / relaunch.
 */
export async function ingestWireEvents(
  sinks: WireSinks,
  events: NostrEvent[],
  opts?: { live?: boolean },
): Promise<void> {
  if (events.length === 0) return;
  const live = opts?.live ?? true;
  const spec = sinks.getSpec();
  const self = sinks.getSelfPubkey?.();
  const scopes = new Set<string>();
  const candidates: NotifyCandidate[] = [];

  // Split wraps from plaintext; group decryptable wraps per channel so the
  // (chunked, memoized) decode runs one batch per channel. Control-plane wraps
  // (a separate author set) are collected per community for a fold wake.
  const wrapsByChannel = new Map<ChannelV2, NostrEvent[]>();
  const ctlWraps: NostrEvent[] = [];
  const toPark: NostrEvent[] = [];
  const plain: NostrEvent[] = [];
  const dmWraps: NostrEvent[] = [];
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || typeof ev.kind !== "number") continue;
    if (WRAP_KINDS.has(ev.kind)) {
      const channel = spec?.v2ByPk.get(ev.pubkey);
      if (channel) {
        const list = wrapsByChannel.get(channel);
        if (list) list.push(ev);
        else wrapsByChannel.set(channel, [ev]);
      } else if (spec?.v2CtlByPk.has(ev.pubkey)) {
        ctlWraps.push(ev);
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
        // It is NOT parked (parking treats it as a dead Concord V2 pending wrap).
        dmWraps.push(ev);
      } else {
        // A wrap for a stream we hold no key for yet (V2 control/invite plane,
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
    const freshDmWraps = bufferLiveDmWraps(dmWraps);
    if (freshDmWraps.length > 0) {
      scopes.add("dm:wrap");
      // Notify only for LIVE arrivals attributable to a known conversation
      // (nips#2396). Replayed wraps (pre-EOSE / APK drain) stay silent — their
      // candidates carry a fresh wall-clock stamp and would re-alert. An
      // unattributable wrap (ephemeral-key sender, non-follow, first contact,
      // bunker/extension login) still wakes decryption via `dm:wrap`.
      if (live) {
        for (const ev of freshDmWraps) {
          const dmPeer = spec?.dm17ByPk.get(ev.pubkey);
          if (!dmPeer) continue;
          const cand = dm17Candidate(ev, dmPeer, self);
          if (cand) candidates.push(cand);
        }
      }
    }
  }

  // V2: decrypt with the owning channel's stream keys → rumor store.
  for (const [channel, wraps] of wrapsByChannel) {
    const opened = await openChatBatch(wraps, channel);
    if (opened.length === 0) continue;
    writeRumors(opened);
    scopes.add(`c2:${channel.idHex}`);
    const communityIdHex = spec?.v2CommunityByChannel.get(channel.idHex);
    for (const c of v2Candidates(opened, channel, communityIdHex, self)) candidates.push(c);
  }

  // V2 CONTROL: decrypt with the community's control-stream keys → opened-event
  // store, then ring `c2ctl:<idHex>`. useControlEvents2 listens on that scope
  // (even for a non-open community, whose rail button can't be invalidation-
  // reached) to re-seed from the store and re-fold — so a freshly-published
  // channel edition surfaces in the sidebar promptly, without waiting for the
  // slow control-plane sweep or a first message on the channel.
  if (ctlWraps.length > 0 && spec) {
    const byCommunity = new Map<string, { groups: GroupKey[]; wraps: NostrEvent[] }>();
    for (const ev of ctlWraps) {
      const entry = spec.v2CtlByPk.get(ev.pubkey);
      if (!entry) continue;
      const bucket = byCommunity.get(entry.idHex);
      if (bucket) bucket.wraps.push(ev);
      else byCommunity.set(entry.idHex, { groups: entry.groups, wraps: [ev] });
    }
    for (const [idHex, { groups, wraps }] of byCommunity) {
      // Skip wraps already processed (the persisted plane memo, shared with
      // the sweep): rotated rounds replay recent control wraps every time, and
      // on the APK the native service delivers the same wraps a second time —
      // without the memo each replay re-paid the full decrypt+verify.
      const unseen = await unseenPlaneWraps(wraps);
      if (unseen.length === 0) continue;
      const opened = await openPlaneWrapsChunked(unseen, groups);
      if (opened.length > 0) {
        await writeOpened(opened);
        scopes.add(`c2ctl:${idHex}`);
      }
      notePlaneWrapsSeen(unseen.map((w) => w.id));
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
    const writes = plain.map((ev) =>
      Promise.resolve()
        .then(() => store.event(ev))
        .catch(() => {
          // Duplicate or rejected — either way the store's state is authoritative.
        })
    );
    for (const ev of plain) {
      const scope = scopeOf(ev, spec);
      if (scope) scopes.add(scope);
      const cand = plaintextCandidate(ev, spec, self);
      if (cand) candidates.push(cand);
    }
    // Await the shared flush so the bus only rings once the events are
    // durably readable — a doorbell before the commit would send hooks
    // re-reading a store that can't see these events yet.
    await Promise.all(writes);
  }

  if (scopes.size > 0) emitWireScopes(scopes);
  feedNotifyCandidates(candidates);
}

/**
 * Build a DM notify candidate for an inbound NIP-17 gift wrap whose author
 * matches a known conversation address (nips#2396). The wrap is never
 * unwrapped here, so there is no body preview and no per-message mention
 * signal (a DM is inherently directed at the viewer). The wrap's `created_at`
 * is NIP-59-backdated (up to 2 days into the past), which would trip the
 * notifier's session-floor / dedupe gates — so the candidate is stamped with
 * the ingest wall-clock time instead (this wrap is arriving live now).
 */
function dm17Candidate(
  wrap: NostrEvent,
  peer: string,
  self: string | undefined,
): NotifyCandidate | undefined {
  if (self && peer === self) return undefined; // a self-copy wrap: never notify
  return {
    plane: "dm",
    author: peer,
    createdAt: Math.floor(Date.now() / 1000),
    mention: true, // a DM is inherently directed at the user
    kind: KIND_DM_WRAP,
    roomKey: `dm:${peer}`,
    readKey: `dm:${peer}`,
    path: `/dms/${peer}`,
    peer,
  };
}

/** Build notify candidates for a batch of decrypted V2 chat rumors. */
function v2Candidates(
  opened: OpenedChat[],
  channel: ChannelV2,
  communityIdHex: string | undefined,
  self: string | undefined,
): NotifyCandidate[] {
  const out: NotifyCandidate[] = [];
  const path = communityIdHex
    ? `/c/${encodeURIComponent(communityIdHex)}/${encodeURIComponent(channel.idHex)}`
    : "";
  for (const r of opened) {
    if (self && r.author === self) continue; // never notify on our own message
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
        path,
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
      roomKey: `c2:${channel.idHex}`,
      readKey: channel.idHex, // Concord2 read map is keyed by channel id hex
      path,
      channelIdHex: channel.idHex,
    });
  }
  return out;
}

/**
 * Build a notify candidate for a plaintext event (NIP-29 chat, DM, or a sealed
 * V1 outer). Returns undefined for events that shouldn't notify (self-authored,
 * non-activity kinds, deletions).
 */
function plaintextCandidate(
  ev: NostrEvent,
  spec: WireSpec | undefined,
  self: string | undefined,
): NotifyCandidate | undefined {
  if (self && ev.pubkey === self) return undefined; // never notify on our own message

  // NIP-29 group chat / poll.
  const h = tagValue(ev, "h");
  if (h) {
    if (ev.kind !== KIND_GROUP_CHAT && ev.kind !== KIND_POLL) return undefined;
    // The relay URL isn't on the event; the notifier hook maps groupId → relay
    // (+ route + name) from the user's group list. Leave relayUrl unset here.
    return {
      plane: "nip29",
      author: ev.pubkey,
      createdAt: ev.created_at,
      mention: Boolean(self) && ev.tags.some(([n, v]) => n === "p" && v === self),
      kind: ev.kind,
      body: preview(ev.content),
      roomKey: "", // filled by the hook once the relay URL is known
      readKey: "", // filled by the hook (needs the relay URL)
      path: "",
      groupId: h,
    };
  }

  // DM (kind 4): content is ciphertext here, so no body preview. A received DM
  // is authored by the peer; a sent DM (self) was filtered above.
  if (ev.kind === KIND_DM) {
    const peer = ev.pubkey;
    return {
      plane: "dm",
      author: peer,
      createdAt: ev.created_at,
      mention: true, // a DM is inherently directed at the user
      kind: KIND_DM,
      roomKey: `dm:${peer}`,
      readKey: `dm:${peer}`,
      path: `/dms/${peer}`,
      peer,
    };
  }

  // Concord V1 sealed outer (kind-3300 with a `#z` pseudonym): content stays
  // sealed at ingest, so we can't recover author/body/mention here. Emit a
  // channel-level candidate; the notifier hook resolves the community route +
  // names from the V1 list and treats it as an "all messages" signal only.
  // ONLY the message kind notifies — edits/deletes/reactions and control
  // editions (3308, which carry a control `#z`, not a channel one) stay silent.
  const z = tagValue(ev, "z");
  if (z && ev.kind === KIND_COMMUNITY_MESSAGE && !spec?.v1CtlByZ.has(z)) {
    const channelId = spec?.v1ByZ.get(z) ?? z;
    return {
      plane: "c1",
      author: "",
      createdAt: ev.created_at,
      mention: false,
      kind: ev.kind,
      roomKey: `z:${z}`,
      readKey: "", // filled by the hook (V1 read state)
      path: "",
      v1ChannelIdHex: channelId,
    };
  }

  return undefined;
}
