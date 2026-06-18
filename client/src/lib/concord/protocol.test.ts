import { bytesToHex } from "@noble/hashes/utils.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import {
  buildEditionInner,
  citationFromTags,
  citationToTag,
  parseEditionInner,
  signEdition,
  toFoldEdition,
} from "@/lib/concord/edition";
import {
  buildInnerEvent,
  EnvelopeError,
  openMessage,
  openMessageMulti,
  sealMessage,
} from "@/lib/concord/envelope";
import { acceptInvite, buildInvite, inviteFromJson, inviteToJson } from "@/lib/concord/invite";
import { buildOwnerAttestationUnsigned, signOwnerAttestation, verifyOwnerAttestation } from "@/lib/concord/owner";
import {
  buildPublicInviteEvent,
  buildPublicInviteTombstone,
  encodeInviteUrl,
  newToken,
  parseInviteUrl,
  parsePublicInviteEvent,
  PublicInviteError,
} from "@/lib/concord/publicInvite";
import { buildRekeyBlob, epochKeyCommitment, openRekeyBlob } from "@/lib/concord/rekey";
import {
  adminRole,
  ADMIN_ALL,
  canActOnMember,
  type CommunityRoles,
  effectivePermissions,
  highestPosition,
  isAdmin,
  isManagement,
  Permissions,
} from "@/lib/concord/roles";
import { createCommunity } from "@/lib/concord/types";
import { editionHash, fold, bootstrapHead, type Edition } from "@/lib/concord/version";

// ── cipher ────────────────────────────────────────────────────────────────────

describe("cipher (raw-key NIP-44 v2)", () => {
  it("round-trips", () => {
    const key = new Uint8Array(32).fill(0x5a);
    expect(cipherOpen(key, cipherSeal(key, "hello community"))).toBe("hello community");
  });
  it("wrong key fails", () => {
    const sealed = cipherSeal(new Uint8Array(32).fill(1), "secret");
    expect(() => cipherOpen(new Uint8Array(32).fill(2), sealed)).toThrow();
  });
  it("distinct ciphertext per call", () => {
    const key = new Uint8Array(32).fill(9);
    expect(cipherSeal(key, "x")).not.toBe(cipherSeal(key, "x"));
  });
});

// ── envelope ────────────────────────────────────────────────────────────────

describe("envelope (3-layer seal/open + binding triad)", () => {
  const authorSk = generateSecretKey();
  const channelKey = new Uint8Array(32).fill(0x33);
  const channelId = new Uint8Array(32).fill(0x44);

  it("seals and opens, recovering author + content", () => {
    const sealed = sealMessage({ authorSk, channelKey, channelId, epoch: 0n, content: "welcome!", ms: 1000 });
    const opened = openMessage(sealed, channelKey, channelId, 0n);
    expect(opened.content).toBe("welcome!");
    expect(opened.author).toBe(getPublicKey(authorSk));
    expect(opened.kind).toBe(3300);
  });

  it("reconstructs the ms timestamp (created_at*1000 + offset)", () => {
    const sealed = sealMessage({ authorSk, channelKey, channelId, epoch: 0n, content: "hi", ms: 1_700_000_123 });
    const opened = openMessage(sealed, channelKey, channelId, 0n);
    expect(opened.ms).toBe(1_700_000_123);
  });

  it("rejects a wrong channel (splice)", () => {
    const sealed = sealMessage({ authorSk, channelKey, channelId, epoch: 0n, content: "x", ms: 1000 });
    expect(() => openMessage(sealed, channelKey, new Uint8Array(32).fill(0x99), 0n)).toThrow();
  });

  it("rejects a wrong epoch (splice/replay)", () => {
    const sealed = sealMessage({ authorSk, channelKey, channelId, epoch: 0n, content: "x", ms: 1000 });
    // Re-derived pseudonym differs, so cipher itself fails first — either way it throws.
    expect(() => openMessage(sealed, channelKey, channelId, 1n)).toThrow();
  });

  it("openMessageMulti selects the key by the z pseudonym", () => {
    const k0 = new Uint8Array(32).fill(0x10);
    const k1 = new Uint8Array(32).fill(0x11);
    const sealed = sealMessage({ authorSk, channelKey: k1, channelId, epoch: 5n, content: "epoch5", ms: 2000 });
    const opened = openMessageMulti(sealed, channelId, [
      { epoch: 0n, key: k0 },
      { epoch: 5n, key: k1 },
    ]);
    expect(opened.content).toBe("epoch5");
    expect(opened.epoch).toBe(5n);
  });

  it("openMessageMulti yields no-held-epoch when nothing matches", () => {
    const sealed = sealMessage({ authorSk, channelKey, channelId, epoch: 0n, content: "x", ms: 1000 });
    try {
      openMessageMulti(sealed, channelId, [{ epoch: 9n, key: new Uint8Array(32).fill(0xab) }]);
      expect.unreachable();
    } catch (e) {
      expect((e as EnvelopeError).code).toBe("no-held-epoch");
    }
  });

  it("buildInnerEvent splits ms into seconds + offset", () => {
    const inner = buildInnerEvent({ channelId, epoch: 0n, content: "x", ms: 1234 });
    expect(inner.created_at).toBe(1);
    expect(inner.tags.find((t) => t[0] === "ms")?.[1]).toBe("234");
  });
});

// ── version + edition ─────────────────────────────────────────────────────────

describe("version.fold + editionHash", () => {
  const id = (b: number) => new Uint8Array(32).fill(b);
  const ed = (v: bigint, prev?: number, self?: number, tb?: number): Edition => ({
    version: v,
    prevHash: prev !== undefined ? id(prev) : undefined,
    selfHash: id(self ?? Number(v)),
    createdAt: 100 + Number(v),
    tiebreakId: id(tb ?? 0xa0 + Number(v)),
  });

  it("edition_hash golden vector (matches Vector)", () => {
    const h = editionHash(id(0x11), 1n, undefined, new TextEncoder().encode("hello"));
    expect(bytesToHex(h)).toBe("2daf42e65a6bc259a4c99fac6df754a5d3d92310607cf13e2a1e8c94d42f6303");
  });

  it("contiguous chain folds to latest", () => {
    const r = fold([ed(1n, undefined, 1), ed(2n, 1, 2), ed(3n, 2, 3)], 0n);
    expect(r).toEqual({ head: 2, gap: false });
  });

  it("detects a gap and stops at the contiguous prefix", () => {
    const r = fold([ed(1n, undefined, 1), ed(3n, 2, 3)], 0n);
    expect(r.head).toBe(0);
    expect(r.gap).toBe(true);
  });

  it("union of split relays folds contiguously (order-independent)", () => {
    const linked = (v: number) => ed(BigInt(v), v === 1 ? undefined : v - 1, v);
    const r = fold([linked(3), linked(1), linked(5), linked(2), linked(4)], 0n);
    expect(r.head !== null).toBe(true);
    expect(r.gap).toBe(false);
  });

  it("refuse-downgrade: below floor is ignored", () => {
    const r = fold([ed(1n, undefined, 1), ed(2n, 1, 2)], 2n, id(2));
    expect(r.head).toBe(1);
    expect(r.gap).toBe(false);
  });

  it("bootstrapHead takes the highest version across gaps", () => {
    const linked = (v: number) => ed(BigInt(v), v === 1 ? undefined : v - 1, v);
    const groot = [1, 2, 3, 4, 6, 7].map(linked);
    expect(bootstrapHead(groot, 0n)).not.toBeNull();
    expect(groot[bootstrapHead(groot, 0n)!].version).toBe(7n);
  });
});

describe("edition build/parse/citation", () => {
  it("round-trips authorship, version, and chain hash", () => {
    const actorSk = generateSecretKey();
    const eid = new Uint8Array(32).fill(0x42);
    const prev = editionHash(eid, 1n, undefined, new TextEncoder().encode("{}"));
    const template = buildEditionInner({
      vsk: "3",
      entityId: eid,
      version: 2n,
      prevHash: prev,
      content: '{"role_ids":[]}',
      createdAtSecs: 1_700_000_000,
    });
    const signed = signEdition(template, actorSk);
    const parsed = parseEditionInner(signed);
    expect(parsed.author).toBe(getPublicKey(actorSk));
    expect(parsed.vsk).toBe("3");
    expect(parsed.version).toBe(2n);
    expect(parsed.prevHash && bytesToHex(parsed.prevHash)).toBe(bytesToHex(prev));
    expect(toFoldEdition(parsed).version).toBe(2n);
  });

  it("rejects a duplicate authority tag", () => {
    const actorSk = generateSecretKey();
    const template = buildEditionInner({ vsk: "1", entityId: new Uint8Array(32).fill(1), version: 1n, content: "{}", createdAtSecs: 100 });
    template.tags.push(["vsk", "1"]); // duplicate
    const signed = signEdition(template, actorSk);
    expect(() => parseEditionInner(signed)).toThrow();
  });

  it("authority citation tag layout is frozen", () => {
    const tag = citationToTag({ entityId: new Uint8Array(32).fill(0x11), version: 9n, editionHash: new Uint8Array(32).fill(0x22) });
    expect(tag).toEqual(["vac", "11".repeat(32), "9", "22".repeat(32)]);
    const back = citationFromTags([tag]);
    expect(back?.version).toBe(9n);
  });
});

// ── roles ─────────────────────────────────────────────────────────────────────

describe("roles authority model", () => {
  const owner = "00".repeat(32);
  const admin = "aa".repeat(32);
  const moderator = "bb".repeat(32);
  const member = "cc".repeat(32);

  const adminR = adminRole("a".repeat(64));
  const modR = { roleId: "b".repeat(64), name: "Mod", position: 2, permissions: Permissions.KICK, scope: { kind: "server" as const }, color: 0 };
  const roles: CommunityRoles = {
    roles: [adminR, modR],
    grants: [
      { member: admin, roleIds: [adminR.roleId] },
      { member: moderator, roleIds: [modR.roleId] },
    ],
  };

  it("admin holds every management bit", () => {
    for (const bit of Object.values(Permissions)) {
      if (bit === Permissions.MENTION_EVERYONE || bit === Permissions.VIEW_AUDIT_LOG) continue;
      expect((ADMIN_ALL & bit) === bit).toBe(true);
    }
    expect(isManagement(ADMIN_ALL)).toBe(true);
  });

  it("a social-only role is not management", () => {
    expect(isManagement(Permissions.MENTION_EVERYONE)).toBe(false);
  });

  it("owner is supreme and never a valid target", () => {
    expect(canActOnMember(roles, owner, owner, admin, Permissions.BAN)).toBe(true);
    expect(canActOnMember(roles, admin, owner, owner, Permissions.BAN)).toBe(false);
  });

  it("equal cannot act on equal; strictly higher can", () => {
    expect(canActOnMember(roles, admin, owner, admin, Permissions.BAN)).toBe(false);
    expect(canActOnMember(roles, admin, owner, moderator, Permissions.BAN)).toBe(true);
    expect(canActOnMember(roles, admin, owner, member, Permissions.BAN)).toBe(true);
  });

  it("permission gate: a kick-only mod can't ban", () => {
    expect(canActOnMember(roles, moderator, owner, member, Permissions.BAN)).toBe(false);
    expect(canActOnMember(roles, moderator, owner, member, Permissions.KICK)).toBe(true);
  });

  it("effective permissions union + highest position", () => {
    expect(effectivePermissions(roles, admin)).toBe(ADMIN_ALL);
    expect(highestPosition(roles, admin)).toBe(1);
    expect(highestPosition(roles, member)).toBeUndefined();
    expect(isAdmin(roles, admin)).toBe(true);
    expect(isAdmin(roles, member)).toBe(false);
  });
});

// ── owner attestation ──────────────────────────────────────────────────────────

describe("owner attestation", () => {
  it("round-trips, binds, and rejects forgery/transplant", () => {
    const ownerSk = generateSecretKey();
    const cid = "a".repeat(64);
    const signed = signOwnerAttestation(buildOwnerAttestationUnsigned(cid), ownerSk);
    const json = JSON.stringify(signed);
    expect(verifyOwnerAttestation(json, cid)).toBe(getPublicKey(ownerSk));
    expect(verifyOwnerAttestation(json, "b".repeat(64))).toBeUndefined(); // transplant
    expect(verifyOwnerAttestation("not json", cid)).toBeUndefined();
  });
});

// ── invite ───────────────────────────────────────────────────────────────────

describe("invite bundle", () => {
  it("round-trips to a member view with working keys", () => {
    const owner = createCommunity("HQ", "general", ["wss://r1", "wss://r2"]);
    const member = acceptInvite(inviteFromJson(inviteToJson(buildInvite(owner))));
    expect(bytesToHex(member.id)).toBe(bytesToHex(owner.id));
    expect(bytesToHex(member.serverRootKey)).toBe(bytesToHex(owner.serverRootKey));
    expect(member.channels).toHaveLength(1);
    expect(bytesToHex(member.channels[0].key)).toBe(bytesToHex(owner.channels[0].key));
  });

  it("an invited member can read an owner's sealed message", () => {
    const owner = createCommunity("HQ", "general", []);
    const ownerAuthorSk = generateSecretKey();
    const chan = owner.channels[0];
    const sealed = sealMessage({ authorSk: ownerAuthorSk, channelKey: chan.key, channelId: chan.id, epoch: chan.epoch, content: "welcome!", ms: 1000 });

    const member = acceptInvite(inviteFromJson(inviteToJson(buildInvite(owner))));
    const mc = member.channels[0];
    const opened = openMessage(sealed, mc.key, mc.id, mc.epoch);
    expect(opened.content).toBe("welcome!");
    expect(opened.author).toBe(getPublicKey(ownerAuthorSk));
  });

  it("rejects a malformed bundle", () => {
    const owner = createCommunity("HQ", "general", []);
    const inv = buildInvite(owner);
    inv.server_root_key = "zz";
    expect(() => acceptInvite(inv)).toThrow();
  });

  it("caps relays at 5", () => {
    const owner = createCommunity("HQ", "general", []);
    const inv = buildInvite(owner);
    inv.relays = Array.from({ length: 100 }, (_, i) => `wss://r${i}`);
    const member = acceptInvite(inviteFromJson(inviteToJson(inv)));
    expect(member.relays.length).toBeLessThanOrEqual(5);
  });
});

// ── rekey ──────────────────────────────────────────────────────────────────────

describe("rekey blob", () => {
  it("build → open round-trips the new key", () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const senderPk = getPublicKey(senderSk);
    const channelId = new Uint8Array(32).fill(0x44);
    const newKey = new Uint8Array(32).fill(0x7e);
    const scope = { kind: "channel" as const, channelId };

    const blob = buildRekeyBlob(senderSk, recipientPk, scope, 3n, newKey);
    const recovered = openRekeyBlob(recipientSk, senderPk, scope, 3n, blob);
    expect(bytesToHex(recovered)).toBe(bytesToHex(newKey));
  });

  it("rejects a blob opened under the wrong epoch (locator mismatch)", () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const scope = { kind: "server-root" as const };
    const blob = buildRekeyBlob(senderSk, getPublicKey(recipientSk), scope, 1n, new Uint8Array(32).fill(1));
    expect(() => openRekeyBlob(recipientSk, getPublicKey(senderSk), scope, 2n, blob)).toThrow();
  });

  it("epoch key commitment is deterministic + binds the epoch", () => {
    const key = new Uint8Array(32).fill(5);
    expect(bytesToHex(epochKeyCommitment(1n, key))).toBe(bytesToHex(epochKeyCommitment(1n, key)));
    expect(bytesToHex(epochKeyCommitment(1n, key))).not.toBe(bytesToHex(epochKeyCommitment(2n, key)));
  });
});

// ── public invite ────────────────────────────────────────────────────────────

describe("public invite", () => {
  it("URL round-trips relays + token (v2 fragment)", () => {
    const token = newToken();
    const relays = ["wss://a.relay", "wss://b.relay"];
    const url = encodeInviteUrl(relays, token);
    const parsed = parseInviteUrl(url);
    expect(bytesToHex(parsed.token)).toBe(bytesToHex(token));
    expect(parsed.relays).toEqual(relays);
  });

  it("bundle event signs, verifies, and decrypts with the token", () => {
    const owner = createCommunity("HQ", "general", ["wss://r1"]);
    const token = newToken();
    const event = buildPublicInviteEvent(owner, token, { label: "Reddit" });
    const bundle = parsePublicInviteEvent(event, token);
    expect(bundle.preview.name).toBe("HQ");
    expect(bundle.label).toBe("Reddit");
    expect(acceptInvite(bundle.join).channels[0].name).toBe("general");
  });

  it("rejects a bundle with the wrong token (unexpected signer)", () => {
    const owner = createCommunity("HQ", "general", []);
    const event = buildPublicInviteEvent(owner, newToken());
    try {
      parsePublicInviteEvent(event, newToken());
      expect.unreachable();
    } catch (e) {
      expect((e as PublicInviteError).code).toBe("unexpected-signer");
    }
  });

  it("a revocation tombstone parses as revoked", () => {
    const token = newToken();
    const tomb = buildPublicInviteTombstone(token);
    try {
      parsePublicInviteEvent(tomb, token);
      expect.unreachable();
    } catch (e) {
      expect((e as PublicInviteError).code).toBe("revoked");
    }
  });
});
