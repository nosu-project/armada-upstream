import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  buildDmRumor,
  conversationWrapKey,
  dm17NativeConv,
  dmChatTags,
  dmDeleteTags,
  dmPeerOf,
  dmReactionTags,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_REACTION,
  KIND_DM_WRAP,
  MAX_WRAP_BACKDATE_SECS,
  openDmWrap,
  sealDmRumor,
  wrapDmSeal,
  type Dm17Signer,
} from "@/lib/nip17/protocol";

/** A raw-key signer exposing the abstract surface NIP-17 sends/opens need. */
function rawSigner(sk: Uint8Array): Dm17Signer {
  return {
    signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
    nip44: {
      encrypt: async (pubkey: string, plaintext: string) =>
        nip44Encrypt(plaintext, getConversationKey(sk, pubkey)),
      decrypt: async (pubkey: string, ciphertext: string) =>
        nip44Decrypt(ciphertext, getConversationKey(sk, pubkey)),
    },
  };
}

describe("conversationWrapKey (nips#2396 derivation)", () => {
  // The worked example from the #2396 draft (NIP-59 example keys).
  const senderSk = hexToBytes("0beebd062ec8735f4243466049d7747ef5d6594ee838de147f8aab842b15e273");
  const recipientSk = hexToBytes("e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45");
  const senderPk = getPublicKey(senderSk);
  const recipientPk = getPublicKey(recipientSk);

  it("matches the draft's published test vector", () => {
    const key = conversationWrapKey(senderSk, recipientPk);
    expect(Buffer.from(key.sk).toString("hex")).toBe(
      "2785604c24b7dd2fd83ff224f4d16b2dce384f3ce5a95c13f6ee2fe1fd170d41",
    );
    // The wrap pubkey from the draft's example gift wrap.
    expect(key.pk).toBe("aefe6f6ff2ff2f2a12a90cfc79dca84abd6ba135d959d4247fa865853b1c281c");
  });

  it("is symmetric — both parties derive the same key", () => {
    const a = conversationWrapKey(senderSk, recipientPk);
    const b = conversationWrapKey(recipientSk, senderPk);
    expect(Buffer.from(a.sk).toString("hex")).toBe(Buffer.from(b.sk).toString("hex"));
    expect(a.pk).toBe(b.pk);
  });

  it("differs per counterparty", () => {
    const otherPk = getPublicKey(generateSecretKey());
    const a = conversationWrapKey(senderSk, recipientPk);
    const b = conversationWrapKey(senderSk, otherPk);
    expect(a.pk).not.toBe(b.pk);
  });
});

describe("NIP-17 seal + wrap round trip", () => {
  const senderSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();
  const recipientPk = getPublicKey(recipientSk);

  it("round-trips a chat rumor through an ephemeral wrap (vanilla NIP-17)", async () => {
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "hola, que tal?",
      tags: dmChatTags(recipientPk),
      pubkey: senderPk,
    });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = wrapDmSeal(seal, recipientPk);

    expect(wrap.kind).toBe(KIND_DM_WRAP);
    expect(wrap.tags).toContainEqual(["p", recipientPk]);
    // Ephemeral author: not the sender, not the conversation key.
    expect(wrap.pubkey).not.toBe(senderPk);

    const opened = await openDmWrap(wrap, rawSigner(recipientSk), recipientPk);
    expect(opened).toBeDefined();
    expect(opened!.rumorId).toBe(rumor.id);
    expect(opened!.author).toBe(senderPk);
    expect(opened!.content).toBe("hola, que tal?");
    expect(opened!.kind).toBe(KIND_DM_CHAT);
    expect(opened!.peer).toBe(senderPk); // received: peer is the sender
    expect(opened!.wrapId).toBe(wrap.id);
  });

  it("signs with the conversation wrap key and stays legacy-decryptable", async () => {
    const convKey = conversationWrapKey(senderSk, recipientPk);
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "fast path",
      tags: dmChatTags(recipientPk),
      pubkey: senderPk,
    });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = wrapDmSeal(seal, recipientPk, { wrapSk: convKey.sk });

    // The wrap author IS the deterministic conversation address.
    expect(wrap.pubkey).toBe(convKey.pk);

    // ...and a completely standard NIP-17 open (decrypt against wrap.pubkey)
    // recovers it — the fast path costs zero interop.
    const opened = await openDmWrap(wrap, rawSigner(recipientSk), recipientPk);
    expect(opened?.content).toBe("fast path");
    expect(opened?.author).toBe(senderPk);
  });

  it("attributes the SELF copy to the peer via the rumor's p tag", async () => {
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "self copy",
      tags: dmChatTags(recipientPk),
      pubkey: senderPk,
    });
    const selfSeal = await sealDmRumor(rumor, senderPk, rawSigner(senderSk));
    const selfWrap = wrapDmSeal(selfSeal, senderPk);

    const opened = await openDmWrap(selfWrap, rawSigner(senderSk), senderPk);
    expect(opened?.author).toBe(senderPk);
    expect(opened?.peer).toBe(recipientPk);
  });

  it("backdates the wrap and seal within the NIP-59 window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "x", tags: dmChatTags(recipientPk), pubkey: senderPk });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = wrapDmSeal(seal, recipientPk);
    for (const ts of [seal.created_at, wrap.created_at]) {
      expect(ts).toBeLessThanOrEqual(now + 1);
      expect(ts).toBeGreaterThanOrEqual(now - MAX_WRAP_BACKDATE_SECS - 1);
    }
    // The rumor keeps its real time.
    expect(rumor.created_at).toBeGreaterThanOrEqual(now - 1);
  });

  it("adds the first-contact k hint only when asked", async () => {
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "hi", tags: dmChatTags(recipientPk), pubkey: senderPk });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const first = wrapDmSeal(seal, recipientPk, { firstContact: true });
    const later = wrapDmSeal(seal, recipientPk);
    expect(first.tags).toContainEqual(["k", "14"]);
    expect(later.tags.some(([n]) => n === "k")).toBe(false);
  });

  it("rejects a rumor whose claimed pubkey differs from the seal author", async () => {
    const impostorPk = getPublicKey(generateSecretKey());
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "spoof",
      tags: dmChatTags(recipientPk),
      pubkey: impostorPk, // claims someone else
    });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk)); // sealed by sender
    const wrap = wrapDmSeal(seal, recipientPk);
    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("rejects a rumor with a lying id", async () => {
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "real", tags: dmChatTags(recipientPk), pubkey: senderPk });
    const tampered = { ...rumor, content: "tampered" }; // id no longer matches
    const signer = rawSigner(senderSk);
    const seal = await signer.signEvent({
      kind: 13,
      content: await signer.nip44!.encrypt(recipientPk, JSON.stringify(tampered)),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    const wrap = wrapDmSeal(seal, recipientPk);
    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("yields undefined for a wrap addressed to someone else", async () => {
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content: "not yours", tags: dmChatTags(recipientPk), pubkey: senderPk });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = wrapDmSeal(seal, recipientPk);
    const strangerSk = generateSecretKey();
    expect(await openDmWrap(wrap, rawSigner(strangerSk), getPublicKey(strangerSk))).toBeUndefined();
  });

  it("rejects a far-future rumor", async () => {
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "from the future",
      tags: dmChatTags(recipientPk),
      pubkey: senderPk,
      createdAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = wrapDmSeal(seal, recipientPk);
    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });
});

describe("dm17NativeConv (Android background decrypt material)", () => {
  const senderSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();
  const recipientPk = getPublicKey(recipientSk);

  // What the Android service does with the two shipped hex keys: decrypt the
  // outer wrap with wrapConvKey → the kind-13 seal, then the seal with
  // dmConvKey → the rumor. This must recover the exact message a real
  // conversation-wrap-key send produces, using ONLY the derived keys (never
  // the recipient's secret key).
  function nativeOpen(wrap: { pubkey: string; content: string }, conv: ReturnType<typeof dm17NativeConv>) {
    const sealJson = nip44Decrypt(wrap.content, hexToBytes(conv.wrapConvKey));
    const seal = JSON.parse(sealJson) as { kind: number; pubkey: string; content: string };
    const rumorJson = nip44Decrypt(seal.content, hexToBytes(conv.dmConvKey));
    return { seal, rumor: JSON.parse(rumorJson) as { kind: number; pubkey: string; content: string } };
  }

  it("derives keys that open the recipient's inbound wrap → seal → rumor", async () => {
    // The recipient derives the material for their conversation with senderPk.
    const conv = dm17NativeConv(recipientSk, senderPk);

    // The sender sends a real conversation-wrap-key DM to the recipient.
    const convKey = conversationWrapKey(senderSk, recipientPk);
    const rumor = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "native path",
      tags: dmChatTags(recipientPk),
      pubkey: senderPk,
    });
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = wrapDmSeal(seal, recipientPk, { wrapSk: convKey.sk });

    // The wrap the service filters on IS this conversation's address.
    expect(wrap.pubkey).toBe(conv.wrapPk);
    expect(conv.peer).toBe(senderPk);

    // The two derived keys open both layers with no secret key.
    const { seal: openedSeal, rumor: openedRumor } = nativeOpen(wrap, conv);
    expect(openedSeal.kind).toBe(13);
    expect(openedSeal.pubkey).toBe(senderPk); // seal author == the peer
    expect(openedRumor.kind).toBe(KIND_DM_CHAT);
    expect(openedRumor.pubkey).toBe(senderPk);
    expect(openedRumor.content).toBe("native path");
  });

  it("is symmetric on wrapPk with the sender's derivation", () => {
    const recipientConv = dm17NativeConv(recipientSk, senderPk);
    const senderConv = dm17NativeConv(senderSk, recipientPk);
    // Both sides address the same conversation.
    expect(recipientConv.wrapPk).toBe(senderConv.wrapPk);
  });
});

describe("rumor tag builders + peer attribution", () => {
  const self = getPublicKey(generateSecretKey());
  const peer = getPublicKey(generateSecretKey());

  it("builds reaction and delete tags with the peer leading", () => {
    expect(dmReactionTags(peer, "eid", KIND_DM_CHAT)).toEqual([
      ["p", peer],
      ["e", "eid"],
      ["k", "14"],
    ]);
    expect(dmDeleteTags(peer, "rid", KIND_DM_REACTION)).toEqual([
      ["p", peer],
      ["e", "rid"],
      ["k", "7"],
    ]);
  });

  it("resolves the conversation partner for sent and received rumors", () => {
    expect(dmPeerOf({ pubkey: peer, tags: [["p", self]] }, self)).toBe(peer);
    expect(dmPeerOf({ pubkey: self, tags: dmReactionTags(peer, "eid", KIND_DM_CHAT) }, self)).toBe(peer);
    expect(dmPeerOf({ pubkey: self, tags: [] }, self)).toBeUndefined();
  });

  it("keeps delete rumors attributable", () => {
    const rumor = buildDmRumor({
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags(peer, "target", KIND_DM_CHAT),
      pubkey: self,
    });
    expect(dmPeerOf(rumor, self)).toBe(peer);
  });
});
