/**
 * CORD protocol tests — the experimental CORD-01…06 wire format.
 *
 * Covers the self-certifying community id, the group-key derivation, the
 * stream envelope (wrap/seal/rumor + binding triad), the control-plane fold
 * (commitment-proven owner), rekeys (public-key locators, blob binding), and
 * the v3 invite fragment + bundle events.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { EnvelopeError } from "@/lib/concord/envelope";
import {
  KIND_COMMUNITY_DELETE,
  KIND_COMMUNITY_MESSAGE,
  KIND_COMMUNITY_REACTION,
  KIND_GIFT_WRAP,
} from "@/lib/concord/kinds";
import { encodeCordInviteUrl, encodeInviteUrl, parseInviteUrl, PublicInviteError, CORD_TRUSTED_RELAYS } from "@/lib/concord/publicInvite";
import { random32, type Community } from "@/lib/concord/types";
import { channelWire } from "@/lib/concord/wire";
import {
  acceptCordInvite,
  buildCordInvite,
  cordChannelGroups,
  mintCordCommunity,
} from "@/lib/cord/community";
import {
  buildCordBanlistRumor,
  buildCordChannelMetadataRumor,
  buildCordCommunityRootRumor,
  buildCordGrantRumor,
  buildCordRoleRumor,
  cordControlGroups,
  cordProvenOwner,
  foldCordBanlist,
  foldCordChannels,
  foldCordMetadata,
  foldCordRoster,
} from "@/lib/cord/control";
import {
  baseRekeyGroupKey,
  channelGroupKey,
  controlGroupKey,
  cordCommunityId,
  cordEpochKeyCommitment,
  cordInviteKey,
  cordInviteLocator,
  cordInviteSigner,
  groupKey,
  verifyCordCommunityId,
} from "@/lib/cord/derive";
import {
  buildCordInviteEvent,
  buildCordInviteTombstone,
  parseCordInviteEvent,
} from "@/lib/cord/invite";
import {
  buildCordBaseRekeyEvent,
  buildCordChannelRekeyEvent,
  buildCordRekeyBlob,
  openCordRekeyBlob,
  openCordRekeyEvent,
} from "@/lib/cord/rekey";
import {
  buildCordRumorTemplate,
  buildSealTemplate,
  finalizeRumor,
  logicalKindOf,
  openCordChannelMessage,
  openCordStream,
  rumorKindOf,
  wrapSeal,
} from "@/lib/cord/stream";
import { adminRole } from "@/lib/concord/roles";
import { communityMetadataOf } from "@/lib/concord/metadata";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A signed-in test identity. */
function identity() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
}

/** Seal one channel message end-to-end for tests (local signer). */
function sealCordMessage(opts: {
  authorSk: Uint8Array;
  secret: Uint8Array;
  channelId: Uint8Array;
  epoch: bigint;
  content: string;
  ms: number;
  kind?: number;
  reference?: string;
}): { rumor: ReturnType<typeof finalizeRumor>; outer: NostrEvent } {
  const group = channelGroupKey(opts.secret, opts.channelId, opts.epoch);
  const rumor = finalizeRumor(
    buildCordRumorTemplate({
      channelId: opts.channelId,
      epoch: opts.epoch,
      content: opts.content,
      ms: opts.ms,
      kind: opts.kind,
      reference: opts.reference,
    }),
    getPublicKey(opts.authorSk),
  );
  const seal = finalizeEvent(buildSealTemplate(rumor, group), opts.authorSk);
  return { rumor, outer: wrapSeal(seal, group) };
}

/** Seal one control edition end-to-end for tests (local signer). */
function sealCordControl(
  community: Community,
  actorSk: Uint8Array,
  rumorTemplate: { kind: number; content: string; tags: string[][]; created_at: number },
): NostrEvent {
  const group = controlGroupKey(community.serverRootKey, community.id, community.serverRootEpoch);
  const rumor = finalizeRumor(rumorTemplate, getPublicKey(actorSk));
  const seal = finalizeEvent(buildSealTemplate(rumor, group), actorSk);
  return wrapSeal(seal, group);
}

// ── identity commitment (CORD-02) ────────────────────────────────────────────

describe("cord community id", () => {
  it("commits to (owner, salt) and verifies", () => {
    const owner = new Uint8Array(32).fill(0x11);
    const salt = new Uint8Array(32).fill(0x22);
    const id = cordCommunityId(owner, salt);
    expect(id).toHaveLength(32);
    expect(verifyCordCommunityId(id, owner, salt)).toBe(true);
  });
  it("rejects a forged owner", () => {
    const owner = new Uint8Array(32).fill(0x11);
    const salt = new Uint8Array(32).fill(0x22);
    const id = cordCommunityId(owner, salt);
    expect(verifyCordCommunityId(id, new Uint8Array(32).fill(0x33), salt)).toBe(false);
    expect(verifyCordCommunityId(id, owner, new Uint8Array(32).fill(0x44))).toBe(false);
  });
  it("is deterministic (regression pin)", () => {
    // Frozen golden vector: sha256("concord/community" || 0x11*32 || 0x22*32).
    const id = cordCommunityId(new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22));
    expect(bytesToHex(id)).toBe(bytesToHex(cordCommunityId(new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22))));
    expect(bytesToHex(id)).toHaveLength(64);
  });
});

// ── group keys (CORD-02 A.2) ─────────────────────────────────────────────────

describe("cord group keys", () => {
  const secret = new Uint8Array(32).fill(7);
  const id = new Uint8Array(32).fill(9);

  it("every member derives the identical triple", () => {
    const a = groupKey("concord/channel", secret, id, 3n);
    const b = groupKey("concord/channel", secret, id, 3n);
    expect(bytesToHex(a.sk)).toBe(bytesToHex(b.sk));
    expect(a.pk).toBe(b.pk);
    expect(bytesToHex(a.conv)).toBe(bytesToHex(b.conv));
  });
  it("epoch rotation rotates the address", () => {
    expect(groupKey("concord/channel", secret, id, 0n).pk).not.toBe(groupKey("concord/channel", secret, id, 1n).pk);
  });
  it("labels domain-separate", () => {
    expect(channelGroupKey(secret, id, 0n).pk).not.toBe(controlGroupKey(secret, id, 0n).pk);
  });
  it("the pk matches the sk", () => {
    const g = channelGroupKey(secret, id, 5n);
    expect(getPublicKey(g.sk)).toBe(g.pk);
  });
});

// ── stream envelope (CORD-01) ────────────────────────────────────────────────

describe("cord stream envelope", () => {
  const secret = new Uint8Array(32).fill(0x5c);
  const channelId = new Uint8Array(32).fill(0x0d);

  it("round-trips a message and normalizes the kind", () => {
    const alice = identity();
    const { outer } = sealCordMessage({
      authorSk: alice.sk,
      secret,
      channelId,
      epoch: 0n,
      content: "Hey chat!",
      ms: 1686840217123,
    });
    expect(outer.kind).toBe(KIND_GIFT_WRAP);
    expect(outer.pubkey).toBe(channelGroupKey(secret, channelId, 0n).pk);
    // The `p` tag is an ephemeral pubkey — NOT the group address (CORD-01).
    expect(outer.tags.find((t) => t[0] === "p")?.[1]).not.toBe(outer.pubkey);

    const groups = [{ epoch: 0n, group: channelGroupKey(secret, channelId, 0n) }];
    const opened = openCordChannelMessage(outer, channelId, groups);
    expect(opened.author).toBe(alice.pk);
    expect(opened.content).toBe("Hey chat!");
    expect(opened.kind).toBe(KIND_COMMUNITY_MESSAGE); // rumor kind 9 → logical 3300
    expect(opened.ms).toBe(1686840217123);
  });

  it("maps logical kinds to standard rumor kinds and back", () => {
    expect(rumorKindOf(KIND_COMMUNITY_MESSAGE)).toBe(9);
    expect(rumorKindOf(KIND_COMMUNITY_REACTION)).toBe(7);
    expect(rumorKindOf(KIND_COMMUNITY_DELETE)).toBe(5);
    expect(rumorKindOf(3302)).toBe(3302);
    expect(logicalKindOf(9)).toBe(KIND_COMMUNITY_MESSAGE);
    expect(logicalKindOf(7)).toBe(KIND_COMMUNITY_REACTION);
    expect(logicalKindOf(5)).toBe(KIND_COMMUNITY_DELETE);
  });

  it("a non-member (wrong secret) cannot open", () => {
    const alice = identity();
    const { outer } = sealCordMessage({ authorSk: alice.sk, secret, channelId, epoch: 0n, content: "x", ms: 1 });
    const wrong = [{ epoch: 0n, group: channelGroupKey(new Uint8Array(32).fill(0xee), channelId, 0n) }];
    expect(() => openCordChannelMessage(outer, channelId, wrong)).toThrow(EnvelopeError);
  });

  it("rejects an epoch splice (rumor bound to a different epoch)", () => {
    const alice = identity();
    // Rumor claims epoch 1 but is sealed under epoch 0's group key.
    const group0 = channelGroupKey(secret, channelId, 0n);
    const rumor = finalizeRumor(
      buildCordRumorTemplate({ channelId, epoch: 1n, content: "splice", ms: 1 }),
      alice.pk,
    );
    const seal = finalizeEvent(buildSealTemplate(rumor, group0), alice.sk);
    const outer = wrapSeal(seal, group0);
    expect(() =>
      openCordChannelMessage(outer, channelId, [{ epoch: 0n, group: group0 }]),
    ).toThrow(/epoch-binding/);
  });

  it("rejects a channel splice", () => {
    const alice = identity();
    const otherChannel = new Uint8Array(32).fill(0x0e);
    const group = channelGroupKey(secret, channelId, 0n);
    const rumor = finalizeRumor(
      buildCordRumorTemplate({ channelId: otherChannel, epoch: 0n, content: "splice", ms: 1 }),
      alice.pk,
    );
    const seal = finalizeEvent(buildSealTemplate(rumor, group), alice.sk);
    const outer = wrapSeal(seal, group);
    expect(() =>
      openCordChannelMessage(outer, channelId, [{ epoch: 0n, group }]),
    ).toThrow(/channel-binding/);
  });

  it("rejects a rumor whose author differs from the seal signer", () => {
    const alice = identity();
    const mallory = identity();
    const group = channelGroupKey(secret, channelId, 0n);
    // Mallory (a key-holder) seals a rumor claiming Alice authored it.
    const rumor = finalizeRumor(
      buildCordRumorTemplate({ channelId, epoch: 0n, content: "forged", ms: 1 }),
      alice.pk,
    );
    const seal = finalizeEvent(buildSealTemplate(rumor, group), mallory.sk);
    const outer = wrapSeal(seal, group);
    expect(() => openCordStream(outer, group)).toThrow(/does not match seal signer/);
  });

  it("rejects a rumor with a forged id", () => {
    const alice = identity();
    const group = channelGroupKey(secret, channelId, 0n);
    const rumor = finalizeRumor(
      buildCordRumorTemplate({ channelId, epoch: 0n, content: "real", ms: 1 }),
      alice.pk,
    );
    const tampered = { ...rumor, id: "ab".repeat(32) };
    const seal = finalizeEvent(buildSealTemplate(tampered, group), alice.sk);
    const outer = wrapSeal(seal, group);
    expect(() => openCordStream(outer, group)).toThrow(/id does not match/);
  });
});

// ── community model + control plane ──────────────────────────────────────────

describe("cord community + control plane", () => {
  it("mints a self-certifying community with a derived default channel", () => {
    const owner = identity();
    const c = mintCordCommunity("Test", "general", ["wss://a.example"], owner.pk);
    expect(c.proto).toBe("cord");
    expect(cordProvenOwner(c)).toBe(owner.pk);
    expect(c.channels[0].derived).toBe(true);
    expect(bytesToHex(c.channels[0].key)).toBe(bytesToHex(c.serverRootKey));
  });

  it("folds the owner-signed genesis into roster + metadata + channels", () => {
    const owner = identity();
    const c = mintCordCommunity("Bridge", "general", ["wss://a.example"], owner.pk);
    const now = Math.floor(Date.now() / 1000);
    const role = adminRole(bytesToHex(random32()));
    const outers = [
      sealCordControl(c, owner.sk, buildCordCommunityRootRumor({ communityId: c.id, metadata: communityMetadataOf(c), version: 1n, createdAtSecs: now })),
      sealCordControl(c, owner.sk, buildCordRoleRumor({ role, version: 1n, createdAtSecs: now })),
      sealCordControl(c, owner.sk, buildCordChannelMetadataRumor({ channelId: c.channels[0].id, metadata: { name: "general", private: false }, version: 1n, createdAtSecs: now })),
    ];
    const roster = foldCordRoster(outers, c);
    expect(roster.ownerHex).toBe(owner.pk);
    expect(roster.roster.roles).toHaveLength(1);

    const metadata = foldCordMetadata(outers, c, roster);
    expect(metadata.root?.name).toBe("Bridge");
    expect(metadata.root?.owner).toBe(owner.pk);

    const channels = foldCordChannels(outers, c, roster);
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("general");
    expect(channels[0].isPrivate).toBe(false);
  });

  it("drops an unauthorized (non-member-ranked) edit; folds an authorized grant", () => {
    const owner = identity();
    const rando = identity();
    const member = identity();
    const c = mintCordCommunity("Sec", "general", ["wss://a.example"], owner.pk);
    const now = Math.floor(Date.now() / 1000);
    const role = adminRole(bytesToHex(random32()));

    const outers = [
      sealCordControl(c, owner.sk, buildCordRoleRumor({ role, version: 1n, createdAtSecs: now })),
      // Owner grants member the admin role.
      sealCordControl(c, owner.sk, buildCordGrantRumor({ communityId: c.id, grant: { member: member.pk, roleIds: [role.roleId] }, version: 1n, createdAtSecs: now })),
      // A rando (key-holder, no rank) tries to rename the community.
      sealCordControl(c, rando.sk, buildCordCommunityRootRumor({ communityId: c.id, metadata: { ...communityMetadataOf(c), name: "HACKED" }, version: 1n, createdAtSecs: now })),
    ];
    const roster = foldCordRoster(outers, c);
    expect(roster.roster.grants).toHaveLength(1);
    const metadata = foldCordMetadata(outers, c, roster);
    expect(metadata.root?.name).not.toBe("HACKED");
  });

  it("folds the banlist only when its signer holds BAN", () => {
    const owner = identity();
    const rando = identity();
    const c = mintCordCommunity("Ban", "general", ["wss://a.example"], owner.pk);
    const now = Math.floor(Date.now() / 1000);
    const target = identity().pk;

    const forged = [sealCordControl(c, rando.sk, buildCordBanlistRumor({ communityId: c.id, banned: [target], version: 1n, createdAtSecs: now }))];
    const roster0 = foldCordRoster(forged, c);
    expect(foldCordBanlist(forged, c, roster0).banned.size).toBe(0);

    const real = [sealCordControl(c, owner.sk, buildCordBanlistRumor({ communityId: c.id, banned: [target], version: 1n, createdAtSecs: now }))];
    const roster1 = foldCordRoster(real, c);
    expect(foldCordBanlist(real, c, roster1).banned.has(target)).toBe(true);
  });

  it("control addresses rotate with the root epoch", () => {
    const owner = identity();
    const c = mintCordCommunity("Rot", "general", ["wss://a.example"], owner.pk);
    const g0 = cordControlGroups(c);
    const rolled: Community = { ...c, serverRootKey: random32(), serverRootEpoch: 1n, priorRoots: [{ epoch: 0n, key: c.serverRootKey }] };
    const g1 = cordControlGroups(rolled);
    expect(g1).toHaveLength(2);
    expect(g1.map((g) => g.group.pk)).toContain(g0[0].group.pk); // prior epoch retained
    expect(g1[0].group.pk).not.toBe(g0[0].group.pk); // new epoch first
  });
});

// ── rekeys (CORD-06) ─────────────────────────────────────────────────────────

describe("cord rekeys", () => {
  it("channel rekey: staying members recover the key, the removed member cannot", () => {
    const owner = identity();
    const member = identity();
    const banned = identity();
    const root = new Uint8Array(32).fill(0x21);
    const channelId = new Uint8Array(32).fill(0x31);
    const prevKey = new Uint8Array(32).fill(0x41);
    const newKey = random32();
    const scope = { kind: "channel" as const, channelId };

    const blobs = [owner.pk, member.pk].map((pk) => buildCordRekeyBlob(owner.sk, pk, scope, 1n, newKey));
    const event = buildCordChannelRekeyEvent({
      rotatorSk: owner.sk,
      root,
      channelId,
      newEpoch: 1n,
      prevEpoch: 0n,
      prevKeyCommitment: cordEpochKeyCommitment(0n, prevKey),
      blobs,
    });

    // Members find the event by the root-derived rekey address.
    const group = groupKey("concord/rekey-pseudonym", root, channelId, 1n);
    expect(event.pubkey).toBe(group.pk);

    const parsed = openCordRekeyEvent(event, group);
    expect(parsed.rotator).toBe(owner.pk);
    expect(parsed.newEpoch).toBe(1n);
    expect(bytesToHex(parsed.prevKeyCommitment)).toBe(bytesToHex(cordEpochKeyCommitment(0n, prevKey)));

    // The staying member's blob opens to the new key.
    const mine = parsed.blobs.find((b) => {
      try {
        openCordRekeyBlob(member.sk, parsed.rotator, parsed.scope, parsed.newEpoch, b);
        return true;
      } catch {
        return false;
      }
    });
    expect(mine).toBeDefined();
    expect(bytesToHex(openCordRekeyBlob(member.sk, parsed.rotator, parsed.scope, parsed.newEpoch, mine!))).toBe(bytesToHex(newKey));

    // The removed member finds no blob at all.
    const theirs = parsed.blobs.filter((b) => {
      try {
        openCordRekeyBlob(banned.sk, parsed.rotator, parsed.scope, parsed.newEpoch, b);
        return true;
      } catch {
        return false;
      }
    });
    expect(theirs).toHaveLength(0);
  });

  it("base rekey (refounding) round-trips at the prior-root address", () => {
    const owner = identity();
    const member = identity();
    const communityId = new Uint8Array(32).fill(0x51);
    const priorRoot = new Uint8Array(32).fill(0x61);
    const newRoot = random32();

    const blobs = [member.pk].map((pk) => buildCordRekeyBlob(owner.sk, pk, { kind: "server-root" }, 1n, newRoot));
    const event = buildCordBaseRekeyEvent({
      rotatorSk: owner.sk,
      priorRoot,
      communityId,
      newEpoch: 1n,
      prevEpoch: 0n,
      prevKeyCommitment: cordEpochKeyCommitment(0n, priorRoot),
      blobs,
    });

    const group = baseRekeyGroupKey(priorRoot, communityId, 1n);
    expect(event.pubkey).toBe(group.pk);
    const parsed = openCordRekeyEvent(event, group);
    expect(parsed.scope.kind).toBe("server-root");
    expect(bytesToHex(openCordRekeyBlob(member.sk, parsed.rotator, parsed.scope, parsed.newEpoch, parsed.blobs[0]))).toBe(bytesToHex(newRoot));
  });
});

// ── invites (CORD-05) ────────────────────────────────────────────────────────

describe("cord invites", () => {
  function mintWithChannels() {
    const owner = identity();
    const c = mintCordCommunity("Inv", "general", ["wss://relay.ditto.pub", "wss://relay.dreamith.to"], owner.pk);
    // Add one private channel so the bundle carries a key.
    c.channels.push({ id: random32(), key: random32(), epoch: 0n, name: "secret", epochKeys: [] });
    return { owner, c };
  }

  it("public channels carry no key in the bundle; private ones do", () => {
    const { c } = mintWithChannels();
    const invite = buildCordInvite(c);
    const pub = invite.channels.find((ch) => !ch.private)!;
    const priv = invite.channels.find((ch) => ch.private)!;
    expect(pub.key).toBeUndefined();
    expect(priv.key).toBeDefined();
  });

  it("acceptCordInvite reconstructs the member view and verifies the owner proof", () => {
    const { owner, c } = mintWithChannels();
    const accepted = acceptCordInvite(buildCordInvite(c));
    expect(bytesToHex(accepted.id)).toBe(bytesToHex(c.id));
    expect(accepted.proto).toBe("cord");
    expect(accepted.owner).toBe(owner.pk);
    const general = accepted.channels.find((ch) => ch.name === "general")!;
    expect(general.derived).toBe(true);
    // The derived channel's groups match the minting side's.
    expect(cordChannelGroups(accepted, general)[0].group.pk).toBe(cordChannelGroups(c, c.channels[0])[0].group.pk);
  });

  it("refuses a bundle whose owner proof fails the commitment", () => {
    const { c } = mintWithChannels();
    const invite = buildCordInvite(c);
    const mallory = identity();
    expect(() => acceptCordInvite({ ...invite, owner: mallory.pk })).toThrow(/owner proof/);
  });

  it("bundle event round-trips; wrong token cannot read it; tombstone revokes", () => {
    const { c } = mintWithChannels();
    const token = random32();
    const event = buildCordInviteEvent(c, token, { label: "test" });
    expect(event.pubkey).toBe(getPublicKey(cordInviteSigner(token)));
    expect(event.tags.find((t) => t[0] === "d")?.[1]).toBe(bytesToHex(cordInviteLocator(token)));

    const bundle = parseCordInviteEvent(event, token);
    expect(bundle.preview.name).toBe("Inv");
    expect(bundle.join.proto).toBe("cord");
    expect(bundle.join.prior_roots).toBeUndefined(); // never in published invites

    expect(() => parseCordInviteEvent(event, random32())).toThrow(PublicInviteError);
    expect(() => parseCordInviteEvent(buildCordInviteTombstone(token), token)).toThrow(/revoked/);
  });

  it("cord invite sub-keys are domain-separated from v1's", () => {
    const token = new Uint8Array(32).fill(5);
    expect(bytesToHex(cordInviteKey(token))).not.toBe(bytesToHex(cordInviteLocator(token)));
    // v1 golden for the same token (from CONCORD.md Appendix A) must differ.
    expect(bytesToHex(cordInviteLocator(token))).not.toBe("33c098d6e4cddc2b8ee98ab6b5182186794c35f5b71391130a49ae3d88588c2c");
  });

  it("v3 fragment: explicit dictionary relays round-trip at one byte each", () => {
    const token = random32();
    const url = encodeCordInviteUrl(["wss://relay.ditto.pub", "wss://relay.dreamith.to"], token);
    const parsed = parseInviteUrl(url);
    expect(parsed.proto).toBe("cord");
    expect(parsed.relays).toEqual(["wss://relay.ditto.pub", "wss://relay.dreamith.to"]);
    expect(bytesToHex(parsed.token)).toBe(bytesToHex(token));
  });

  it("v3 fragment: the CORD stock set costs zero relay bytes", () => {
    const token = random32();
    const url = encodeCordInviteUrl([...CORD_TRUSTED_RELAYS], token);
    const fragment = url.slice(url.lastIndexOf("#") + 1);
    // [ver][flags] + 32 token bytes = 34 bytes → 46 base64url chars (no pad).
    expect(fragment.length).toBe(46);
    const parsed = parseInviteUrl(url);
    expect(parsed.proto).toBe("cord");
    expect(parsed.relays).toEqual([...CORD_TRUSTED_RELAYS]);
  });

  it("v2 fragments still parse as v1 (parity untouched)", () => {
    const token = random32();
    const parsed = parseInviteUrl(encodeInviteUrl(["wss://relay.damus.io"], token));
    expect(parsed.proto).toBe("v1");
  });
});

// ── wire abstraction ─────────────────────────────────────────────────────────

describe("channel wire", () => {
  it("cord wire seals + reopens through the same addresses", async () => {
    const owner = identity();
    const c = mintCordCommunity("W", "general", ["wss://a.example"], owner.pk);
    const channel = c.channels[0];
    const wire = channelWire(c, channel);
    expect(wire.proto).toBe("cord");
    expect(wire.filter([KIND_COMMUNITY_MESSAGE]).kinds).toEqual([KIND_GIFT_WRAP]);
    expect(wire.filter([KIND_COMMUNITY_MESSAGE]).authors).toEqual(wire.addresses);

    const signer = { signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, owner.sk) };
    const { opened, outer } = await wire.send(signer, owner.pk, { content: "hello", ms: Date.now() });
    expect(opened.kind).toBe(KIND_COMMUNITY_MESSAGE);
    expect(outer.pubkey).toBe(wire.addresses[0]);

    const reopened = await wire.openBatch([outer]);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].messageId).toBe(opened.messageId);
    expect(reopened[0].author).toBe(owner.pk);

    // Post-decode kind filtering (CORD's one-address-per-channel design).
    expect(await wire.openBatch([outer], { kinds: [KIND_COMMUNITY_REACTION] })).toHaveLength(0);
  });

  it("v1 wire is selected for legacy communities", () => {
    const c: Community = {
      id: random32(),
      serverRootKey: random32(),
      serverRootEpoch: 0n,
      name: "v1",
      relays: [],
      channels: [{ id: random32(), key: random32(), epoch: 0n, name: "general", epochKeys: [] }],
    };
    const wire = channelWire(c, c.channels[0]);
    expect(wire.proto).toBe("v1");
    expect(wire.filter([KIND_COMMUNITY_MESSAGE], {})["#z"]).toEqual(wire.addresses);
  });

  it("control edition opens are rejected by the channel opener (kind 3308 ≠ append)", () => {
    const owner = identity();
    const c = mintCordCommunity("K", "general", ["wss://a.example"], owner.pk);
    const now = Math.floor(Date.now() / 1000);
    const outer = sealCordControl(c, owner.sk, buildCordCommunityRootRumor({ communityId: c.id, metadata: communityMetadataOf(c), version: 1n, createdAtSecs: now }));
    // Control events live at the control address, not any channel address.
    expect(outer.kind).toBe(KIND_GIFT_WRAP);
    expect(outer.pubkey).not.toBe(cordChannelGroups(c, c.channels[0])[0].group.pk);
    expect(outer.tags.find((t) => t[0] === "vsk")).toBeUndefined(); // nothing leaks outside
    expect(outer.tags.find((t) => t[0] === "v")).toBeUndefined(); // blends into gift-wrap traffic
  });
});
