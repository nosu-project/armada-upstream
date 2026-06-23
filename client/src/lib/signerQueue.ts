/**
 * Per-identity serialization of signer crypto (`encrypt` / `decrypt` /
 * `signEvent`).
 *
 * NIP-07 browser extensions (and remote NIP-46 bunkers) process signer calls
 * one at a time and **reject** — or queue unpredictably — when calls overlap.
 * Several surfaces fire signer crypto concurrently: sending a message, the
 * thread/decrypt loops, live subscriptions, conversation previews. If those
 * overlap on the same extension they thrash, reject, and feel "locked up".
 *
 * Routing every signer crypto call for a given identity through one FIFO
 * promise chain keeps them strictly sequential (and is effectively free on a
 * local nsec, where there is no contention). The chain is keyed at module
 * scope by pubkey so it is shared across every hook instance and survives
 * remounts.
 */
const signerCryptoChains = new Map<string, Promise<unknown>>();

/** Run `fn` exclusively against the signer identified by `key` (FIFO). */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = signerCryptoChains.get(key) ?? Promise.resolve();
  // Chain off the prior call regardless of whether it resolved or rejected,
  // so one failure never wedges the queue.
  const next = prior.then(fn, fn);
  // Store a settled-swallowing tail so the stored promise never rejects
  // (which would otherwise reject every future `.then` chained onto it).
  signerCryptoChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
