import { openChatBatch } from "@/concord-v2/lib/chat";
import { KIND_MESSAGE, KIND_REACTION } from "@/concord-v2/lib/kinds";
import type { GroupKey } from "@/concord-v2/lib/derive";
import { openPlaneWraps } from "@/concord-v2/lib/planeSync";
import { parkPendingWraps, writeOpened, writeRumors } from "@/concord-v2/lib/rumorStore";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
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
  if (z) return `c1:${spec?.v1ByZ.get(z) ?? z}`;
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
 */
export async function ingestWireEvents(sinks: WireSinks, events: NostrEvent[]): Promise<void> {
  if (events.length === 0) return;
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
      } else {
        // A NIP-17 DM gift wrap from a known conversation address (nips#2396):
        // attribute it to the peer and NOTIFY without unwrapping. We do NOT
        // persist or park it — useDm17 owns fetching + decrypting DM wraps on
        // its own schedule (the sealed wrap is never stored). Wraps we can't
        // attribute (ephemeral-key senders, non-follows, first contact) simply
        // produce no notification; useDm17 still surfaces them in-app.
        const dmPeer = spec?.dm17ByPk.get(ev.pubkey);
        if (dmPeer) {
          const cand = dm17Candidate(ev, dmPeer, self);
          if (cand) candidates.push(cand);
        } else {
          toPark.push(ev);
        }
      }
    } else {
      plain.push(ev);
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
      const opened = openPlaneWraps(wraps, groups);
      if (opened.length === 0) continue;
      await writeOpened(opened);
      scopes.add(`c2ctl:${idHex}`);
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
  if (plain.length > 0) {
    const store = await sinks.eventStore;
    for (const ev of plain) {
      try {
        await store.event(ev);
      } catch {
        // Duplicate or rejected — either way the store's state is authoritative.
      }
      const scope = scopeOf(ev, spec);
      if (scope) scopes.add(scope);
      const cand = plaintextCandidate(ev, spec, self);
      if (cand) candidates.push(cand);
    }
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
  const z = tagValue(ev, "z");
  if (z) {
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
