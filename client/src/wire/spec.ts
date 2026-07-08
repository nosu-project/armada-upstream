import { normalizeRelayUrl } from "@/lib/platform";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_MESSAGE } from "@/concord-v1/lib/kinds";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";

import type { ConcordSub } from "@/concord-v1/lib/concordNotifications";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { NostrFilter } from "@nostrify/nostrify";

/** NIP-88 poll kind (renders in NIP-29 group timelines). */
const KIND_POLL = 1068;
/** NIP-09 deletion kind. */
const KIND_DELETE = 5;
/** Legacy NIP-04 direct message kind (Armada's DM plane). */
const KIND_DM = 4;

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
  /** Concord V1 channel subscriptions (relays + `#z` pseudonyms + bindings). */
  concord1: ConcordSub[];
  /** Concord V2 channels (each carries its stream GroupKeys for decrypt). */
  concord2: Array<{ relays: string[]; channel: ChannelV2 }>;
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
  /** V1 `#z` pseudonym → channel id hex, for scope naming. */
  v1ByZ: Map<string, string>;
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
    }
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
    add(relay, { kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE], "#z": [...zs].sort() });
  }

  // ── Concord V2: merged wrap-author filter per community relay ────────────
  const v2ByPk = new Map<string, ChannelV2>();
  const pksByRelay = new Map<string, Set<string>>();
  for (const { relays, channel } of inputs.concord2) {
    for (const s of channel.streams) v2ByPk.set(s.group.pk, channel);
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

  const subs: WireSub[] = [...byRelay.entries()]
    .map(([relay, filters]) => ({ relay, filters }))
    .sort((a, b) => (a.relay < b.relay ? -1 : 1));

  return { subs, v2ByPk, v1ByZ, sig: JSON.stringify(subs) };
}
