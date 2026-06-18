/**
 * Targeted invites — ported from Vector's `community/invite.rs`.
 *
 * An invite bundle is the key material a new member needs to join: the
 * server-root key, the granted channels' keys/ids/epochs/names, the relay set,
 * the owner attestation, and the community id/name. `acceptInvite` reconstructs
 * a member-view Community (keyless — authority is the owner-rooted roster).
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { KIND_COMMUNITY_INVITE_BUNDLE } from "@/lib/concord/kinds";
import { verifyOwnerAttestation } from "@/lib/concord/owner";
import { capRelays, hex32, type Channel, type Community } from "@/lib/concord/types";

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

/** Build the gift-wrap rumor (unsigned kind-3304) that carries an invite to an invitee. */
export function buildInviteRumorTemplate(community: Community): EventTemplate {
  return {
    kind: KIND_COMMUNITY_INVITE_BUNDLE,
    content: inviteToJson(buildInvite(community)),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  };
}

/** Parse an inbound rumor as a community invite. Returns undefined unless kind 3304 + well-formed. */
export function parseInviteRumor(kind: number, content: string): CommunityInvite | undefined {
  if (kind !== KIND_COMMUNITY_INVITE_BUNDLE) return undefined;
  try {
    return inviteFromJson(content);
  } catch {
    return undefined;
  }
}

/** Sign an invite rumor template into an inner event (the gift-wrap layer is the caller's job). */
export function signInviteRumor(template: EventTemplate, sk: Uint8Array): NostrEvent {
  return finalizeEvent(template, sk);
}
