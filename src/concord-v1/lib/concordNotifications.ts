import { bytesToHex } from "@noble/hashes/utils.js";

import { channelPseudonym } from "@/concord-v1/lib/derive";
import { controlPseudonym } from "@/concord-v1/lib/control";
import { acceptInvite, type CommunityInvite } from "@/concord-v1/lib/invite";
import type { Community } from "@/concord-v1/lib/types";
import type { ConcordList } from "@/concord-v1/lib/concord";

/**
 * Per-epoch decrypt material for one `#z` pseudonym: the raw NIP-44 channel key
 * plus the channel id + epoch the inner event must bind to. The native service
 * uses this to open the sealed kind-3300 outer event (NIP-44 v2 under the raw
 * channel key) and recover the inner author + plaintext for a rich
 * notification — mirroring how the WebView opens it (`openMessageMulti`).
 */
export interface ConcordEpochKey {
  /** `#z` pseudonym (hex) this key decrypts. */
  z: string;
  /** Raw 32-byte channel key (hex) — the NIP-44 conversation key. */
  key: string;
  /** Channel id (hex) the inner `channel` tag must equal. */
  channelId: string;
  /** Epoch (decimal string) the inner `epoch` tag must equal. */
  epoch: string;
}

/**
 * A native-notification subscription for one Concord channel: the relays its
 * traffic lives on, the per-epoch addresses to filter on, the per-address
 * decrypt keys, and display names (`#z`-filtered kind-3300 outers). The native
 * service opens the sealed message with the supplied key to show
 * "<sender>: <preview>" in <community> / #<channel>.
 */
export interface ConcordSub {
  relays: string[];
  /** One `#z` pseudonym per retained epoch (hex). */
  zs: string[];
  /** Per-`z` decrypt material (key + binding) so the service can open messages. */
  keys: ConcordEpochKey[];
  /** Community id (hex) for the notification deep-link (/c1/:communityId). */
  communityId: string;
  communityName: string;
  channelName: string;
  /**
   * The community's encrypted icon pointer, for the native per-community
   * notification group summary. The service fetches the blob, AES-GCM decrypts
   * with `key`/`nonce`, and verifies `hash`. Best-effort: only present when the
   * icon rides in the invite/rehydrated community (the authoritative fold icon
   * isn't read here). Omitted otherwise.
   */
  communityImage?: { url: string; key: string; nonce: string; hash: string };
}

/** Every retained epoch key for a channel (newest first), with a safe fallback. */
export function channelEpochKeyPairs(
  channel: Community["channels"][number],
): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length
    ? channel.epochKeys
    : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The `#z` pseudonyms (one per held epoch) for a channel. */
export function channelZs(channel: Community["channels"][number]): string[] {
  return channelEpochKeyPairs(channel).map((ek) =>
    bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)),
  );
}

/** Per-`z` decrypt material (one per held epoch) for a channel. */
function channelEpochKeys(channel: Community["channels"][number]): ConcordEpochKey[] {
  const channelId = bytesToHex(channel.id);
  return channelEpochKeyPairs(channel).map((ek) => ({
    z: bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)),
    key: bytesToHex(ek.key),
    channelId,
    epoch: ek.epoch.toString(),
  }));
}

/**
 * Build the per-channel Concord notification subscriptions from the user's
 * membership list. Rehydrates each community (which needs the channel keys
 * from the NIP-44-decrypted list) and derives the `#z` pseudonyms + relays the
 * native service should listen on. Communities that fail to rehydrate are
 * skipped.
 */
export function buildConcordSubs(list: ConcordList | undefined): ConcordSub[] {
  if (!list) return [];
  const subs: ConcordSub[] = [];
  for (const entry of list.entries) {
    const invite = entry.current.keys.invite as CommunityInvite | undefined;
    if (!invite) continue;
    let community: Community;
    try {
      community = acceptInvite(invite);
    } catch {
      continue;
    }
    if (community.relays.length === 0) continue;
    const icon = community.icon;
    const communityImage = icon
      ? { url: icon.url, key: icon.key, nonce: icon.nonce, hash: icon.hash }
      : undefined;
    for (const channel of community.channels) {
      const zs = channelZs(channel);
      if (zs.length === 0) continue;
      subs.push({
        relays: community.relays,
        zs,
        keys: channelEpochKeys(channel),
        communityId: entry.communityId,
        communityName: community.name,
        channelName: channel.name,
        communityImage,
      });
    }
  }
  return subs;
}

/**
 * One community's Concord V1 CONTROL-plane subscription: the relays it lives on,
 * the control `#z` pseudonym (kind-3308 editions — roster/metadata/banlist), and
 * the community id for scope naming. The wire holds a standing subscription to
 * this address so a new role/metadata/ban edition lands LIVE for every joined
 * community, not only the one you have open — mirroring the V2 `concord2Control`
 * plane. Control editions stay sealed in the store (the fold opens them), so no
 * decrypt key is carried here.
 */
export interface ConcordControlSub {
  relays: string[];
  /** The control `#z` pseudonym (hex). */
  z: string;
  /** Community id (hex) for the bus scope + deep-link. */
  communityId: string;
}

/** Build the per-community Concord V1 control-plane subscriptions. */
export function buildConcordControlSubs(list: ConcordList | undefined): ConcordControlSub[] {
  if (!list) return [];
  const subs: ConcordControlSub[] = [];
  for (const entry of list.entries) {
    const invite = entry.current.keys.invite as CommunityInvite | undefined;
    if (!invite) continue;
    let community: Community;
    try {
      community = acceptInvite(invite);
    } catch {
      continue;
    }
    if (community.relays.length === 0) continue;
    const z = controlPseudonym(community.serverRootKey, community.id, community.serverRootEpoch);
    // Use the derived community id hex (not entry.communityId) so it matches the
    // `bytesToHex(community.id)` scope key the roster hook subscribes on.
    subs.push({ relays: community.relays, z, communityId: bytesToHex(community.id) });
  }
  return subs;
}
