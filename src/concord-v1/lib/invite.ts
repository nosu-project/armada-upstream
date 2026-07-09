/**
 * Targeted invites — ported from Vector's `community/invite.rs`.
 *
 * An invite bundle is the key material a new member needs to join: the
 * server-root key, the granted channels' keys/ids/epochs/names, the relay set,
 * the owner attestation, and the community id/name. `acceptInvite` reconstructs
 * a member-view Community (keyless — authority is the owner-rooted roster).
 *
 * V1's gift-wrapped delivery (kind-3304 rumors over kind-1059 wraps) is gone:
 * direct invites are V2-only now, and V1 never queries the giftwrap inbox.
 * What remains here is the bundle codec, still used by the membership list
 * (each entry stores its keys as a full invite) and the public-link path.
 */

import { bytesToHex } from "@noble/hashes/utils.js";

import { verifyOwnerAttestation } from "@/concord-v1/lib/owner";
import { capRelays, hex32, type Channel, type Community } from "@/concord-v1/lib/types";

const MAX_INVITE_CHANNELS = 256;

export interface InviteChannel {
  id: string;
  key: string;
  epoch: number;
  name: string;
}

/** Everything a new member needs to join a community (hex string fields → plain JSON). */
export interface CommunityInvite {
  community_id: string;
  name: string;
  server_root_key: string;
  server_root_epoch: number;
  relays: string[];
  channels: InviteChannel[];
  owner_attestation?: string;
}

/** Build an invite bundle granting ALL of a community's channels. */
export function buildInvite(community: Community): CommunityInvite {
  return {
    community_id: bytesToHex(community.id),
    name: community.name,
    server_root_key: bytesToHex(community.serverRootKey),
    server_root_epoch: Number(community.serverRootEpoch),
    relays: capRelays(community.relays),
    channels: community.channels.map((c) => ({
      id: bytesToHex(c.id),
      key: bytesToHex(c.key),
      epoch: Number(c.epoch),
      name: c.name,
    })),
    owner_attestation: community.ownerAttestation,
  };
}

export function inviteToJson(inv: CommunityInvite): string {
  return JSON.stringify(inv);
}

export function inviteFromJson(json: string): CommunityInvite {
  const inv = JSON.parse(json) as CommunityInvite;
  // Truncate-on-read: an inbound bundle is unauthenticated.
  inv.relays = capRelays(inv.relays ?? []);
  return inv;
}

/** Reconstruct a member-view Community from an invite bundle. Throws on malformed input. */
export function acceptInvite(invite: CommunityInvite): Community {
  if ((invite.channels?.length ?? 0) > MAX_INVITE_CHANNELS) {
    throw new Error(`invite declares too many channels (${invite.channels.length})`);
  }
  const id = hex32(invite.community_id);
  const serverRootKey = hex32(invite.server_root_key);

  // Keep the owner attestation ONLY if it verifies against this community's id.
  const ownerAttestation =
    invite.owner_attestation && verifyOwnerAttestation(invite.owner_attestation, invite.community_id)
      ? invite.owner_attestation
      : undefined;

  const channels: Channel[] = (invite.channels ?? []).map((ic) => ({
    id: hex32(ic.id),
    key: hex32(ic.key),
    epoch: BigInt(ic.epoch),
    name: ic.name,
    epochKeys: [],
  }));

  return {
    id,
    serverRootKey,
    serverRootEpoch: BigInt(invite.server_root_epoch ?? 0),
    name: invite.name,
    relays: capRelays(invite.relays ?? []),
    channels,
    ownerAttestation,
  };
}

