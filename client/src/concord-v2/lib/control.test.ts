import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildBanlistEdition,
  buildChannelEdition,
  buildGrantEdition,
  buildMetadataEdition,
  buildRegistryEdition,
  buildRoleEdition,
  foldControlState,
  isDissolved,
  openControlWraps,
  sealDissolved,
  sealEdition,
} from "@/concord-v2/lib/control";
import { bytesToHex, communityIdOf, controlGroupKey, hex32, random32 } from "@/concord-v2/lib/derive";
import { rewrapSeal } from "@/concord-v2/lib/stream";
import { adminRole, hasPermission, isAdmin, Permissions } from "@/concord-v2/lib/roles";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

async function makeCommunity() {
  const owner = signer();
  const ownerSalt = random32();
  const communityId = communityIdOf(hex32(owner.pubkey), ownerSalt);
  const root = random32();
  const control = controlGroupKey(root, communityId, 0);
  return { owner, ownerSalt, communityId, root, control };
}

describe("control plane fold (CORD-04)", () => {
  it("folds the genesis metadata + #general channel", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const channelId = random32();

    const wraps: NostrEvent[] = [
      await sealEdition(
        buildMetadataEdition(communityId, { name: "Vector", relays: ["wss://a.example"] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      await sealEdition(
        buildChannelEdition(channelId, { name: "general", private: false }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.metadata?.name).toBe("Vector");
    expect(folded.channels.get(bytesToHex(channelId))?.name).toBe("general");
    expect(folded.channels.get(bytesToHex(channelId))?.isPrivate).toBe(false);
  });

  it("admits an admin's edits only through an owner-rooted grant", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const stranger = signer();

    const role = adminRole(bytesToHex(random32()));
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(role, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [role.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      // The admin (MANAGE_METADATA holder) renames the community — honored.
      await sealEdition(
        buildMetadataEdition(communityId, { name: "Renamed", relays: [] }, { actorPubkey: admin.pubkey, version: 1n }),
        control,
        admin,
      ),
      // A stranger grants themselves a role — dropped (not owner-rooted).
      await sealEdition(
        buildGrantEdition(communityId, { member: stranger.pubkey, roleIds: [role.roleId] }, { actorPubkey: stranger.pubkey, version: 2n }),
        control,
        stranger,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(true);
    expect(hasPermission(folded.roster, stranger.pubkey, Permissions.MANAGE_ROLES)).toBe(false);
    expect(folded.metadata?.name).toBe("Renamed");
  });

  it("refuses a downgrade: a replayed stale banlist never wins", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const target = signer();

    const v1 = buildBanlistEdition(communityId, [target.pubkey], { actorPubkey: owner.pubkey, version: 1n });
    const v1Wrap = await sealEdition(v1, control, owner);
    const [v1Parsed] = openControlWraps([v1Wrap], [control]);
    const v2 = buildBanlistEdition(communityId, [], {
      actorPubkey: owner.pubkey,
      version: 2n,
      prevHash: v1Parsed.selfHash,
    });
    const v2Wrap = await sealEdition(v2, control, owner);

    // Both editions present (a relay replaying the stale v1 alongside v2).
    const all = openControlWraps([v1Wrap, v2Wrap], [control]);
    const folded = foldControlState(all, communityId, owner.pubkey);
    expect(folded.banned.has(target.pubkey)).toBe(false); // v2 (the unban) wins
  });

  it("ignores a banlist from a non-BAN holder (fail closed)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const rando = signer();
    const wraps = [
      await sealEdition(buildBanlistEdition(communityId, [owner.pubkey], { actorPubkey: rando.pubkey, version: 1n }), control, rando),
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.size).toBe(0);
  });

  it("registry: each creator owns exactly their own list; the aggregate is the Public flag", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const linkSigner = bytesToHex(random32());
    const forger = signer();

    const wraps = [
      await sealEdition(buildRegistryEdition(communityId, owner.pubkey, [linkSigner], { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      // A forger publishing at the OWNER's registry coordinate is dropped.
      await sealEdition(buildRegistryEdition(communityId, owner.pubkey, ["ff".repeat(32)], { actorPubkey: forger.pubkey, version: 2n }), control, forger),
    ];
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.liveInviteLinks.has(linkSigner)).toBe(true);
    expect(folded.liveInviteLinks.has("ff".repeat(32))).toBe(false);
  });

  it("a compaction re-wrap folds for a fresh joiner despite the dangling prev", async () => {
    const { owner, communityId, root, control } = await makeCommunity();

    // Two chained metadata editions at epoch 0.
    const m1 = buildMetadataEdition(communityId, { name: "One", relays: [] }, { actorPubkey: owner.pubkey, version: 1n });
    const p1 = openControlWraps([await sealEdition(m1, control, owner)], [control])[0];
    const m2 = buildMetadataEdition(communityId, { name: "Two", relays: [] }, { actorPubkey: owner.pubkey, version: 2n, prevHash: p1.selfHash });
    const p2 = openControlWraps([await sealEdition(m2, control, owner)], [control])[0];

    // Refounding: re-wrap ONLY the head into epoch 1 (plaintext seal survives).
    const control1 = controlGroupKey(root, communityId, 1); // (test shortcut: same root, new epoch address)
    const rewrapped = rewrapSeal(p2.opened.seal, control1);

    const joinerView = openControlWraps([rewrapped], [control1]);
    const folded = foldControlState(joinerView, communityId, owner.pubkey);
    expect(folded.metadata?.name).toBe("Two"); // accepted despite prev citing an absent edition
  });
});

describe("dissolution (CORD-02 §9)", () => {
  it("only the owner's tombstone counts", async () => {
    const { owner, communityId } = await makeCommunity();
    const impostor = signer();

    const real = await sealDissolved(communityId, owner.pubkey, owner);
    const fake = await sealDissolved(communityId, impostor.pubkey, impostor);

    expect(isDissolved([fake], communityId, owner.pubkey)).toBe(false);
    expect(isDissolved([fake, real], communityId, owner.pubkey)).toBe(true);
  });
});
