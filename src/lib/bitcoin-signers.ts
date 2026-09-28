import type { NostrSigner } from '@nostrify/types';
import { NSecSigner, NBrowserSigner } from '@nostrify/nostrify';
import { nip44 } from 'nostr-tools';

/** Conversation keys kept per nsec signer, and first sightings remembered. */
const CONVERSATION_KEYS_MAX = 512;
const SEEN_ONCE_MAX = 2_048;

/**
 * A Nostr signer with PSBT signing: signs Taproot inputs matching its key and
 * returns the signed (not finalized) hex PSBT. The heavy implementation is
 * lazily imported so this module stays out of the ~150 kB crypto stack.
 */
export interface BtcSigner extends NostrSigner {
  signPsbt(psbtHex: string): Promise<string>;
}

export function hasBtcSigning(signer: NostrSigner): signer is BtcSigner {
  return typeof (signer as BtcSigner).signPsbt === 'function';
}

/**
 * `NSecSigner` with local Taproot PSBT signing. `NSecSigner` keeps its key in
 * a `#private` field, so this keeps its own runtime-private copy.
 */
export class NSecSignerBtc extends NSecSigner implements BtcSigner {
  readonly #secretKeyBytes: Uint8Array;

  constructor(secretKey: Uint8Array) {
    super(secretKey);
    this.#secretKeyBytes = new Uint8Array(secretKey);
  }

  /**
   * NIP-44 with cached conversation keys (each is a ~4ms+ ECDH). Admission
   * needs a second sighting so one-shot gift-wrap authors don't displace the
   * recurring seal senders.
   */
  override nip44 = {
    encrypt: async (pubkey: string, plaintext: string): Promise<string> =>
      nip44.v2.encrypt(plaintext, this.#conversationKey(pubkey)),
    decrypt: async (pubkey: string, ciphertext: string): Promise<string> =>
      nip44.v2.decrypt(ciphertext, this.#conversationKey(pubkey)),
  };

  readonly #conversationKeys = new Map<string, Uint8Array>();
  readonly #seenOnce = new Set<string>();

  #conversationKey(pubkey: string): Uint8Array {
    const hit = this.#conversationKeys.get(pubkey);
    if (hit) {
      this.#conversationKeys.delete(pubkey);
      this.#conversationKeys.set(pubkey, hit);
      return hit;
    }
    const key = nip44.v2.utils.getConversationKey(this.#secretKeyBytes, pubkey);
    if (this.#seenOnce.delete(pubkey)) {
      this.#conversationKeys.set(pubkey, key);
      if (this.#conversationKeys.size > CONVERSATION_KEYS_MAX) {
        const oldest = this.#conversationKeys.keys().next();
        if (!oldest.done) this.#conversationKeys.delete(oldest.value);
      }
    } else {
      this.#seenOnce.add(pubkey);
      if (this.#seenOnce.size > SEEN_ONCE_MAX) {
        const oldest = this.#seenOnce.values().next();
        if (!oldest.done) this.#seenOnce.delete(oldest.value);
      }
    }
    return key;
  }

  async signPsbt(psbtHex: string): Promise<string> {
    const { signNsecPsbt } = await import('@/lib/bitcoin-signers-impl');
    return signNsecPsbt(psbtHex, this.#secretKeyBytes);
  }
}

/** `NBrowserSigner` with NIP-07 `window.nostr.signPsbt()` support. */
export class NBrowserSignerBtc extends NBrowserSigner implements BtcSigner {
  constructor(opts?: { timeout?: number }) {
    super(opts);
  }

  async signPsbt(psbtHex: string): Promise<string> {
    // `awaitNostr` is TypeScript-private but JavaScript-public at runtime.
    const nostr = await (this as unknown as { awaitNostr(): Promise<Record<string, unknown>> }).awaitNostr();

    if (typeof nostr.signPsbt !== 'function') {
      throw new Error(
        "Your browser extension doesn't support sending Bitcoin. Try a different extension, or log in with your secret key.",
      );
    }

    const signPsbt = nostr.signPsbt as (hex: string) => Promise<string>;
    return signPsbt(psbtHex);
  }
}

// The NIP-46 bunker signer is `Nip46Signer` in `@/lib/nip46Signer.ts`.
