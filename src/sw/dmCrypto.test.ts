import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { unwrapDm } from "./dmCrypto";

const now = () => Math.floor(Date.now() / 1000);

/** Seal a rumor with the sender's real key (kind 13, nip44 to the recipient). */
function seal(
  rumor: Record<string, unknown>,
  senderSk: Uint8Array,
  recipientPk: string,
  tags: string[][] = [],
) {
  return finalizeEvent(
    {
      kind: 13,
      content: nip44Encrypt(JSON.stringify(rumor), getConversationKey(senderSk, recipientPk)),
      tags,
      created_at: now(),
    },
    senderSk,
  );
}

/** Wrap a seal in a single-use ephemeral gift wrap (kind 1059). */
function wrap(sealEvent: unknown, recipientPk: string, tags: string[][] = [["p", recipientPk]]) {
  const wrapSk = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      content: nip44Encrypt(JSON.stringify(sealEvent), getConversationKey(wrapSk, recipientPk)),
      tags,
      created_at: now(),
    },
    wrapSk,
  );
}

describe("unwrapDm", () => {
  const senderSk = generateSecretKey();
  const recipientSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientPk = getPublicKey(recipientSk);
  const sk = bytesToHex(recipientSk);

  const rumor = {
    pubkey: senderPk,
    kind: 14,
    content: "are you coming tonight?",
    tags: [["p", recipientPk]],
    created_at: now(),
  };

  it("returns the real sender, message preview and rumor timestamp", () => {
    const opened = unwrapDm(wrap(seal(rumor, senderSk, recipientPk), recipientPk), sk, recipientPk);
    expect(opened).toEqual({
      sender: senderPk,
      kind: 14,
      content: "are you coming tonight?",
      createdAt: rumor.created_at,
    });
  });

  it("returns null for a wrap this key can't open", () => {
    const strangerPk = getPublicKey(generateSecretKey());
    expect(unwrapDm(wrap(seal(rumor, senderSk, strangerPk), strangerPk), sk, recipientPk)).toBeNull();
  });

  it("rejects the user's own sent copy (seal signed by self)", () => {
    const selfRumor = { ...rumor, pubkey: recipientPk };
    const opened = unwrapDm(wrap(seal(selfRumor, recipientSk, recipientPk), recipientPk), sk, recipientPk);
    expect(opened).toBeNull();
  });

  it("rejects an anti-spoofed rumor (rumor.pubkey != seal signer)", () => {
    const spoofed = { ...rumor, pubkey: getPublicKey(generateSecretKey()) };
    expect(unwrapDm(wrap(seal(spoofed, senderSk, recipientPk), recipientPk), sk, recipientPk)).toBeNull();
  });

  it("rejects an already-expired rumor (NIP-40)", () => {
    const past = String(now() - 60);
    const expiredRumor = { ...rumor, tags: [["p", recipientPk], ["expiration", past]] };
    expect(unwrapDm(wrap(seal(expiredRumor, senderSk, recipientPk), recipientPk), sk, recipientPk)).toBeNull();
  });

  it("rejects a wrap whose outer expiration has passed without decrypting", () => {
    const past = String(now() - 60);
    const w = wrap(seal(rumor, senderSk, recipientPk), recipientPk, [["p", recipientPk], ["expiration", past]]);
    expect(unwrapDm(w, sk, recipientPk)).toBeNull();
  });

  it("returns null for garbage rather than throwing", () => {
    expect(unwrapDm({ pubkey: "x", content: "not-ciphertext" }, sk, recipientPk)).toBeNull();
  });
});
