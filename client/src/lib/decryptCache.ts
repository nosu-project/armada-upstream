import { type DBSchema, type IDBPDatabase, openDB } from "idb";

// ============================================================================
// Persistent, content-addressed decryption cache.
//
// Each NIP-04/NIP-44 `decrypt` is, for an extension (NIP-07) or remote bunker
// (NIP-46) signer, a slow serialized round-trip — and the local event store is
// append-only, so the same ciphertext is re-decrypted on every load, poll, and
// reconnect. That repeated round-trip is the visible lag, and on a remote
// signer it is brutal.
//
// This module caches `decrypt(counterparty, ciphertext) -> plaintext` keyed by
// a deterministic content hash of the *inputs*, so a decrypt with the same
// parameters returns the persisted result instead of touching the signer. It
// backs the signer wrapper in `cachingSigner.ts`, which is applied to the
// user-facing signer only (never NIP-46 transport / NIP-42 AUTH signers).
//
// Trust note: this persists DECRYPTED plaintext at rest, in exchange for a
// dramatically better remote-signer experience. That is a deliberate tradeoff
// (and matches `armada-concord-cache`, which already persists decrypted
// community data). Anyone with disk/profile access can read it; it is wiped on
// final logout by `purgeClientStorage`.
//
// Kept in its OWN IndexedDB database, separate from the ciphertext event store.
// Degrades to a no-op when IndexedDB is unavailable (private mode / SSR).
// ============================================================================

const DB_NAME = "armada-decrypt-cache";
const DB_VERSION = 1;
const STORE = "decrypts";

interface DecryptCacheDB extends DBSchema {
  [STORE]: {
    /** sha256(method ∥ userPubkey ∥ counterparty ∥ ciphertext), hex. */
    key: string;
    value: { id: string; plaintext: string };
  };
}

let dbPromise: Promise<IDBPDatabase<DecryptCacheDB> | null> | undefined;

function getDB(): Promise<IDBPDatabase<DecryptCacheDB> | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = openDB<DecryptCacheDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE, { keyPath: "id" });
    },
  }).catch(() => null);
  return dbPromise;
}

/** Decrypt scheme this entry was produced with. Folded into the id so a nip44
 *  entry can never be served for a nip04 call (different ciphers, same input
 *  strings would otherwise collide). */
export type DecryptMethod = "nip04" | "nip44";

/**
 * Deterministic, collision-free cache id for a decrypt's inputs.
 *
 * Scheme:  sha256(`${method}\0${userPubkey}\0${counterparty}\0${ciphertext}`).
 *
 *  - `method` distinguishes nip04 vs nip44 (different ciphers).
 *  - `userPubkey` namespaces per account, so entries survive an account switch
 *    yet never cross identities.
 *  - `counterparty` + `ciphertext` are the actual decrypt arguments; the
 *    ciphertext is immutable so the cached plaintext never goes stale.
 *
 * The NUL separators are unambiguous: a pubkey/method are hex, and the
 * ciphertext is base64/bech-ish — none contain NUL.
 */
export async function deriveDecryptId(
  method: DecryptMethod,
  userPubkey: string,
  counterparty: string,
  ciphertext: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${method}\u0000${userPubkey}\u0000${counterparty}\u0000${ciphertext}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** The cached plaintext for a derived id, or `undefined` on a miss / no IDB. */
export async function getCachedDecrypt(id: string): Promise<string | undefined> {
  const db = await getDB();
  if (!db) return undefined;
  try {
    const row = await db.get(STORE, id);
    return row?.plaintext;
  } catch {
    return undefined;
  }
}

/**
 * Persist a decrypt result. Best-effort and fire-and-forget: failures are
 * swallowed since the cache is never on the critical path.
 */
export async function putCachedDecrypt(id: string, plaintext: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  try {
    await db.put(STORE, { id, plaintext });
  } catch {
    // best-effort
  }
}

/** Test seam: close and reset the cached connection. */
export async function __resetDecryptCacheForTests(): Promise<void> {
  const prev = dbPromise;
  dbPromise = undefined;
  try {
    const db = await prev;
    db?.close();
  } catch {
    // ignore
  }
}
