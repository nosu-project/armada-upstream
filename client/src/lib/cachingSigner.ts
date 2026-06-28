import type { NostrSigner } from "@nostrify/nostrify";

import {
  type DecryptMethod,
  deriveDecryptId,
  getCachedDecrypt,
  putCachedDecrypt,
} from "@/lib/decryptCache";

// ============================================================================
// Decrypt-caching signer wrapper.
//
// Wraps a signer's `nip04.decrypt` / `nip44.decrypt` so a call with the same
// parameters is served from the persistent content-addressed cache
// (`decryptCache.ts`) instead of hitting the upstream signer. This is the win
// for remote (NIP-46) and extension (NIP-07) signers, where every decrypt is a
// slow serialized round-trip and the append-only event store makes us re-ask
// for the same ciphertext on every load.
//
// `getPublicKey`, `signEvent`, `getRelays`, and BOTH `encrypt` methods pass
// straight through untouched — only `decrypt` is memoized. (Encrypting and
// signing must always reach the real signer.)
//
// Apply this ONLY to the user-facing signer (see `useCurrentUser`). Never wrap
// the NIP-46 transport key or the NIP-42 AUTH signer.
// ============================================================================

/** A signer's `nip04`/`nip44` crypto bundle. */
type CryptoMethods = NonNullable<NostrSigner["nip04"]>;

/**
 * Wrap one crypto bundle (nip04 or nip44) so `decrypt` consults the persistent
 * cache first. `encrypt` is forwarded unchanged. Concurrent misses for the same
 * id share a single upstream decrypt (in-flight dedupe), mirroring the prior
 * in-memory memo.
 */
function wrapCrypto(
  method: DecryptMethod,
  crypto: CryptoMethods,
  userPubkey: string,
): CryptoMethods {
  const inflight = new Map<string, Promise<string>>();

  return {
    encrypt: crypto.encrypt.bind(crypto),
    async decrypt(counterparty: string, ciphertext: string): Promise<string> {
      const id = await deriveDecryptId(method, userPubkey, counterparty, ciphertext);

      // Share one resolution per id across concurrent callers. The shared
      // promise covers BOTH the cache read and the upstream decrypt, so two
      // simultaneous misses for the same ciphertext make a single signer call.
      const existing = inflight.get(id);
      if (existing) return existing;

      const pending = (async () => {
        const cached = await getCachedDecrypt(id);
        if (cached !== undefined) return cached;
        const plaintext = await crypto.decrypt(counterparty, ciphertext);
        void putCachedDecrypt(id, plaintext);
        return plaintext;
      })().finally(() => {
        inflight.delete(id);
      });

      inflight.set(id, pending);
      return pending;
    },
  };
}

/**
 * Return a signer whose `nip04`/`nip44` `decrypt` is backed by the persistent
 * decrypt cache. The original signer is not mutated; a thin object delegating
 * to it is returned. Absent crypto methods stay absent.
 *
 * @param signer     The user-facing signer to decorate.
 * @param userPubkey The user's pubkey, used to namespace cache entries per
 *                   account (so they survive an account switch but never cross
 *                   identities).
 */
export function wrapSignerWithDecryptCache(signer: NostrSigner, userPubkey: string): NostrSigner {
  const wrapped: NostrSigner = {
    getPublicKey: signer.getPublicKey.bind(signer),
    signEvent: signer.signEvent.bind(signer),
  };

  if (signer.getRelays) wrapped.getRelays = signer.getRelays.bind(signer);
  if (signer.nip04) wrapped.nip04 = wrapCrypto("nip04", signer.nip04, userPubkey);
  if (signer.nip44) wrapped.nip44 = wrapCrypto("nip44", signer.nip44, userPubkey);

  return wrapped;
}
