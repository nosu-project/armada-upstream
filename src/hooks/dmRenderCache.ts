/**
 * Synchronous in-memory memo of decrypted DM plaintext by event id — an L1 in
 * front of the signer's persistent decrypt cache (`AppSigner`), so threads can
 * paint decrypted rows on the first frame. Cleared on reload/logout.
 */
const plaintextById = new Map<string, string>();

/** In-flight decrypts, so concurrent requests for one event share a decrypt. */
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
 * Decrypt an event's content via the synchronous memo first; on a miss, decrypt
 * (hitting the persistent cache) and memoize. Not serialized; concurrent misses
 * for one id share a decrypt.
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

/** Drop the render memo (logout/identity switch); the signer's persistent cache is handled separately. */
export function clearRenderedPlaintext(): void {
  plaintextById.clear();
  inflightById.clear();
}
