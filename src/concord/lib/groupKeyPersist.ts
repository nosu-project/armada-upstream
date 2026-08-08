/**
 * Persist the groupKey memo (derive.ts) across sessions in ArmadaDB's KV.
 *
 * Every derivation is a pure function of frozen wire format (CORD-02 Appendix
 * A), so a persisted entry can never go stale — only unused. A warm boot that
 * hydrates the memo pays zero secp256k1 point multiplications for the key sets
 * it derived last session (measured at ~500ms of main-thread crypto per boot
 * on desktop, several times that on a phone).
 *
 * Trust note: this persists DERIVED stream secret keys at rest — the same
 * device-trust level as the decrypted plane data the rumor store keeps and
 * the raw channel keys inside the stored membership list. Anyone with local
 * storage access already holds the inputs. Wiped on logout with the rest of
 * ArmadaDB (purgeClientStorage), and the full-logout page navigation kills any
 * debounced save still pending.
 *
 * One KV key holding one JSON array, not a row per entry: the blob is read
 * once at boot and written debounced, and a single value rides both adapters'
 * batching (one transaction on web, one bridge crossing on Android).
 */
import { getArmadaDB } from "@/lib/db/armadaDB";

import { exportGroupKeyMemo, importGroupKeyMemo, onGroupKeyMemoDirty } from "./derive";

const KV_KEY = "c2gkmemo";

/**
 * Entries kept, newest first. The working set is O(communities × channels ×
 * held epochs), typically well under a thousand; the cap only sheds the
 * stalest leftovers of communities long gone.
 */
const MAX_PERSISTED = 4096;

/** Derivations arrive in bursts (a channelsView derives a community's whole set). */
const SAVE_DEBOUNCE_MS = 3000;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

function scheduleSave(): void {
  dirty = true;
  saveTimer ??= setTimeout(save, SAVE_DEBOUNCE_MS);
}

function save(): void {
  saveTimer = undefined;
  if (!dirty) return;
  dirty = false;
  void getArmadaDB()
    .kv.set(KV_KEY, exportGroupKeyMemo(MAX_PERSISTED))
    .catch(() => undefined);
}

/**
 * Hydrate the memo from KV and start write-behind. Call once at boot, before
 * communities assemble if possible — but a derivation racing the hydration is
 * only a cache miss, never wrong (the memo claims a hydrated entry solely for
 * a key it hasn't already derived).
 */
export async function initGroupKeyPersistence(): Promise<void> {
  onGroupKeyMemoDirty(scheduleSave);
  // A tab that derives and then closes inside the debounce window still saves.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      save();
    });
  }
  try {
    const entries = await getArmadaDB().kv.get<unknown[]>(KV_KEY);
    if (Array.isArray(entries)) importGroupKeyMemo(entries);
  } catch {
    // Best-effort: an unreadable cache just means keys re-derive as before.
  }
}
