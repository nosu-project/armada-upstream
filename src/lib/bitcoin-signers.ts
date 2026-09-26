import type { NostrSigner } from '@nostrify/types';
import { NSecSigner, NBrowserSigner } from '@nostrify/nostrify';
import { nip44 } from 'nostr-tools';

/** Conversation keys kept per nsec signer, and first sightings remembered. */
const CONVERSATION_KEYS_MAX = 512;
const SEEN_ONCE_MAX = 2_048;

// ---------------------------------------------------------------------------
// BtcSigner interface
// ---------------------------------------------------------------------------

/**
 * A Nostr signer extended with Bitcoin PSBT signing capability.
 *
 * Implementations receive a hex-encoded unsigned PSBT, sign all Taproot
 * inputs whose `tapInternalKey` matches the signer's key, and return the
 * hex-encoded signed (but not finalized) PSBT.
 *
 * **Lazy crypto.** The heavy Bitcoin/PSBT/silent-payments implementation
 * lives in `bitcoin-signers-impl.ts` and is only `import()`-ed the first
 * time `signPsbt` is called. This module — and therefore `useCurrentUser`,
 * which constructs these signers on every page — never statically pulls in
 * `@scure/btc-signer` or the `@/lib/bitcoin*` stack, keeping ~150 kB of
 * crypto out of the app's entry chunk.
 */
export interface BtcSigner extends NostrSigner {
  signPsbt(psbtHex: string): Promise<string>;
}

/** Runtime check for whether a signer supports `signPsbt`. */
export function hasBtcSigning(signer: NostrSigner): signer is BtcSigner {
  return typeof (signer as BtcSigner).signPsbt === 'function';
}

// ---------------------------------------------------------------------------
// NSecSignerBtc — local nsec signing
// ---------------------------------------------------------------------------

/**
 * Extends `NSecSigner` with local Taproot PSBT signing.
 *
 * `NSecSigner` stores the secret key in a JS `#private` field that subclasses
 * cannot access. To work around this, the constructor accepts the raw secret
 * key bytes, passes them to `super()`, and keeps its own copy in a true
 * runtime-private `#secretKeyBytes` field so the key is not reachable via
 * property enumeration or reflection on the instance.
 *
 * The actual PSBT signing (including the BIP-375 / silent-payments path) is
 * implemented in `bitcoin-signers-impl.ts` and dynamically imported on first
 * use, so the heavy crypto stack stays out of the entry bundle.
 */
export class NSecSignerBtc extends NSecSigner implements BtcSigner {
  readonly #secretKeyBytes: Uint8Array;

  constructor(secretKey: Uint8Array) {
    super(secretKey);
    this.#secretKeyBytes = new Uint8Array(secretKey);
  }

  /**
   * NIP-44 with the conversation key of a counterparty that RECURS kept for
   * the session. The key is an ECDH — ~4ms of secp256k1 on a desktop, several
   * times that on a phone — and `NSecSigner` derived it on every call, so
   * opening a NIP-17 message paid two: one for the wrap, whose ephemeral
   * author is new every time and gains nothing, and one for the seal, whose
   * author is the sender and is the same for every message (and every typing
   * signal) in the conversation.
   *
   * Admission takes a second sighting, so the one-shot wrap authors never
   * displace the senders. The keys are no more sensitive than the secret key
   * this instance already holds, and live exactly as long as it does.
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
      // Refresh recency: a Map iterates in insertion order.
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

// ---------------------------------------------------------------------------
// NBrowserSignerBtc — NIP-07 extension signing
// ---------------------------------------------------------------------------

/**
 * Extends `NBrowserSigner` with NIP-07 `window.nostr.signPsbt()` support.
 *
 * Calls the extension's `signPsbt` method if available. If the extension does
 * not expose `signPsbt`, an error is thrown with a user-friendly message.
 */
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

// ---------------------------------------------------------------------------
// NIP-46 remote signing
// ---------------------------------------------------------------------------
//
// The NIP-46 bunker signer is `Nip46Signer` in `@/lib/nip46Signer.ts` (a
// `BtcSigner`): a persistent-subscription, fenced-retry signer built on the
// dedicated plain-WebSocket transport. It replaced the old
// `NConnectSigner`-based wrapper, whose per-RPC subscriptions, unsettled
// response promises, and blind retries made remote signing unreliable (see
// nip46Signer.ts for the full rationale).
