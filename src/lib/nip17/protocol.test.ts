import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildDmRumor,
  dmChatTags,
  dmDeleteTags,
  dmExpiresAt,
  dmPeerOf,
  dmReactionTags,
  dmTimerSeconds,
  dmTimerTags,
  expirationOf,
  isExpired,
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

describe("disappearing messages (NIP-40)", () => {
  const senderSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();
  const recipientPk = getPublicKey(recipientSk);

  const now = () => Math.floor(Date.now() / 1000);

  /** A chat rumor expiring `inSecs` from now (negative = already expired). */
  function expiringRumor(inSecs: number) {
    return buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "this will vanish",
      tags: dmChatTags(recipientPk, { expiresAt: now() + inSecs }),
      pubkey: senderPk,
    });
  }

  it("stamps the deadline on the rumor, the seal AND the wrap", async () => {
    const rumor = expiringRumor(600);
    const deadline = expirationOf(rumor.tags);
    expect(deadline).toBe(now() + 600);

    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const wrap = wrapDmSeal(seal, recipientPk);

    // The outer tag is the only one a relay can act on; the inner two are what
    // this client enforces after decryption.
    expect(expirationOf(seal.tags)).toBe(deadline);
    expect(expirationOf(wrap.tags)).toBe(deadline);
  });

  it("round-trips an unexpired disappearing message", async () => {
    const rumor = expiringRumor(600);
    const wrap = wrapDmSeal(await sealDmRumor(rumor, recipientPk, rawSigner(senderSk)), recipientPk);

    const opened = await openDmWrap(wrap, rawSigner(recipientSk), recipientPk);
    expect(opened).toBeDefined();
    expect(dmExpiresAt(opened!)).toBe(now() + 600);
  });

  it("rejects an envelope whose deadline has passed", async () => {
    const rumor = expiringRumor(-1);
    const wrap = wrapDmSeal(await sealDmRumor(rumor, recipientPk, rawSigner(senderSk)), recipientPk);

    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("rejects an expired rumor even when the wrap and seal were left unstamped", async () => {
    // A sender (or a relay-friendly repacker) that strips the outer tags must
    // not be able to smuggle an expired message past us.
    const rumor = expiringRumor(-1);
    const seal = await sealDmRumor(rumor, recipientPk, rawSigner(senderSk));
    const bare = { ...seal, tags: [] };
    const wrap = wrapDmSeal(bare, recipientPk);
    expect(wrap.tags.some(([n]) => n === "expiration")).toBe(false);

    expect(await openDmWrap(wrap, rawSigner(recipientSk), recipientPk)).toBeUndefined();
  });

  it("keeps a disappearing message's plaintext out of the signer's decrypt cache", async () => {
    const seen: Array<boolean | undefined> = [];
    const base = rawSigner(recipientSk);
    const spy: Dm17Signer = {
      ...base,
      nip44: {
        encrypt: base.nip44!.encrypt,
        decrypt: (pk, ct, opts) => {
          seen.push(opts?.cache);
          return base.nip44!.decrypt(pk, ct);
        },
      },
    };

    const expiring = wrapDmSeal(
      await sealDmRumor(expiringRumor(600), recipientPk, rawSigner(senderSk)),
      recipientPk,
    );
    expect(await openDmWrap(expiring, spy, recipientPk)).toBeDefined();
    // Both the wrap→seal and seal→rumor decrypts opt out.
    expect(seen).toEqual([false, false]);

    // An ordinary DM still gets cached.
    seen.length = 0;
    const plain = buildDmRumor({
      kind: KIND_DM_CHAT,
      content: "ordinary",
      tags: dmChatTags(recipientPk),
      pubkey: senderPk,
    });
    const ordinary = wrapDmSeal(await sealDmRumor(plain, recipientPk, rawSigner(senderSk)), recipientPk);
    expect(await openDmWrap(ordinary, spy, recipientPk)).toBeDefined();
    expect(seen).toEqual([true, true]);
  });

  it("never stamps a delete or a timer change", () => {
    expect(dmDeleteTags(recipientPk, "rid", KIND_DM_CHAT).some(([n]) => n === "expiration")).toBe(false);
    expect(dmTimerTags(recipientPk, 86400).some(([n]) => n === "expiration")).toBe(false);
  });

  it("round-trips the timer value and refuses to guess at a malformed one", () => {
    expect(dmTimerTags(recipientPk, 86400)).toEqual([["p", recipientPk], ["timer", "86400"]]);
    expect(dmTimerSeconds({ tags: dmTimerTags(recipientPk, 0) })).toBe(0);
    expect(dmTimerSeconds({ tags: dmTimerTags(recipientPk, 86400) })).toBe(86400);
    // Missing / unparseable / negative are "unknown", never "off".
    expect(dmTimerSeconds({ tags: [["p", recipientPk]] })).toBeUndefined();
    expect(dmTimerSeconds({ tags: [["timer", "soon"]] })).toBeUndefined();
    expect(dmTimerSeconds({ tags: [["timer", "-5"]] })).toBeUndefined();
  });

  it("treats a malformed expiration as absent rather than as expired", () => {
    expect(expirationOf([["expiration", "nonsense"]])).toBeUndefined();
    expect(isExpired([["expiration", "nonsense"]])).toBe(false);
    expect(isExpired([["expiration", String(now() - 1)]])).toBe(true);
    expect(isExpired([["expiration", String(now() + 60)]])).toBe(false);
  });
});
