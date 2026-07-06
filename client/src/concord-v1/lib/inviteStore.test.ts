import { IDBFactory } from "fake-indexeddb";
import { getConversationKey, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { wrapEvent } from "nostr-tools/nip59";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { unwrapGiftWrap, type Nip44Decryptor } from "@/concord-v1/lib/giftwrap";
import {
  advanceInviteCursor,
  inviteSince,
  queryInvites,
  storedToInvite,
  unwrappedToStored,
  writeInvites,
} from "@/concord-v1/lib/inviteStore";

// A clean IndexedDB for the suite (the store singleton opens against it lazily).
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const KIND_INVITE = 3304;

/** A minimal NIP-44 decryptor backed by a raw secret key. */
function decryptor(sk: Uint8Array): Nip44Decryptor {
  return {
    nip44: {
      decrypt: async (pubkey: string, ciphertext: string) =>
        nip44Decrypt(ciphertext, getConversationKey(sk, pubkey)),
    },
  };
}

/** Build a real NIP-59 gift wrap of a kind-3304 invite rumor to `recipientPk`. */
function makeWrap(senderSk: Uint8Array, recipientPk: string, content = '{"community_id":"x"}'): NostrEvent {
  return wrapEvent(
    { kind: KIND_INVITE, content, tags: [], created_at: Math.floor(Date.now() / 1000) },
    senderSk,
    recipientPk,
  ) as NostrEvent;
}

async function eventually<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("concord-v1 invite store", () => {
  it("round-trips an unwrapped invite through the codec", async () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const wrap = makeWrap(senderSk, recipientPk);
    const unwrapped = await unwrapGiftWrap(wrap, decryptor(recipientSk));
    expect(unwrapped).toBeDefined();

    const stored = unwrappedToStored(wrap, unwrapped!);
    expect(stored.id).toBe(wrap.id);
    expect(stored.sig).toBe("");
    expect(stored.kind).toBe(KIND_INVITE);
    expect(stored.pubkey).toBe(getPublicKey(senderSk));

    const back = storedToInvite(stored);
    expect(back.wrapId).toBe(wrap.id);
    expect(back.sender).toBe(getPublicKey(senderSk));
    expect(back.rumor.content).toBe('{"community_id":"x"}');
    // Provenance tags are stripped from the reconstructed rumor.
    expect(back.rumor.tags.some((t) => t[0] === "wrap" || t[0] === "sender" || t[0] === "wrapts")).toBe(false);
  });

  it("persists and queries invites without re-decrypting", async () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const wrap = makeWrap(senderSk, recipientPk, '{"community_id":"abc"}');
    const unwrapped = await unwrapGiftWrap(wrap, decryptor(recipientSk));

    writeInvites([{ wrap, unwrapped: unwrapped! }]);
    const got = await eventually(() => queryInvites(), (r) => r.some((i) => i.wrapId === wrap.id));
    const mine = got.find((i) => i.wrapId === wrap.id)!;
    expect(mine.rumor.content).toBe('{"community_id":"abc"}');
    expect(mine.sender).toBe(getPublicKey(senderSk));
  });

  it("cursor resumes from exactly the newest wrap already scanned", async () => {
    const pubkey = "cursor-test-" + getPublicKey(generateSecretKey());
    expect(await inviteSince(pubkey)).toBe(0); // cold cache → full scan

    const newest = 1_000_000;
    await advanceInviteCursor(pubkey, newest);
    expect(await inviteSince(pubkey)).toBe(newest);

    // Monotonic: an older value never regresses the cursor.
    await advanceInviteCursor(pubkey, newest - 500);
    expect(await inviteSince(pubkey)).toBe(newest);
  });
});
