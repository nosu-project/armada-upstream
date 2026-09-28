/**
 * At-rest encryption for the Web Push worker's config (which holds the nsec):
 * AES-GCM under a non-extractable WebCrypto key in IndexedDB, so no second
 * plaintext nsec lands on disk. Does NOT defend against XSS. The page seals
 * (`sealConfig`/`clearVault`); `pushRuntime.ts` reads (`openSealedConfig`).
 */

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "armada-sw-vault";
const STORE = "keys";
const KEY_ID = "dm-config";
const IV_BYTES = 12;

// One reused connection per context; fresh ones leak handles and block deleteDB.
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
    // Copy: a SharedArrayBuffer-backed input is rejected by WebCrypto.
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
