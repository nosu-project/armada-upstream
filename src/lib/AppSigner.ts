import { getArmadaDB } from "@/lib/db/armadaDB";

import type { NostrSigner } from "@nostrify/nostrify";
import type { BtcSigner } from "@/lib/bitcoin-signers";

// ============================================================================
// AppSigner — the app-facing Nostr signer.
//
// Wraps an upstream signer (nsec / NIP-07 extension / NIP-46 bunker) with the
// behaviour every component-facing signer needs. Today that is a persistent,
// content-addressed DECRYPT cache: each NIP-04/NIP-44 `decrypt` is, for an
// extension or remote bunker, a slow round-trip — and the local event store is
// append-only, so the same ciphertext would be re-decrypted on every load,
// poll, and reconnect. AppSigner caches `decrypt(counterparty, ciphertext) ->
// plaintext` keyed by a content hash of the inputs and serves the persisted
// result instead of touching the signer.
//
// `getPublicKey`, `signEvent`, `getRelays`, and both `encrypt` methods pass
// straight through — only `decrypt` is memoized. (Encrypting and signing must
// always reach the real signer.)
//
// Use AppSigner ONLY for the user-facing signer (see `useCurrentUser`). Never
// wrap the NIP-46 transport key or the NIP-42 AUTH signer.
//
// Trust note: this persists DECRYPTED plaintext at rest, in exchange for a
// dramatically better remote-signer experience. That is a deliberate tradeoff
// (and matches the fold cache, which already persists decrypted community
// data). Anyone with disk/profile access can read it; it is wiped on
// final logout by `purgeClientStorage`.
//
// The IndexedDB connection lives on the instance (opened lazily, kept open for
// the instance's lifetime). Degrades to a no-op when IndexedDB is unavailable
// (private mode / SSR).
// ============================================================================

/** The pre-ArmadaDB database, drained by the `decrypt-cache` migration. */
export const DECRYPT_CACHE_DB_NAME = "armada-decrypt-cache";

/**
 * KV key for a derived cache id. ArmadaDB's KV is one shared namespace, so
 * every subsystem prefixes its own keys.
 */
export const decryptCacheKey = (id: string): string => `decrypt:${id}`;

/** A signer's `nip04`/`nip44` crypto bundle. */
type CryptoMethods = NonNullable<NostrSigner["nip04"]>;

/**
 * The same bundle, widened with an opt-out from the PERSISTENT cache.
 *
 * Disappearing DMs (NIP-40 expiring gift wraps) must leave nothing at rest, so
 * `openDmWrap` passes `{ cache: false }` for an expiring envelope: the decrypt
 * still happens (and still coalesces with concurrent identical decrypts), but
 * its plaintext is neither read from nor written to IndexedDB. Signers that
 * don't cache ignore the extra argument, so this stays structurally compatible
 * with plain `NostrSigner`.
 */
export interface CachingCryptoMethods extends CryptoMethods {
  decrypt(counterparty: string, ciphertext: string, opts?: { cache?: boolean }): Promise<string>;
}

/** Which NIP scheme a cached entry was produced with. Folded into the cache id
 *  so a nip44 entry can never be served for a nip04 call (different ciphers). */
type DecryptMethod = "nip04" | "nip44";

export class AppSigner implements NostrSigner {
  readonly #upstream: NostrSigner;
  readonly #pubkey: string;

  /** In-flight decrypts, keyed by cache id, so concurrent callers asking for
   *  the same ciphertext share one cache-read + upstream-decrypt. */
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(upstream: NostrSigner, userPubkey: string) {
    this.#upstream = upstream;
    this.#pubkey = userPubkey;

    // Mirror the upstream's optional crypto bundles: present iff upstream has
    // them. `decrypt` is wrapped; `encrypt` is forwarded.
    if (upstream.nip04) this.nip04 = this.#wrapCrypto("nip04", upstream.nip04);
    if (upstream.nip44) this.nip44 = this.#wrapCrypto("nip44", upstream.nip44);
  }

  // --- pass-through signer surface -----------------------------------------

  getPublicKey(): Promise<string> {
    return this.#upstream.getPublicKey();
  }

  signEvent(event: Parameters<NostrSigner["signEvent"]>[0]): ReturnType<NostrSigner["signEvent"]> {
    return this.#upstream.signEvent(event);
  }

  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
    return this.#upstream.getRelays?.() ?? Promise.resolve({});
  }

  /**
   * Forward PSBT signing to the upstream when it supports it (the BTC-enabled
   * signer variants from `@/lib/bitcoin-signers`). `useBitcoinSigner` probes
   * this via `hasBtcSigning` — the AppSigner wrapper is transparent for the
   * PSBT surface, just as it is for `getPublicKey`/`signEvent`/`getRelays`.
   */
  signPsbt(psbtHex: string): Promise<string> {
    const upstream = this.#upstream as Partial<BtcSigner>;
    if (typeof upstream.signPsbt !== "function") {
      return Promise.reject(new Error("This signer does not support PSBT signing."));
    }
    return upstream.signPsbt(psbtHex);
  }

  nip04?: CachingCryptoMethods;
  nip44?: CachingCryptoMethods;

  // --- cache introspection --------------------------------------------------

  /**
   * Whether this ciphertext's plaintext is already cached (persistent IDB or an
   * in-flight decrypt), i.e. resolving it would NOT touch the upstream signer.
   *
   * The consent gate uses this to gate ONLY the decrypts that would actually
   * poke a bunker/extension: a fully-cached set needs no prompt at all. Returns
   * false on any error / when IDB is unavailable (treat as "would hit signer").
   */
  async isDecryptCached(method: DecryptMethod, counterparty: string, ciphertext: string): Promise<boolean> {
    const id = await this.#deriveId(method, counterparty, ciphertext);
    if (this.#inflight.has(id)) return true;
    return (await this.#get(id)) !== undefined;
  }

  // --- decrypt cache --------------------------------------------------------

  #wrapCrypto(method: DecryptMethod, crypto: CryptoMethods): CachingCryptoMethods {
    return {
      encrypt: (pubkey, plaintext) => crypto.encrypt(pubkey, plaintext),
      decrypt: (counterparty, ciphertext, opts) =>
        this.#cachedDecrypt(method, crypto, counterparty, ciphertext, opts?.cache ?? true),
    };
  }

  async #cachedDecrypt(
    method: DecryptMethod,
    crypto: CryptoMethods,
    counterparty: string,
    ciphertext: string,
    cache: boolean,
  ): Promise<string> {
    const id = await this.#deriveId(method, counterparty, ciphertext);

    // Share one resolution per id across concurrent callers. The shared promise
    // covers BOTH the cache read and the upstream decrypt, so two simultaneous
    // misses for the same ciphertext make a single signer call. In-flight
    // sharing is memory-only, so an opted-out caller still joins it — the same
    // ciphertext has exactly one plaintext either way.
    const existing = this.#inflight.get(id);
    if (existing) return existing;

    const pending = (async () => {
      // `cache: false` (expiring DM envelopes) skips the persistent cache in
      // both directions: nothing to read back, and nothing left on disk.
      if (!cache) return crypto.decrypt(counterparty, ciphertext);
      const cached = await this.#get(id);
      if (cached !== undefined) return cached;
      const plaintext = await crypto.decrypt(counterparty, ciphertext);
      void this.#put(id, plaintext);
      return plaintext;
    })().finally(() => {
      this.#inflight.delete(id);
    });

    this.#inflight.set(id, pending);
    return pending;
  }

  /**
   * Deterministic, collision-free cache id for a decrypt's inputs:
   * sha256(`${method}\0${pubkey}\0${counterparty}\0${ciphertext}`).
   *
   *  - `method` distinguishes nip04 vs nip44 (different ciphers).
   *  - the user pubkey namespaces per account (entries survive an account
   *    switch yet never cross identities).
   *  - `counterparty` + `ciphertext` are the decrypt arguments; the ciphertext
   *    is immutable so the cached plaintext never goes stale.
   *
   * The NUL separators are unambiguous: method/pubkey are hex and the
   * ciphertext is base64/bech-ish — none contain NUL.
   */
  async #deriveId(method: DecryptMethod, counterparty: string, ciphertext: string): Promise<string> {
    const data = new TextEncoder().encode(
      `${method}\u0000${this.#pubkey}\u0000${counterparty}\u0000${ciphertext}`,
    );
    const digest = await crypto.subtle.digest("SHA-256", data);
    let hex = "";
    for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  /** The cached plaintext for a derived id, or `undefined` on a miss. */
  async #get(id: string): Promise<string | undefined> {
    try {
      return await getArmadaDB().kv.get<string>(decryptCacheKey(id));
    } catch {
      return undefined;
    }
  }

  /** Persist a decrypt result. Best-effort: failures are swallowed since the
   *  cache is never on the critical path. */
  async #put(id: string, plaintext: string): Promise<void> {
    try {
      await getArmadaDB().kv.set(decryptCacheKey(id), plaintext);
    } catch {
      // best-effort
    }
  }
}

/**
 * Whether a signer is an AppSigner exposing `isDecryptCached` — the cache-peek
 * the consent gate uses to skip prompting when a decrypt would be served from
 * cache anyway. A non-AppSigner (e.g. the raw AUTH signer) reports as not
 * cacheable, which the gate treats conservatively as "would hit the signer".
 */
export function canPeekDecryptCache(
  signer: unknown,
): signer is Pick<AppSigner, "isDecryptCached"> {
  return typeof (signer as { isDecryptCached?: unknown } | null)?.isDecryptCached === "function";
}
