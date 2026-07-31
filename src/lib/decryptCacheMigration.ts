/**
 * Drain of the pre-ArmadaDB decrypt cache into ArmadaDB's KV.
 *
 * Kept out of `AppSigner.ts` so the signer imports nothing but the KV it now
 * reads and writes; this module is reached only from the migration catalogue.
 *
 * The cache is "only" a cache, but losing it is not free: every entry it holds
 * is a decrypt that would otherwise be a fresh round-trip to a bunker or
 * extension signer, so a dropped cache means a prompt storm across every DM
 * the user already opened.
 */
import { openDB } from "idb";

import { DECRYPT_CACHE_DB_NAME, decryptCacheKey } from "@/lib/AppSigner";
import { getArmadaDB } from "@/lib/db/armadaDB";

const STORE = "decrypts";
const DONE_KEY = "decrypt:migrated";

let drain: Promise<void> | undefined;

/** Copy every cached plaintext into KV. Idempotent; runs at most once. */
export function migrateLegacyDecryptCache(): Promise<void> {
  drain ??= drainLegacyDecryptCache();
  return drain;
}

async function drainLegacyDecryptCache(): Promise<void> {
  const db = getArmadaDB();
  if (await db.kv.get<boolean>(DONE_KEY)) return;
  if (typeof indexedDB === "undefined") return;

  try {
    // `openDB` without an upgrade callback still CREATES the database when it
    // is absent — harmless, and the migration deletes it either way.
    const legacy = await openDB(DECRYPT_CACHE_DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      },
    });
    const rows = (await legacy.getAll(STORE)) as Array<{ id: string; plaintext: string }>;
    for (const { id, plaintext } of rows) {
      if (typeof id === "string" && typeof plaintext === "string") {
        await db.kv.set(decryptCacheKey(id), plaintext);
      }
    }
    legacy.close();
  } catch {
    // Retry next launch rather than marking a partial copy done.
    drain = undefined;
    return;
  }

  await db.kv.set(DONE_KEY, true);
}
