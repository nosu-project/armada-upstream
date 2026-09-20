/**
 * Guards against handing out Private Channel keys the protocol says the
 * recipient may not have.
 *
 * Every `it` here asserts a NORMATIVE property. When first written they all
 * FAILED against the shipped code — each was the shipped behaviour, not a
 * model of it: the invite dialog sent a Direct Invite with no channel
 * narrowing, public links were minted the same way and re-published after a
 * revoke rotation, and a channel's access Role was minted at
 * `mintablePosition`, the HIGHEST rank its signer may claim. They pass now and
 * stay written against the same functions the real call paths use
 * (`vendableChannels`, `accessRolePosition`, the channel-cut merge), so a
 * regression in any of them fails here rather than in the field.
 *
 * The governing clause is CORD-03 §1. A Channel is defined by who may read
 * it, and there are exactly two kinds: Public, "readable by every member",
 * whose key derives from the `community_root`; and Private, "readable only by
 * granted role-holders", whose key is "an independent random secret,
 * delivered on grant and rekeyed on removal (CORD-06)". CORD-04 §2 names
 * those role-holders — a Role's `scope: {kind:"channel", channel_id}` — and
 * CORD-06 §1 works the pair as its motivating example.
 *
 * CORD-05 §1 calling `channels` "the granted Channels" is not a licence to
 * vend all of them. It makes the set the creator's CHOICE, and the choice is
 * still bounded by who the Channel is readable by: a bundle that carries a
 * key to someone holding none of its scoped Roles makes "readable only by
 * granted role-holders" false, and there is no third channel kind to land in.
 */

import { describe, expect, it } from "vitest";

import { isEntitled, vendableChannels } from "./channelAccess";
import { applyChannelCuts, mergeChannelCuts } from "./communityList";
import { bytesToHex } from "./derive";
import {
  accessRolePosition,
  adminRole,
  canActOnMember,
  grantRefusal,
  mintablePosition,
  Permissions,
  type CommunityRoles,
  type Role,
} from "./roles";

const bytes32 = (prefix: string) =>
  Uint8Array.from(prefix.repeat(64).slice(0, 64).match(/.{2}/g)!.map((b) => parseInt(b, 16)));

const OWNER = "f".repeat(64);
const ADMIN = "a".repeat(64);
/** A plain member: holds no Role at all until one is granted below. */
const MEMBER = "b".repeat(64);

const CH_SECRET = "aa".repeat(32); // #secret — private, role-gated
const CH_MODS = "bb".repeat(32); // #mods — private, role-gated, different role

const ROLE_ADMIN = "11".repeat(32);
const ROLE_SECRET = "22".repeat(32); // scoped to #secret
const ROLE_MODS = "33".repeat(32); // scoped to #mods

/** The access Role a private channel is born with (`mintChannelRole`). */
const accessRole = (roleId: string, name: string, channelId: string, position: number): Role => ({
  roleId,
  name,
  position,
  permissions: 0n, // read access is key possession, never a bit (CORD-04 §1)
  scope: { kind: "channel", channelId },
  color: 0,
});

/** A community with two role-gated private channels; MEMBER is entitled to neither. */
const roster: CommunityRoles = {
  roles: [
    adminRole(ROLE_ADMIN),
    accessRole(ROLE_SECRET, "secret", CH_SECRET, 2),
    accessRole(ROLE_MODS, "mods", CH_MODS, 2),
  ],
  grants: [{ member: ADMIN, roleIds: [ROLE_ADMIN] }],
};

/** What the inviter holds: the keys to both private channels. */
const heldByInviter = [{ id: bytes32("aa") }, { id: bytes32("bb") }];
describe("CORD-03 §1 — a Private Channel is readable only by granted role-holders", () => {
  it("a Direct Invite must not carry a channel key the recipient holds no scoped Role for", () => {
    // Exactly what `InviteDialog.tsx:70` -> `buildBundle` computes for a
    // plain "invite this person": a known npub, so entitlement is decidable.
    const vended = vendableChannels(heldByInviter, {
      kind: "member",
      roster,
      ownerHex: OWNER,
      memberHex: MEMBER,
    });

    const leaked = vended
      .map((ch) => bytesToHex(ch.id))
      .filter((idHex) => !isEntitled(roster, OWNER, MEMBER, idHex));

    // MEMBER holds neither scoped Role, so on the moment they accept they can
    // read #secret and #mods — "delivered on grant" (CORD-03 §1) with no
    // grant anywhere in the causal chain.
    expect(leaked).toEqual([]);
  });

  it("a public link bundle must not carry a role-gated channel key at all", () => {
    // `useInvites.ts:336` mints with no narrowing either. A link has no
    // recipient to be entitled: CORD-05 §2 is explicit that "anyone the link
    // reaches can join", and §3 puts the bootstrap relays in the fragment so
    // it travels plaintext channels. Whoever follows it holds no Role, so the
    // entitled set for an unknown joiner is empty by construction.
    const vended = vendableChannels(heldByInviter, { kind: "link" }).map((ch) => bytesToHex(ch.id));

    const gated = vended.filter((idHex) => !isEntitled(roster, OWNER, "0".repeat(64), idHex));

    expect(gated).toEqual([]);
  });

  it("a partly-entitled recipient must still be refused the channels they hold no Role for", () => {
    // Entitlement is per channel, so the bug is not only "unentitled people
    // get keys": a member granted #secret is handed #mods in the same bundle.
    const entitledRoster: CommunityRoles = {
      ...roster,
      grants: [...roster.grants, { member: MEMBER, roleIds: [ROLE_SECRET] }],
    };
    expect(isEntitled(entitledRoster, OWNER, MEMBER, CH_SECRET)).toBe(true);
    expect(isEntitled(entitledRoster, OWNER, MEMBER, CH_MODS)).toBe(false);

    const vended = vendableChannels(heldByInviter, {
      kind: "member",
      roster: entitledRoster,
      ownerHex: OWNER,
      memberHex: MEMBER,
    }).map((c) => bytesToHex(c.id));

    expect(vended).toContain(CH_SECRET);
    expect(vended).not.toContain(CH_MODS);
  });
});

describe("CORD-06 §1 — a rekey severs the removed member", () => {
  it("the post-rotation link refresh must not re-vend the channel it just rotated", () => {
    // `useChannelRekey` rotates #secret to epoch 5 to cut MEMBER, then
    // `useRekey.ts:904` calls `refreshInviteBundlesFor`, which rebuilds every
    // link bundle by the same "everything held" rule — now carrying the FRESH
    // key at epoch 5.
    const rotatedHeld = [{ id: bytes32("aa") }];
    const refreshed = vendableChannels(rotatedHeld, { kind: "link" }).map((c) => bytesToHex(c.id));

    expect(refreshed).not.toContain(CH_SECRET);
  });

  it("PASSES, and shows why the fix belongs in the refresh and not in the floor", () => {
    // The cut is recorded AT the excluding epoch (`useRekey.ts:782`), and the
    // floor admits `epoch >= cut` deliberately, so that a real re-admission —
    // an admin handing over the current key by Direct Invite — still lands.
    // The refreshed link bundle carries that same current key at that same
    // epoch, so the two are byte-indistinguishable at the floor: tightening
    // it to `>` would break re-admission without closing the hole, because
    // the next rotation moves both to epoch 6 together.
    const cuts = mergeChannelCuts([{ id: CH_SECRET, epoch: 5 }], undefined);
    const readmission = [{ id: CH_SECRET, key: "9".repeat(64), epoch: 5, name: "secret" }];
    const fromRefreshedLink = [{ id: CH_SECRET, key: "9".repeat(64), epoch: 5, name: "secret" }];

    expect(applyChannelCuts(readmission, cuts)).toEqual(readmission);
    expect(applyChannelCuts(fromRefreshedLink, cuts)).toEqual(fromRefreshedLink);
  });
});

describe("CORD-04 §3 — position orders authority, and read access is not authority", () => {
  // The community as it stands when the owner creates a private channel.
  const before: CommunityRoles = {
    roles: [adminRole(ROLE_ADMIN)],
    grants: [{ member: ADMIN, roleIds: [ROLE_ADMIN] }],
  };
  // What `mintChannelRole` now mints at.
  const mintedPosition = accessRolePosition(before, OWNER, OWNER)!;
  const ownerMinted: CommunityRoles = {
    roles: [adminRole(ROLE_ADMIN), accessRole(ROLE_SECRET, "secret", CH_SECRET, mintedPosition)],
    grants: [
      { member: ADMIN, roleIds: [ROLE_ADMIN] },
      { member: MEMBER, roleIds: [ROLE_SECRET] }, // granted read access, nothing else
    ],
  };

  it("mints the access role BELOW every existing role, not at the signer's ceiling", () => {
    // `mintablePosition` answers "how high may this signer reach" — the right
    // question for an authority Role, and the root of the next two failures
    // when asked about an access Role. The owner's ceiling is position 1,
    // which is the stock Admin rank.
    expect(mintablePosition(before, OWNER, OWNER)).toBe(adminRole(ROLE_ADMIN).position);
    expect(mintedPosition).toBeGreaterThan(adminRole(ROLE_ADMIN).position);
  });

  it("granting read access must not make a member unbannable by an Admin", () => {
    // A member's rank is the LOWEST position among their Roles (CORD-04 §3),
    // and rank is independent of permission bits — so a zero-permission
    // access Role at position 1 promotes MEMBER to the Admin rank. "Equal
    // cannot act on equal" then locks every Admin out of moderating them.
    expect(canActOnMember(ownerMinted, ADMIN, OWNER, MEMBER, Permissions.BAN)).toBe(true);
    expect(canActOnMember(ownerMinted, ADMIN, OWNER, MEMBER, Permissions.KICK)).toBe(true);
  });

  it("an Admin must be able to grant access to a channel the owner created", () => {
    // The same collision seen from the roster side: a Grant is honored only
    // if its signer outranks every Role it hands out, so no Admin can ever
    // add anyone to an owner-created private channel. Access management
    // becomes owner-only, silently.
    expect(grantRefusal(ownerMinted, ADMIN, OWNER, MEMBER, [ROLE_SECRET])).toBeUndefined();
  });
});
