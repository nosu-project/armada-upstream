/**
 * NIP-59 gift-wrap unwrapping with the abstract Nostrify signer.
 *
 * A gift wrap (kind 1059) hides a seal (kind 13) which hides a rumor (the
 * unsigned inner event). Each layer is NIP-44-encrypted; unwrapping is two
 * decrypts. nostr-tools' `nip59.unwrapEvent` needs a raw private key, which
 * NIP-07/NIP-46 signers don't expose — so we peel the layers manually using the
 * signer's `nip44.decrypt(senderPubkey, ciphertext)`, which every Nostrify
 * signer (nsec, extension, bunker) implements.
 */

import type { NostrEvent } from "@nostrify/nostrify";

/** A signer that can NIP-44-decrypt (every Concord-capable login). */
export interface Nip44Decryptor {
  nip44?: { decrypt(pubkey: string, ciphertext: string): Promise<string> };
}

/** The unwrapped rumor (unsigned inner event) plus its real sender. */
export interface UnwrappedRumor {
  rumor: {
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
    pubkey: string;
  };
  /** The seal's author — the real sender of the gift wrap. */
  sender: string;
}

/**
 * Unwrap a kind-1059 gift wrap addressed to the current user. Returns the inner
 * rumor + the verified sender, or undefined if it isn't a well-formed wrap this
 * signer can open. Never throws — a foreign/garbage wrap yields undefined so a
 * scan loop can skip it.
 *
 * The sender is taken from the SEAL's author (kind 13), and we verify the rumor
 * claims the same pubkey — the standard NIP-59 anti-spoofing check (a wrap can't
 * lie about who sealed it without the seal author's key).
 */
export async function unwrapGiftWrap(
  giftWrap: NostrEvent,
  signer: Nip44Decryptor,
): Promise<UnwrappedRumor | undefined> {
  if (giftWrap.kind !== 1059 || !signer.nip44) return undefined;
  try {
    // Layer 1: decrypt the wrap with the ephemeral wrap author's pubkey → seal.
    const sealJson = await signer.nip44.decrypt(giftWrap.pubkey, giftWrap.content);
    const seal = JSON.parse(sealJson) as NostrEvent;
    if (seal.kind !== 13) return undefined;

    // Layer 2: decrypt the seal with the seal author's pubkey → rumor.
    const rumorJson = await signer.nip44.decrypt(seal.pubkey, seal.content);
    const rumor = JSON.parse(rumorJson) as UnwrappedRumor["rumor"];

    // Anti-spoofing: the rumor's claimed author must equal the seal's author.
    if (rumor.pubkey !== seal.pubkey) return undefined;

    return { rumor, sender: seal.pubkey };
  } catch {
    return undefined;
  }
}
