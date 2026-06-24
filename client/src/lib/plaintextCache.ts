import { runExclusive } from "@/lib/signerQueue";

/**
 * In-memory plaintext memo for decrypted message content, keyed by event id.
 *
 * The problem: switching between chats re-decrypts every message from scratch.
 * Each NIP-04/NIP-44 decrypt is a serialized round-trip to the signer (a NIP-07
 * extension or NIP-46 bunker — see {@link runExclusive}), so opening a thread
 * fires a long sequential chain of IPC/network calls. That chain is the visible
 * lag when navigating between conversations.
 *
 * The fix: cache `eventId -> plaintext` in memory. An event's ciphertext is
 * immutable and its id is a hash of the whole event, so the id is a stable,
 * collision-free key and the cached plaintext never goes stale. A cache hit
 * returns synchronously and **never touches the signer queue**, so re-opening a
 * thread you've already viewed this session is instant.
 *
 * Deliberately memory-only. Persisting plaintext to disk would let anyone with
 * profile/disk access read decrypted DMs without the signer — a real downgrade
 * to the security posture. This memo lives only in the JS heap (the same place
 * the already-decrypted messages sit in the React Query cache), and is cleared
 * on reload or logout. It solves the chat-switch lag (the common case); a cold
 * reload still decrypts once.
 *
 * The memo is keyed at module scope so it is shared across every hook instance
 * and survives component remounts (the whole point — navigating away and back
 * must hit the cache).
 */
const plaintextById = new Map<string, string>();

/**
 * In-flight decrypts, so two surfaces (thread + preview, thread + live sub)
 * asking for the same event at once share one signer call instead of queueing
 * two. Cleared when the decrypt settles.
 */
const inflightById = new Map<string, Promise<string>>();

/** A signer's decrypt function: `(counterparty, ciphertext) => plaintext`. */
export type DecryptFn = (counterparty: string, ciphertext: string) => Promise<string>;

/** Return the cached plaintext for an event id, or `undefined` on a miss. */
export function getCachedPlaintext(id: string): string | undefined {
  return plaintextById.get(id);
}

/** Whether the plaintext for an event id is already memoized. */
export function hasCachedPlaintext(id: string): boolean {
  return plaintextById.has(id);
}

/** Manually seed the memo (e.g. for a message we just composed/sent). */
export function setCachedPlaintext(id: string, plaintext: string): void {
  plaintextById.set(id, plaintext);
}

/**
 * Decrypt an event's content, consulting the in-memory memo first.
 *
 *  - **Hit:** returns synchronously-resolved plaintext; the signer is never
 *    invoked and the call never enters the per-identity signer queue.
 *  - **Miss:** decrypts via `decrypt` serialized through {@link runExclusive}
 *    for `signerKey` (extension-safe), memoizes, and returns. Concurrent misses
 *    for the same id share a single in-flight decrypt.
 *
 * @param signerKey   The identity key for signer serialization (the user's pubkey).
 * @param counterparty The other party of the conversation (for the decrypt call).
 * @param event       The encrypted event (`{ id, content }`).
 * @param decrypt     The signer's decrypt function.
 */
export async function decryptCached(
  signerKey: string,
  counterparty: string,
  event: { id: string; content: string },
  decrypt: DecryptFn,
): Promise<string> {
  const cached = plaintextById.get(event.id);
  if (cached !== undefined) return cached;

  const existing = inflightById.get(event.id);
  if (existing) return existing;

  const pending = runExclusive(signerKey, () => decrypt(counterparty, event.content))
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
 * Drop all memoized plaintext. Call on logout/identity switch so one user's
 * decrypted content can never be read after another logs in.
 */
export function clearPlaintextCache(): void {
  plaintextById.clear();
  inflightById.clear();
}
