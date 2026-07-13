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
import { adminRole, badgeOf, hasPermission, isAdmin, moderatorRole, Permissions, type Role } from "@/concord-v2/lib/roles";

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

  it("an admin can mint + grant the stock Moderator (position 2), but not a peer Admin", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const mod = signer();
    const wannabe = signer();

    const adm = adminRole(bytesToHex(random32()));
    const mrole = moderatorRole(bytesToHex(random32()));
    const peerAdm = adminRole(bytesToHex(random32()));
    const wraps: NostrEvent[] = [
      // Owner roots the Admin.
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      // The admin (position 1) mints Moderator (position 2) and grants it — honored.
      await sealEdition(buildRoleEdition(mrole, { actorPubkey: admin.pubkey, version: 1n }), control, admin),
      await sealEdition(
        buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: admin.pubkey, version: 1n }),
        control,
        admin,
      ),
      // The admin mints a PEER Admin (position 1) — dropped (equal cannot act on equal).
      await sealEdition(buildRoleEdition(peerAdm, { actorPubkey: admin.pubkey, version: 1n }), control, admin),
      await sealEdition(
        buildGrantEdition(communityId, { member: wannabe.pubkey, roleIds: [peerAdm.roleId] }, { actorPubkey: admin.pubkey, version: 1n }),
        control,
        admin,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(badgeOf(folded.roster, admin.pubkey)).toBe("admin");
    expect(badgeOf(folded.roster, mod.pubkey)).toBe("moderator");
    expect(hasPermission(folded.roster, mod.pubkey, Permissions.BAN)).toBe(true);
    expect(hasPermission(folded.roster, mod.pubkey, Permissions.MANAGE_ROLES)).toBe(false);
    expect(badgeOf(folded.roster, wannabe.pubkey)).toBeUndefined();
  });

  it("a moderator (no MANAGE_ROLES) cannot grant roles", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const mod = signer();
    const friend = signer();

    const mrole = moderatorRole(bytesToHex(random32()));
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(mrole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(
        buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      // The moderator hands their friend the same role — dropped.
      await sealEdition(
        buildGrantEdition(communityId, { member: friend.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: mod.pubkey, version: 1n }),
        control,
        mod,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(badgeOf(folded.roster, mod.pubkey)).toBe("moderator");
    expect(badgeOf(folded.roster, friend.pubkey)).toBeUndefined();
  });

  it("a roleless member cannot revoke a grant (an empty role_ids edition needs authority)", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const rando = signer();

    const adm = adminRole(bytesToHex(random32()));
    const roleWrap = await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const grantWrap = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    // The forged revoke chains off the REAL head (any member can read the plane).
    const [grantV1] = openControlWraps([grantWrap], [control]);
    const revokeWrap = await sealEdition(
      buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [] }, { actorPubkey: rando.pubkey, version: 2n, prevHash: grantV1.selfHash }),
      control,
      rando,
    );

    const folded = foldControlState(openControlWraps([roleWrap, grantWrap, revokeWrap], [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(true); // the revoke was dropped
  });

  it("a lower-ranked MANAGE_ROLES holder cannot strip or demote a grant above their rank", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const lt = signer(); // position 2, holds MANAGE_ROLES
    const admin1 = signer(); // strip target
    const admin2 = signer(); // demote target
    const newbie = signer();

    const adm = adminRole(bytesToHex(random32()));
    const ltRole: Role = { roleId: bytesToHex(random32()), name: "Lieutenant", position: 2, permissions: Permissions.MANAGE_ROLES, scope: { kind: "server" }, color: 0 };
    const lowRole: Role = { roleId: bytesToHex(random32()), name: "Helper", position: 3, permissions: 0n, scope: { kind: "server" }, color: 0 };

    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(ltRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(lowRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      // The lieutenant's own authority settles BEFORE the victims' entities.
      await sealEdition(buildGrantEdition(communityId, { member: lt.pubkey, roleIds: [ltRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    ];
    const g1 = await sealEdition(buildGrantEdition(communityId, { member: admin1.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const g2 = await sealEdition(buildGrantEdition(communityId, { member: admin2.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner);
    const [g1v1] = openControlWraps([g1], [control]);
    const [g2v1] = openControlWraps([g2], [control]);
    wraps.push(
      g1,
      g2,
      // Strip admin1 — dropped (a revoke acts on a rank the lieutenant doesn't outrank).
      await sealEdition(
        buildGrantEdition(communityId, { member: admin1.pubkey, roleIds: [] }, { actorPubkey: lt.pubkey, version: 2n, prevHash: g1v1.selfHash }),
        control,
        lt,
      ),
      // Demote admin2 to the Helper role — dropped (outranking the role handed OUT is not enough).
      await sealEdition(
        buildGrantEdition(communityId, { member: admin2.pubkey, roleIds: [lowRole.roleId] }, { actorPubkey: lt.pubkey, version: 2n, prevHash: g2v1.selfHash }),
        control,
        lt,
      ),
      // A fresh grant BELOW the lieutenant's rank — honored.
      await sealEdition(
        buildGrantEdition(communityId, { member: newbie.pubkey, roleIds: [lowRole.roleId] }, { actorPubkey: lt.pubkey, version: 1n }),
        control,
        lt,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(isAdmin(folded.roster, admin1.pubkey)).toBe(true);
    expect(badgeOf(folded.roster, admin2.pubkey)).toBe("admin");
    expect(folded.roster.grants.some((g) => g.member === newbie.pubkey && g.roleIds.includes(lowRole.roleId))).toBe(true);
  });

  it("a lower-ranked MANAGE_ROLES holder cannot reposition a role above their rank", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const lt = signer();

    const adm = adminRole(bytesToHex(random32()));
    const ltRole: Role = { roleId: bytesToHex(random32()), name: "Lieutenant", position: 2, permissions: Permissions.MANAGE_ROLES, scope: { kind: "server" }, color: 0 };
    const mrole = moderatorRole(bytesToHex(random32())); // minted by the ADMIN (position 2)

    const modV1 = await sealEdition(buildRoleEdition(mrole, { actorPubkey: admin.pubkey, version: 1n }), control, admin);
    const [modV1Parsed] = openControlWraps([modV1], [control]);
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(ltRole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildGrantEdition(communityId, { member: lt.pubkey, roleIds: [ltRole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      modV1,
      // The lieutenant (position 2) shoves the peer Moderator role to position 5 — dropped.
      await sealEdition(
        buildRoleEdition({ ...mrole, position: 5, permissions: 0n }, { actorPubkey: lt.pubkey, version: 2n, prevHash: modV1Parsed.selfHash }),
        control,
        lt,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    const settled = folded.roster.roles.find((r) => r.roleId === mrole.roleId);
    expect(settled?.position).toBe(2);
    expect(settled?.permissions).toBe(mrole.permissions);
  });

  it("an outranking MANAGE_ROLES holder's revoke still lands", async () => {
    const { owner, communityId, control } = await makeCommunity();
    const admin = signer();
    const mod = signer();

    const adm = adminRole(bytesToHex(random32()));
    const mrole = moderatorRole(bytesToHex(random32()));
    const modGrant = await sealEdition(
      buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [modGrantV1] = openControlWraps([modGrant], [control]);
    const wraps: NostrEvent[] = [
      await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildRoleEdition(mrole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      await sealEdition(buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
      modGrant,
      // The admin (position 1) strips the moderator (rank 2) — honored.
      await sealEdition(
        buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [] }, { actorPubkey: admin.pubkey, version: 2n, prevHash: modGrantV1.selfHash }),
        control,
        admin,
      ),
    ];

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(badgeOf(folded.roster, mod.pubkey)).toBeUndefined();
    expect(isAdmin(folded.roster, admin.pubkey)).toBe(true);
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
