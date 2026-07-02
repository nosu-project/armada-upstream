/**
 * CORD community model — minting (CORD-02), channel keying (CORD-03), and the
 * invite bundle (CORD-05 §1).
 *
 * A CORD community reuses the shared {@link Community}/{@link Channel} structs
 * with `proto: "cord"`. Two things differ from v1 at the model level:
 *
 *   - **identity is a commitment**: `community_id = sha256("concord/community"
 *     ‖ owner_xonly ‖ owner_salt)` — anyone holding `(owner, salt)` can verify
 *     who founded it; no attestation event exists.
 *   - **public channels have no key of their own**: they derive from the
 *     CommunityRoot per epoch, so they cost nothing to invite and rotate with
 *     the base. `Channel.derived = true` marks them; `Channel.key` then holds
 *     the root secret feeding the derivation.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { capRelays, hex32, random32, type Channel, type Community, type CommunityImage } from "@/lib/concord/types";
import { channelGroupKey, cordCommunityId, verifyCordCommunityId } from "@/lib/cord/derive";
import type { EpochGroup } from "@/lib/cord/stream";

const ZERO_HEX = "0".repeat(64);

/**
 * Mint a brand-new CORD community: fresh salt → self-certifying id, fresh
 * CommunityRoot at epoch 0, one derived (public) default channel.
 */
export function mintCordCommunity(
  name: string,
  defaultChannelName: string,
  relays: string[],
  ownerPubkeyHex: string,
): Community {
  const owner = hex32(ownerPubkeyHex);
  // Reject the ~impossible all-zero id (the server-root scope sentinel).
  let salt = random32();
  let id = cordCommunityId(owner, salt);
  while (bytesToHex(id) === ZERO_HEX) {
    salt = random32();
    id = cordCommunityId(owner, salt);
  }
  const root = random32();
  return {
    id,
    serverRootKey: root,
    serverRootEpoch: 0n,
    name,
    relays: capRelays(relays),
    channels: [
      {
        id: random32(),
        key: root,
        epoch: 0n,
        name: defaultChannelName,
        epochKeys: [],
        derived: true,
      },
    ],
    proto: "cord",
    owner: ownerPubkeyHex,
    ownerSalt: bytesToHex(salt),
  };
}

/** Materialize a derived (public) CORD channel from its control-plane metadata. */
export function derivedCordChannel(community: Community, channelId: Uint8Array, name: string): Channel {
  return {
    id: channelId,
    key: community.serverRootKey,
    epoch: community.serverRootEpoch,
    name,
    epochKeys: [],
    derived: true,
  };
}

/**
 * The full retained epoch → group-key set for a channel plane, feeding the
 * multi-epoch stream opener. A derived channel keys off the root across every
 * retained root epoch; a private channel keys off its own key + epoch history.
 */
export function cordChannelGroups(community: Community, channel: Channel): EpochGroup[] {
  const out = new Map<string, EpochGroup>();
  if (channel.derived) {
    const roots = [
      { epoch: community.serverRootEpoch, key: community.serverRootKey },
      ...(community.priorRoots ?? []),
    ];
    for (const r of roots) {
      out.set(r.epoch.toString(), { epoch: r.epoch, group: channelGroupKey(r.key, channel.id, r.epoch) });
    }
  } else {
    const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
    for (const ek of keys) {
      out.set(ek.epoch.toString(), { epoch: ek.epoch, group: channelGroupKey(ek.key, channel.id, ek.epoch) });
    }
  }
  // Newest first, matching the v1 read path's ordering.
  return [...out.values()].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The (secret, epoch) a CORD channel currently seals with. */
export function cordChannelCurrent(community: Community, channel: Channel): { secret: Uint8Array; epoch: bigint } {
  return channel.derived
    ? { secret: community.serverRootKey, epoch: community.serverRootEpoch }
    : { secret: channel.key, epoch: channel.epoch };
}

// ── Invite bundle (CORD-05 §1) ───────────────────────────────────────────────

/** A granted channel inside a CORD invite. Public channels carry NO key. */
export interface CordInviteChannel {
  id: string;
  name: string;
  /** true = independently-keyed Private Channel (then `key`/`epoch` are present). */
  private?: boolean;
  key?: string;
  epoch?: number;
}

/**
 * Everything a new member needs to join a CORD community. The `(owner,
 * owner_salt)` pair is the owner proof — a bundle whose pair fails to
 * reproduce `community_id` is refused outright.
 */
export interface CordInvite {
  proto: "cord";
  community_id: string;
  name: string;
  owner: string;
  owner_salt: string;
  root_key: string;
  root_epoch: number;
  relays: string[];
  channels: CordInviteChannel[];
  icon?: CommunityImage;
  /**
   * armada extension, list-storage only (STRIPPED from published invites): the
   * prior root epochs this member retains, so a device restore keeps reading
   * pre-refounding history.
   */
  prior_roots?: Array<{ epoch: number; key: string }>;
}

const MAX_INVITE_CHANNELS = 256;

/** Build the CORD invite bundle for a community (all channels granted). */
export function buildCordInvite(community: Community, opts?: { includePriorRoots?: boolean }): CordInvite {
  if (community.proto !== "cord" || !community.owner || !community.ownerSalt) {
    throw new Error("not a CORD community");
  }
  const invite: CordInvite = {
    proto: "cord",
    community_id: bytesToHex(community.id),
    name: community.name,
    owner: community.owner,
    owner_salt: community.ownerSalt,
    root_key: bytesToHex(community.serverRootKey),
    root_epoch: Number(community.serverRootEpoch),
    relays: capRelays(community.relays),
    channels: community.channels.map((c) =>
      c.derived
        ? { id: bytesToHex(c.id), name: c.name }
        : {
            id: bytesToHex(c.id),
            name: c.name,
            private: true,
            key: bytesToHex(c.key),
            epoch: Number(c.epoch),
          },
    ),
    ...(community.icon !== undefined ? { icon: community.icon } : {}),
  };
  if (opts?.includePriorRoots && community.priorRoots?.length) {
    invite.prior_roots = community.priorRoots.map((r) => ({ epoch: Number(r.epoch), key: bytesToHex(r.key) }));
  }
  return invite;
}

/** Quick structural check: does this JSON value look like a CORD invite bundle? */
export function isCordInvite(value: unknown): value is CordInvite {
  const v = value as CordInvite | null;
  return Boolean(
    v &&
      typeof v === "object" &&
      v.proto === "cord" &&
      typeof v.community_id === "string" &&
      typeof v.owner === "string" &&
      typeof v.owner_salt === "string" &&
      typeof v.root_key === "string",
  );
}

/**
 * Reconstruct a member-view CORD Community from an invite bundle. REFUSES a
 * bundle whose `(owner, owner_salt)` fail to reproduce its `community_id` —
 * an impostor cannot smuggle a false owner or a fake key for a real community.
 */
export function acceptCordInvite(invite: CordInvite): Community {
  if ((invite.channels?.length ?? 0) > MAX_INVITE_CHANNELS) {
    throw new Error(`invite declares too many channels (${invite.channels.length})`);
  }
  const id = hex32(invite.community_id);
  const owner = hex32(invite.owner);
  const salt = hex32(invite.owner_salt);
  if (!verifyCordCommunityId(id, owner, salt)) {
    throw new Error("invite owner proof does not reproduce the community id");
  }
  const rootKey = hex32(invite.root_key);
  const rootEpoch = BigInt(invite.root_epoch ?? 0);

  const channels: Channel[] = (invite.channels ?? []).map((ic) => {
    if (ic.private && ic.key) {
      return {
        id: hex32(ic.id),
        key: hex32(ic.key),
        epoch: BigInt(ic.epoch ?? 0),
        name: ic.name,
        epochKeys: [],
      };
    }
    return {
      id: hex32(ic.id),
      key: rootKey,
      epoch: rootEpoch,
      name: ic.name,
      epochKeys: [],
      derived: true,
    };
  });

  return {
    id,
    serverRootKey: rootKey,
    serverRootEpoch: rootEpoch,
    name: invite.name,
    relays: capRelays(invite.relays ?? []),
    channels,
    proto: "cord",
    owner: invite.owner,
    ownerSalt: invite.owner_salt,
    ...(invite.icon !== undefined ? { icon: invite.icon } : {}),
    ...(invite.prior_roots?.length
      ? { priorRoots: invite.prior_roots.map((r) => ({ epoch: BigInt(r.epoch), key: hexToBytes(r.key) })) }
      : {}),
  };
}
