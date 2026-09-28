/**
 * Persist the groupKey memo (derive.ts) in ArmadaDB's KV. Derivations are pure
 * functions of frozen wire format (CORD-02 Appendix A), so entries never go stale;
 * a warm boot skips ~500ms+ of secp256k1 work.
 *
 * Trust: persists DERIVED stream secrets at rest — the same device-trust level as
 * the stored plaintext and raw channel keys. Wiped on logout (purgeClientStorage).
 * One KV key holding one JSON array: read once at boot, written debounced.
 */
import { getArmadaDB } from "@/lib/db/armadaDB";

import { exportGroupKeyMemo, importGroupKeyMemo, onGroupKeyMemoDirty } from "./derive";

const KV_KEY = "c2gkmemo";

/** Entries kept, newest first; the cap only sheds long-gone communities' leftovers. */
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
 * Hydrate the memo and start write-behind; call once at boot. A derivation racing
 * hydration is only a cache miss.
 */
export async function initGroupKeyPersistence(): Promise<void> {
  onGroupKeyMemoDirty(scheduleSave);
  // Save on close, in case it lands inside the debounce window.
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
