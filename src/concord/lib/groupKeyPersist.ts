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

import { clearGroupKeyMemo, exportGroupKeyMemo, importGroupKeyMemo, onGroupKeyMemoDirty } from "./derive";

const KV_KEY = "c2gkmemo";

/** Entries kept, newest first; the cap only sheds long-gone communities' leftovers. */
const MAX_PERSISTED = 4096;

/** Derivations arrive in bursts (a channelsView derives a community's whole set). */
const SAVE_DEBOUNCE_MS = 3000;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
/** Latched by logout: a save after the purge would write secrets into the wiped KV. */
let stopped = false;

function scheduleSave(): void {
  if (stopped) return;
  dirty = true;
  saveTimer ??= setTimeout(save, SAVE_DEBOUNCE_MS);
}

function save(): void {
  saveTimer = undefined;
  if (stopped || !dirty) return;
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
    if (!stopped && Array.isArray(entries)) importGroupKeyMemo(entries);
  } catch {
    // Best-effort: an unreadable cache just means keys re-derive as before.
  }
}

/**
 * Logout: drop the in-memory secrets and stop persisting for the rest of the page's
 * life. Call before the purge, so no pending save can land after it.
 */
export function clearGroupKeyMemory(): void {
  stopped = true;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  dirty = false;
  clearGroupKeyMemo();
}
