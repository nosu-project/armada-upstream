/**
 * Synchronous, in-memory render memo for decrypted DM plaintext, keyed by event
 * id (a hash of the immutable event, so a stable, never-stale key).
 *
 * This is a thin L1 in front of the signer's persistent decrypt cache
 * (`decryptCache.ts`). Its sole job is to answer "do we already have this
 * message's plaintext?" *synchronously*, so the DM thread can paint decrypted
 * rows on the very first frame (`buildThreadPlaceholders`) and `decryptVisible`
 * can short-circuit without an async hop. The durable, content-addressed
 * persistence lives in the wrapped signer; this memo just avoids a DB round-trip
 * for messages already decoded this session and is cleared on reload/logout.
 */
const plaintextById = new Map<string, string>();

/** In-flight decrypts, so two surfaces asking for the same event at once share
 *  one decrypt instead of firing two. Cleared when the decrypt settles. */
const inflightById = new Map<string, Promise<string>>();

/** A signer's decrypt function: `(counterparty, ciphertext) => plaintext`. */
export type DecryptFn = (counterparty: string, ciphertext: string) => Promise<string>;

/** Return the memoized plaintext for an event id, or `undefined` on a miss. */
export function getRenderedPlaintext(id: string): string | undefined {
  return plaintextById.get(id);
}

/** Whether the plaintext for an event id is already memoized this session. */
export function hasRenderedPlaintext(id: string): boolean {
  return plaintextById.has(id);
}

/** Seed the memo (e.g. for a message we just composed/sent). */
export function setRenderedPlaintext(id: string, plaintext: string): void {
  plaintextById.set(id, plaintext);
}

/**
 * Decrypt an event's content, consulting the synchronous render memo first.
 *
 *  - **Hit:** returns immediately; neither the signer nor its persistent cache
 *    is touched.
 *  - **Miss:** decrypts via `decrypt` (which itself hits the persistent
 *    content-addressed cache, then the upstream signer), memoizes, and returns.
 *    Decrypts run concurrently — they are not serialized through a signer queue
 *    (modern NIP-07/NIP-46 signers batch overlapping calls). Concurrent misses
 *    for the same id still share a single decrypt.
 */
export async function decryptCached(
  counterparty: string,
  event: { id: string; content: string },
  decrypt: DecryptFn,
): Promise<string> {
  const cached = plaintextById.get(event.id);
  if (cached !== undefined) return cached;

  const existing = inflightById.get(event.id);
  if (existing) return existing;

  const pending = decrypt(counterparty, event.content)
    .then((plaintext) => {
      plaintextById.set(event.id, plaintext);
      return plaintext;
    })
    .finally(() => {
      inflightById.delete(event.id);
    });

  inflightById.set(event.id, pending);
  return pending;
}

/**
 * Drop the in-memory render memo. Called on logout/identity switch. The durable
 * plaintext in the signer's persistent cache is handled separately
 * (kept across account switches, wiped by `purgeClientStorage` on final logout).
 */
export function clearRenderedPlaintext(): void {
  plaintextById.clear();
  inflightById.clear();
}
