import { normalizeRelayUrl } from "@/lib/platform";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_EDIT, KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_REACTION } from "@/concord-v1/lib/kinds";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";

import type { ConcordSub } from "@/concord-v1/lib/concordNotifications";
import type { GroupKey } from "@/concord-v2/lib/derive";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { NostrFilter } from "@nostrify/nostrify";

/** NIP-88 poll kind (renders in NIP-29 group timelines). */
const KIND_POLL = 1068;
/** NIP-09 deletion kind. */
const KIND_DELETE = 5;
/** Legacy NIP-04 direct message kind (Armada's DM plane). */
const KIND_DM = 4;
/** NIP-59 gift-wrap kind — carries a NIP-17 (kind-14/15) private DM. */
const KIND_GIFT_WRAP = 1059;

/**
 * Everything the app needs listened-to, as plain data. This is the SAME shape
 * of information `useNativeNotifications` feeds the APK's persistent service —
 * one spec, two transports (web sockets / native service).
 */
export interface WireInputs {
  /** The logged-in user (DM filters are addressed to them). */
  pubkey?: string;
  /** Joined NIP-29 groups. relay = the community host (one REQ per host). */
  groups: Array<{ id: string; relay: string }>;
  /** DM inbox relays (kind-4 reads; NIP-42-authed where the relay gates them). */
  dmRelays: string[];
  /** Friends-only DM senders (kind-3 follows). */
  dmFollows: string[];
  /**
   * NIP-17 conversation wrap addresses for follows the viewer can derive an
   * address for (nsec logins only — see nips#2396). Each maps a wrap author
   * pubkey to the peer who owns that conversation, so the wire can attribute an
   * inbound (undecrypted) kind-1059 gift wrap to a sender WITHOUT unwrapping it,
   * and fire a "{peer} sent you a message" notification. Empty for extension /
   * bunker logins (the raw key isn't available to derive the address).
   */
  dm17WrapAddrs?: Array<{ wrapPk: string; peerPk: string }>;
  /** Concord V1 channel subscriptions (relays + `#z` pseudonyms + bindings). */
  concord1: ConcordSub[];
  /** Concord V2 channels (each carries its stream GroupKeys for decrypt). */
  concord2: Array<{ relays: string[]; channel: ChannelV2; communityIdHex: string }>;
  /**
   * Concord V2 CONTROL planes (each carries its control-stream GroupKeys). A
   * standing subscription to these authors lands new control editions —
   * channel creations, roster/metadata changes — LIVE for every community, not
   * only the one you have open, so a member added to a new channel sees it in
   * the sidebar without waiting for the slow background sweep (or for someone
   * to post the first message).
   */
  concord2Control?: Array<{ relays: string[]; idHex: string; groups: GroupKey[] }>;
}

/** One relay's standing subscription. */
export interface WireSub {
  /** Normalized relay URL. */
  relay: string;
  /** Filters to hold open (the manager stamps `since`). */
  filters: NostrFilter[];
}

export interface WireSpec {
  subs: WireSub[];
  /** V2 stream address (wrap author) → owning channel, for decrypt + scope. */
  v2ByPk: Map<string, ChannelV2>;
  /** V2 channel id hex → its owning community id hex (for notification routing). */
  v2CommunityByChannel: Map<string, string>;
  /** V2 CONTROL stream address (wrap author) → its community, for decrypt + fold wake. */
  v2CtlByPk: Map<string, { idHex: string; groups: GroupKey[] }>;
  /** V1 `#z` pseudonym → channel id hex, for scope naming. */
  v1ByZ: Map<string, string>;
  /**
   * NIP-17 wrap author pubkey → conversation peer pubkey, for attributing an
   * inbound kind-1059 gift wrap to a sender at ingest without unwrapping it
   * (nips#2396 conversation addresses; follows-scoped, nsec logins only).
   */
  dm17ByPk: Map<string, string>;
  /** Deterministic signature of `subs` for cheap diffing/resubscribe. */
  sig: string;
}

/**
 * Build the wire's per-relay subscription spec.
 *
 * NIP-29 is relay-per-community: each host relay gets exactly one `#h` filter
 * covering the groups it hosts (NIP-42 AUTH is handled by the relay pool for
 * private groups — the pool signs kind-22242 with the user's signer, and
 * Concord V2 stream keys are additionally authenticated via the stream-auth
 * registry, which matters on relays that gate kind-1059 REQs by `authors`).
 *
 * Muted channels are deliberately INCLUDED: the wire feeds the local stores
 * that timelines and badges hydrate from; muting is a notification/render
 * concern, not an ingestion one. (The APK service, which fires notifications,
 * keeps excluding muted channels in its own config.)
 */
export function buildWireSpec(inputs: WireInputs): WireSpec {
  const byRelay = new Map<string, NostrFilter[]>();
  const add = (url: string, filter: NostrFilter) => {
    const relay = normalizeRelayUrl(url);
    if (!relay) return;
    const list = byRelay.get(relay);
    if (list) list.push(filter);
    else byRelay.set(relay, [filter]);
  };

  // ── NIP-29: one `#h` filter per host relay ────────────────────────────────
  const groupsByRelay = new Map<string, Set<string>>();
  for (const g of inputs.groups) {
    const relay = normalizeRelayUrl(g.relay);
    if (!relay || !g.id) continue;
    let set = groupsByRelay.get(relay);
    if (!set) groupsByRelay.set(relay, (set = new Set()));
    set.add(g.id);
  }
  for (const [relay, ids] of groupsByRelay) {
    add(relay, { kinds: [KIND_GROUP_CHAT, KIND_POLL, KIND_DELETE], "#h": [...ids].sort() });
  }

  // ── DMs: sent + friends-only received, on the DM relays ──────────────────
  if (inputs.pubkey) {
    const follows = [...new Set(inputs.dmFollows)].sort();
    for (const url of inputs.dmRelays) {
      add(url, { kinds: [KIND_DM], authors: [inputs.pubkey] });
      if (follows.length > 0) {
        add(url, { kinds: [KIND_DM], authors: follows, "#p": [inputs.pubkey] });
      }
      // NIP-17: every gift wrap addressed to the viewer. The wrap author hides
      // the real sender, so this can't be `authors`-narrowed — but the wire
      // only NOTIFIES for wraps whose author matches a derived conversation
      // address (dm17ByPk below); useDm17 owns fetching + decrypting the rest.
      add(url, { kinds: [KIND_GIFT_WRAP], "#p": [inputs.pubkey] });
    }
  }

  // NIP-17 conversation wrap addresses → peer (nips#2396, follows-scoped). The
  // ingest path uses this to attribute an inbound gift wrap to its sender for a
  // notification without unwrapping. Deduped on wrap pubkey.
  const dm17ByPk = new Map<string, string>();
  for (const { wrapPk, peerPk } of inputs.dm17WrapAddrs ?? []) {
    if (wrapPk && peerPk) dm17ByPk.set(wrapPk, peerPk);
  }

  // ── Concord V1: merged `#z` filter per community relay ───────────────────
  const v1ByZ = new Map<string, string>();
  const zsByRelay = new Map<string, Set<string>>();
  for (const sub of inputs.concord1) {
    for (const k of sub.keys) v1ByZ.set(k.z, k.channelId);
    for (const url of sub.relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = zsByRelay.get(relay);
      if (!set) zsByRelay.set(relay, (set = new Set()));
      for (const z of sub.zs) set.add(z);
    }
  }
  for (const [relay, zs] of zsByRelay) {
    add(relay, {
      kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_EDIT, KIND_COMMUNITY_DELETE, KIND_COMMUNITY_REACTION],
      "#z": [...zs].sort(),
    });
  }

  // ── Concord V2: merged wrap-author filter per community relay ────────────
  const v2ByPk = new Map<string, ChannelV2>();
  const v2CommunityByChannel = new Map<string, string>();
  const pksByRelay = new Map<string, Set<string>>();
  for (const { relays, channel, communityIdHex } of inputs.concord2) {
    for (const s of channel.streams) v2ByPk.set(s.group.pk, channel);
    v2CommunityByChannel.set(channel.idHex, communityIdHex);
    for (const url of relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = pksByRelay.get(relay);
      if (!set) pksByRelay.set(relay, (set = new Set()));
      for (const s of channel.streams) set.add(s.group.pk);
    }
  }
  for (const [relay, pks] of pksByRelay) {
    add(relay, { kinds: [KIND_WRAP], authors: [...pks].sort() });
  }

  // ── Concord V2 CONTROL: merged control-author filter per community relay ──
  // Kept SEPARATE from the chat-wrap map above: control wraps decode with the
  // control-stream keys (not any channel's) and wake the fold rather than a
  // chat timeline (see ingest.ts). Filters coalesce with the chat-wrap filter
  // on the same relay via the shared KIND_WRAP `add` merge — one round trip.
  const v2CtlByPk = new Map<string, { idHex: string; groups: GroupKey[] }>();
  const ctlPksByRelay = new Map<string, Set<string>>();
  for (const { relays, idHex, groups } of inputs.concord2Control ?? []) {
    for (const g of groups) v2CtlByPk.set(g.pk, { idHex, groups });
    for (const url of relays) {
      const relay = normalizeRelayUrl(url);
      if (!relay) continue;
      let set = ctlPksByRelay.get(relay);
      if (!set) ctlPksByRelay.set(relay, (set = new Set()));
      for (const g of groups) set.add(g.pk);
    }
  }
  for (const [relay, pks] of ctlPksByRelay) {
    add(relay, { kinds: [KIND_WRAP], authors: [...pks].sort() });
  }

  const subs: WireSub[] = [...byRelay.entries()]
    .map(([relay, filters]) => ({ relay, filters }))
    .sort((a, b) => (a.relay < b.relay ? -1 : 1));

  return { subs, v2ByPk, v2CommunityByChannel, v2CtlByPk, v1ByZ, dm17ByPk, sig: JSON.stringify(subs) };
}
