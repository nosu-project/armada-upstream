/**
 * At-rest encryption for the small secret the Web Push service worker needs —
 * the DM gating config, whose `sk` field is the identity key it uses to unseal
 * gift wraps.
 *
 * The page can't hand the worker a raw key without leaving a second plaintext
 * copy on disk (Cache Storage is unencrypted at rest, same as the localStorage
 * the login already sits in). So the config is AES-GCM sealed under a
 * **non-extractable** WebCrypto key kept in IndexedDB: a stolen browser profile
 * or synced backup yields ciphertext plus a key that JS can't export, and the
 * page never persists a second readable copy of the nsec.
 *
 * What this does NOT defend: XSS. Same-origin script (page or worker) can still
 * ask the non-extractable key to decrypt in place — that's intrinsic to using a
 * key in a browser at all, and is unchanged from the nsec already living in
 * localStorage. Hardware isolation only exists on native (Keystore/Keychain),
 * which this web-only path never touches. This raises the at-rest bar; it does
 * not make a browser tab a secure enclave.
 *
 * Shared source: the page imports `sealConfig`/`clearVault` to write; the SW's
 * runtime bundle (`pushRuntime.ts`) imports `openSealedConfig` to read. One IndexedDB
 * key, created by the page, used by both contexts (they share origin storage).
 */

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "armada-sw-vault";
const STORE = "keys";
const KEY_ID = "dm-config";
const IV_BYTES = 12;

// One reused connection per context (page, worker). Opening a fresh connection
// per call leaks handles and blocks any later deleteDB.
let dbPromise: Promise<IDBPDatabase> | undefined;

function vaultDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

/** The existing vault key, or undefined if the page hasn't created one. */
async function getKey(): Promise<CryptoKey | undefined> {
  return (await vaultDb()).get(STORE, KEY_ID) as Promise<CryptoKey | undefined>;
}

/** The vault key, creating a fresh non-extractable AES-GCM key on first use. */
async function getOrCreateKey(): Promise<CryptoKey> {
  const db = await vaultDb();
  const existing = (await db.get(STORE, KEY_ID)) as CryptoKey | undefined;
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
  await db.put(STORE, key, KEY_ID);
  return key;
}

// ── Pure core (key in hand) — unit-tested without IndexedDB ───────────────────

/** AES-GCM seal an arbitrary JSON value; output is `iv || ciphertext`. */
export async function sealWithKey(key: CryptoKey, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/** Inverse of {@link sealWithKey}. Returns null on any tamper/format error. */
export async function openWithKey(key: CryptoKey, blob: Uint8Array): Promise<unknown | null> {
  try {
    // Copy into a fresh ArrayBuffer-backed view: the incoming array may be
    // SharedArrayBuffer-backed, which WebCrypto's BufferSource rejects.
    const bytes = new Uint8Array(blob);
    if (bytes.length <= IV_BYTES) return null;
    const iv = bytes.subarray(0, IV_BYTES);
    const ciphertext = bytes.subarray(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

// ── Vault-backed wrappers ─────────────────────────────────────────────────────

/** Seal a config under the (created-on-demand) vault key. */
export async function sealConfig(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  return sealWithKey(await getOrCreateKey(), value);
}

/** Open a sealed blob, or null when there's no key / it doesn't decrypt. */
export async function openSealedConfig(blob: Uint8Array): Promise<unknown | null> {
  const key = await getKey();
  if (!key) return null;
  return openWithKey(key, blob);
}

/** Destroy the vault key, rendering any sealed blob permanently unreadable. */
export async function clearVault(): Promise<void> {
  try {
    await (await vaultDb()).delete(STORE, KEY_ID);
  } catch {
    // ignore
  }
}
