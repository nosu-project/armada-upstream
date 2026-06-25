import { bytesToHex } from "@noble/hashes/utils.js";

import { channelPseudonym } from "@/lib/concord/derive";
import { acceptInvite, type CommunityInvite } from "@/lib/concord/invite";
import type { Community } from "@/lib/concord/types";
import type { ConcordList } from "@/lib/concord";

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
 * traffic lives on, the per-epoch `#z` pseudonyms to filter on, the per-`z`
 * decrypt keys, and display names. The native service opens the sealed message
 * with the supplied key to show "<sender>: <preview>" in <community> / #<channel>.
 */
export interface ConcordSub {
  relays: string[];
  /** One `#z` pseudonym per retained epoch (hex). */
  zs: string[];
  /** Per-`z` decrypt material (key + binding) so the service can open messages. */
  keys: ConcordEpochKey[];
  /** Community id (hex) for the notification deep-link (/c/:communityId). */
  communityId: string;
  communityName: string;
  channelName: string;
}

/** Every retained epoch key for a channel (newest first), with a safe fallback. */
function epochKeys(channel: Community["channels"][number]): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length
    ? channel.epochKeys
    : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The `#z` pseudonyms (one per held epoch) for a channel. */
function channelZs(channel: Community["channels"][number]): string[] {
  return epochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

/** Per-`z` decrypt material (one per held epoch) for a channel. */
function channelEpochKeys(channel: Community["channels"][number]): ConcordEpochKey[] {
  const channelId = bytesToHex(channel.id);
  return epochKeys(channel).map((ek) => ({
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
      });
    }
  }
  return subs;
}
