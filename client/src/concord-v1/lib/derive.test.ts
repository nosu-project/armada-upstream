import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  banlistLocator,
  baseRekeyPseudonym,
  channelPseudonym,
  grantLocator,
  inviteLinksLocator,
  publicInviteKey,
  publicInviteLocator,
  publicInviteSigner,
  recipientPseudonym,
  rekeyPseudonym,
  voiceE2EEKey,
  voiceSigner,
} from "@/concord-v1/lib/derive";

/**
 * Golden vectors copied verbatim from Vector's `derive.rs` test module. They
 * were produced by an INDEPENDENT RFC-5869 HKDF-SHA256 implementation (Python
 * hmac+hashlib), so a match proves our construction is correct
 * cross-implementation, not merely self-consistent. If any assertion here ever
 * changes, the Concord wire format changed — a conscious, versioned decision.
 */

// Fixed test inputs (mirroring the Rust test helpers).
const TEST_CHANNEL_KEY = new Uint8Array(32).map((_, i) => i); // 0x00..0x1f
const TEST_CHANNEL_ID = new Uint8Array(32).map((_, i) => 255 - i); // 0xff,0xfe,..

const hex = (b: Uint8Array) => bytesToHex(b);

describe("channelPseudonym golden vectors", () => {
  it("is deterministic", () => {
    expect(hex(channelPseudonym(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).toBe(
      hex(channelPseudonym(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0)),
    );
  });

  it("epoch 0", () => {
    expect(hex(channelPseudonym(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).toBe(
      "d55b9f5fad668887d41d46b7c08ba63725a39d7c86b602c7c36e2f2e0eff8c40",
    );
  });

  it("epoch 1", () => {
    expect(hex(channelPseudonym(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 1))).toBe(
      "050079d9899c85bebf5c73fd777cdd812132d262e3ceec83c847a056dea41293",
    );
  });

  it("multi-byte epoch proves u64 big-endian", () => {
    expect(hex(channelPseudonym(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0x0102030405060708n))).toBe(
      "cec398094d17688cd127bc609d34fa067331427400b023d0c70ff77fafe17e0b",
    );
  });

  it("rotating the epoch rotates the pseudonym", () => {
    expect(hex(channelPseudonym(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).not.toBe(
      hex(channelPseudonym(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 1)),
    );
  });

  it("a different channel id changes the pseudonym", () => {
    const other = new Uint8Array(32).fill(0x42);
    expect(hex(channelPseudonym(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).not.toBe(
      hex(channelPseudonym(TEST_CHANNEL_KEY, other, 0)),
    );
  });
});

describe("rekey + base-rekey pseudonym golden vectors", () => {
  it("rekeyPseudonym (server_root=[7;32], channel=test id, epoch 1)", () => {
    const sr = new Uint8Array(32).fill(0x07);
    expect(hex(rekeyPseudonym(sr, TEST_CHANNEL_ID, 1))).toBe(
      "3a848655f79a586510e1113131f078aa1ce0ff8dcb74374507e6af07ff49fd24",
    );
  });

  it("baseRekeyPseudonym (prior_root=[7;32], community=[9;32], epoch 1)", () => {
    const root = new Uint8Array(32).fill(0x07);
    const community = new Uint8Array(32).fill(0x09);
    expect(hex(baseRekeyPseudonym(root, community, 1))).toBe(
      "23ced8fd6cad30a21ded43c96bd040311cf20bcfff935453dc0985b41ff660be",
    );
  });
});

describe("recipientPseudonym golden vectors (secret=[7;32], epoch 3)", () => {
  const secret = new Uint8Array(32).fill(7);

  it("channel scope = test channel id", () => {
    expect(hex(recipientPseudonym(secret, { kind: "channel", channelId: TEST_CHANNEL_ID }, 3))).toBe(
      "971f69d6a948c79704f8077188cded86bd35c82960e88043ebb2c2c3d60a3b71",
    );
  });

  it("server-root scope = all-zero", () => {
    expect(hex(recipientPseudonym(secret, { kind: "server-root" }, 3))).toBe(
      "e50e5d803fd2edc310be8cd7354586d12fcb8e3f30162553be53da1a34a17c46",
    );
  });

  it("channel vs server-root scope disambiguate", () => {
    expect(hex(recipientPseudonym(secret, { kind: "channel", channelId: TEST_CHANNEL_ID }, 3))).not.toBe(
      hex(recipientPseudonym(secret, { kind: "server-root" }, 3)),
    );
  });
});

describe("locator golden vectors", () => {
  const cid = new Uint8Array(32).fill(0x11);

  it("grantLocator (community=[0x11;32], member=[0x22;32])", () => {
    expect(hex(grantLocator(cid, new Uint8Array(32).fill(0x22)))).toBe(
      "c18d4d5955ecdd258f44240019a493a01fc01d51b5f0b8f7679ae424f8d5bfcc",
    );
  });

  it("inviteLinksLocator (community=[0x11;32], creator=[0x22;32])", () => {
    expect(hex(inviteLinksLocator(cid, new Uint8Array(32).fill(0x22)))).toBe(
      "cf42937a815ec561da6b4ca5ddd0c361634b0d9744693b744d4f5b34ec209ec2",
    );
  });

  it("locators are domain-separated despite sharing the community-id IKM", () => {
    const alice = new Uint8Array(32).fill(0x22);
    expect(hex(inviteLinksLocator(cid, alice))).not.toBe(hex(grantLocator(cid, alice)));
    expect(hex(inviteLinksLocator(cid, alice))).not.toBe(hex(banlistLocator(cid)));
  });

  it("grantLocator binds member and community", () => {
    expect(hex(grantLocator(cid, new Uint8Array(32).fill(0x22)))).not.toBe(
      hex(grantLocator(cid, new Uint8Array(32).fill(0x23))),
    );
    expect(hex(grantLocator(cid, new Uint8Array(32).fill(0x22)))).not.toBe(
      hex(grantLocator(new Uint8Array(32).fill(0x99), new Uint8Array(32).fill(0x22))),
    );
  });
});

describe("public-invite sub-keys golden vectors (token=[5;32])", () => {
  const token = new Uint8Array(32).fill(5);

  it("publicInviteKey", () => {
    expect(hex(publicInviteKey(token))).toBe(
      "7f02a8a832a1744adf286676038446dc94762c2c8332650c9ad62a0c870e0751",
    );
  });

  it("publicInviteLocator", () => {
    expect(hex(publicInviteLocator(token))).toBe(
      "33c098d6e4cddc2b8ee98ab6b5182186794c35f5b71391130a49ae3d88588c2c",
    );
  });

  it("publicInviteSigner", () => {
    expect(hex(publicInviteSigner(token))).toBe(
      "9154a3a7e4a03e94eaad2f76efeebd43e25ee9df4fbca12454edcee0ef666e8d",
    );
  });

  it("the three sub-keys are domain-separated and token-bound", () => {
    const other = new Uint8Array(32).fill(6);
    expect(hex(publicInviteKey(token))).not.toBe(hex(publicInviteLocator(token)));
    expect(hex(publicInviteKey(token))).not.toBe(hex(publicInviteSigner(token)));
    expect(hex(publicInviteKey(token))).not.toBe(hex(publicInviteKey(other)));
    expect(hex(publicInviteLocator(token))).not.toBe(hex(publicInviteLocator(other)));
  });
});

describe("Concord voice sub-keys (armada extension)", () => {
  // Pins produced by an independent re-implementation of the frozen HKDF
  // construction (see scripts in the PR) using the standard test inputs.
  it("voiceSigner is deterministic and pinned (epoch 0)", () => {
    expect(hex(voiceSigner(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).toBe(
      "2d09400ad396a5ab878fad2b992a9818bedf85abbe2dce630587e3e032d87eb2",
    );
  });

  it("voiceSigner rolls with the epoch (forward security on rekey)", () => {
    expect(hex(voiceSigner(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 1))).toBe(
      "4583f4f2b15a99307a66c928bb689255c65bbfd1b0e7d0238c3a236119b8ea51",
    );
    expect(hex(voiceSigner(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).not.toBe(
      hex(voiceSigner(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 1)),
    );
  });

  it("voiceE2EEKey is deterministic and pinned (epoch 0)", () => {
    expect(hex(voiceE2EEKey(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).toBe(
      "2237f8e3542a9f05cc02fd6f1b52223a662cce72e2cf8cd58c765b7496e3b40c",
    );
  });

  it("voiceE2EEKey rolls with the epoch", () => {
    expect(hex(voiceE2EEKey(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 1))).toBe(
      "6ff9d88a4049e8be74fed5a09154c707d58a204f8755d17dadfee159ac30eb8d",
    );
    expect(hex(voiceE2EEKey(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).not.toBe(
      hex(voiceE2EEKey(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 1)),
    );
  });

  it("signer and media key are domain-separated despite sharing IKM", () => {
    expect(hex(voiceSigner(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).not.toBe(
      hex(voiceE2EEKey(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0)),
    );
  });

  it("a different channel id changes both sub-keys", () => {
    const other = new Uint8Array(32).fill(0x42);
    expect(hex(voiceSigner(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).not.toBe(
      hex(voiceSigner(TEST_CHANNEL_KEY, other, 0)),
    );
    expect(hex(voiceE2EEKey(TEST_CHANNEL_KEY, TEST_CHANNEL_ID, 0))).not.toBe(
      hex(voiceE2EEKey(TEST_CHANNEL_KEY, other, 0)),
    );
  });
});
