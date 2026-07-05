import { describe, expect, it } from "vitest";

import {
  banlistLocator,
  baseRekeyGroupKey,
  bytesToHex,
  channelGroupKey,
  channelRekeyGroupKey,
  communityIdOf,
  controlGroupKey,
  dissolvedGroupKey,
  epochKeyCommitment,
  grantLocator,
  guestbookGroupKey,
  hex32,
  inviteBundleKey,
  inviteLinksLocator,
  recipientLocator,
  verifyCommunityId,
} from "@/concord-v2/lib/derive";

const A = new Uint8Array(32).fill(1);
const B = new Uint8Array(32).fill(2);
const C = new Uint8Array(32).fill(3);

describe("group_key derivations (CORD-02 A)", () => {
  it("derives deterministic, distinct addresses per label", () => {
    const chan = channelGroupKey(A, B, 0);
    const ctrl = controlGroupKey(A, B, 0);
    const gb = guestbookGroupKey(A, B, 0);
    expect(channelGroupKey(A, B, 0).pk).toBe(chan.pk);
    const pks = new Set([chan.pk, ctrl.pk, gb.pk]);
    expect(pks.size).toBe(3);
  });

  it("rotates the address with the epoch (unlinkable planes)", () => {
    expect(channelGroupKey(A, B, 0).pk).not.toBe(channelGroupKey(A, B, 1).pk);
    expect(controlGroupKey(A, B, 0).pk).not.toBe(controlGroupKey(A, B, 1).pk);
  });

  it("separates by id: two channels under one secret never share an address", () => {
    expect(channelGroupKey(A, B, 0).pk).not.toBe(channelGroupKey(A, C, 0).pk);
  });

  it("the dissolved address is epoch-free and key-free (community_id alone)", () => {
    const d1 = dissolvedGroupKey(A);
    const d2 = dissolvedGroupKey(A);
    expect(d1.pk).toBe(d2.pk);
    expect(dissolvedGroupKey(B).pk).not.toBe(d1.pk);
  });

  it("rekey addresses derive from the PRIOR secret at the NEW epoch", () => {
    const r1 = channelRekeyGroupKey(A, B, 1);
    const r2 = baseRekeyGroupKey(A, B, 1);
    expect(r1.pk).not.toBe(r2.pk);
    expect(channelRekeyGroupKey(A, B, 2).pk).not.toBe(r1.pk);
  });
});

describe("coordinates", () => {
  it("grant/banlist/invite-links locators are 32 bytes, distinct, deterministic", () => {
    const g = grantLocator(A, B);
    expect(g.length).toBe(32);
    expect(bytesToHex(grantLocator(A, B))).toBe(bytesToHex(g));
    expect(bytesToHex(grantLocator(A, C))).not.toBe(bytesToHex(g));
    expect(bytesToHex(banlistLocator(A))).not.toBe(bytesToHex(g));
    expect(bytesToHex(inviteLinksLocator(A, B))).not.toBe(bytesToHex(g));
  });

  it("recipient locators bind rotator, recipient, scope, and epoch", () => {
    const base = bytesToHex(recipientLocator(A, B, C, 1));
    expect(bytesToHex(recipientLocator(A, B, C, 1))).toBe(base);
    expect(bytesToHex(recipientLocator(B, A, C, 1))).not.toBe(base); // direction matters
    expect(bytesToHex(recipientLocator(A, B, C, 2))).not.toBe(base);
    expect(bytesToHex(recipientLocator(A, B, A, 1))).not.toBe(base);
  });

  it("invite bundle key derives from the token alone", () => {
    const token = new Uint8Array(16).fill(7);
    expect(bytesToHex(inviteBundleKey(token))).toBe(bytesToHex(inviteBundleKey(token)));
    expect(bytesToHex(inviteBundleKey(new Uint8Array(16).fill(8)))).not.toBe(bytesToHex(inviteBundleKey(token)));
  });
});

describe("community_id (A.4)", () => {
  it("commits to the owner and salt", () => {
    const id = communityIdOf(A, B);
    expect(id.length).toBe(32);
    expect(verifyCommunityId(bytesToHex(id), bytesToHex(A), bytesToHex(B))).toBe(true);
    expect(verifyCommunityId(bytesToHex(id), bytesToHex(C), bytesToHex(B))).toBe(false);
    expect(verifyCommunityId(bytesToHex(id), bytesToHex(A), bytesToHex(C))).toBe(false);
  });
});

describe("epoch-key commitment (A.5)", () => {
  it("is deterministic and binds epoch + key", () => {
    const c = epochKeyCommitment(2n, A);
    expect(bytesToHex(epochKeyCommitment(2n, A))).toBe(bytesToHex(c));
    expect(bytesToHex(epochKeyCommitment(3n, A))).not.toBe(bytesToHex(c));
    expect(bytesToHex(epochKeyCommitment(2n, B))).not.toBe(bytesToHex(c));
  });
});

describe("hex32", () => {
  it("round-trips and rejects malformed", () => {
    expect(bytesToHex(hex32(bytesToHex(A)))).toBe(bytesToHex(A));
    expect(() => hex32("abc")).toThrow();
    expect(() => hex32("zz".repeat(32))).toThrow();
  });
});
