/**
 * Drain of the pre-ArmadaDB decrypt cache into KV (kept out of `AppSigner.ts`).
 * Losing it means a signer prompt storm across every DM already opened.
 */
import { openDB } from "idb";

import { DECRYPT_CACHE_DB_NAME, decryptCacheKey } from "@/lib/AppSigner";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { skipLegacyDrain } from "@/lib/db/legacyDatabases";

const STORE = "decrypts";
const DONE_KEY = "decrypt:migrated";

let drain: Promise<void> | undefined;

/**
 * Copy every cached plaintext into KV, at most once. REJECTS on failure so the
 * startup gate doesn't delete the legacy DB.
 */
export function migrateLegacyDecryptCache(): Promise<void> {
  drain ??= drainLegacyDecryptCache().catch((err: unknown) => {
    drain = undefined;
    throw err;
  });
  return drain;
}

async function drainLegacyDecryptCache(): Promise<void> {
  const db = getArmadaDB();
  if (await db.kv.get<boolean>(DONE_KEY)) return;
  if (typeof indexedDB === "undefined") return;
  // `openDB` CREATES the database when it is absent; see `skipLegacyDrain`.
  if (await skipLegacyDrain(DECRYPT_CACHE_DB_NAME)) return;

  const legacy = await openDB(DECRYPT_CACHE_DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
    },
  });
  try {
    const rows = (await legacy.getAll(STORE)) as Array<{ id: string; plaintext: string }>;
    for (const { id, plaintext } of rows) {
      if (typeof id === "string" && typeof plaintext === "string") {
        await db.kv.set(decryptCacheKey(id), plaintext);
      }
    }
  } finally {
    legacy.close();
  }

  await db.kv.set(DONE_KEY, true);
}
