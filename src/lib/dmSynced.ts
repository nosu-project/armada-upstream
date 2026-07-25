/**
 * "Has this account ever completed a DM sync on this device?" — one persisted
 * bit per account, per DM plane.
 *
 * The DM conversation list is local-first: it renders from IndexedDB (the
 * kind-4 event store, the NIP-17 rumor store) and treats the network as a
 * background top-up. That is the right shape once the store has content, but it
 * cannot distinguish the two reasons a local read comes back empty:
 *
 *   - the account genuinely has no DMs, or
 *   - this device has never synced, so the store hasn't been filled yet.
 *
 * Rendering "No conversations yet" in the second case is a lie, and painting a
 * partial list while the first sync is still running is what produced the
 * visible re-order this flag exists to kill. So the FIRST sync (and only the
 * first) awaits the network before the list paints; every later load renders
 * straight from the store and lets the network correct it in the background.
 *
 * Set only after a network pass that actually completed without throwing —
 * a timeout or an offline start must not latch the flag, or the next load
 * would show a false empty state.
 *
 * Stored under the `armada:` prefix, so `purgeClientStorage` clears it on
 * logout along with the caches it describes.
 */

/** Which DM transport the flag describes. The two sync independently. */
export type DmPlane = "nip04" | "nip17";

function storageKey(plane: DmPlane, pubkey: string): string {
  return `armada:dm-synced:${plane}:${pubkey}`;
}

/**
 * Whether {@link plane} has completed at least one network sync for this
 * account on this device. Synchronous (localStorage) so it can be read on the
 * render path and inside a queryFn.
 */
export function isDmSynced(plane: DmPlane, pubkey: string | undefined): boolean {
  if (!pubkey || typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(storageKey(plane, pubkey)) === "1";
  } catch {
    // Storage unavailable (private mode / disabled): treat every load as a
    // first sync. Correct, just slower — never a false empty state.
    return false;
  }
}

/** Latch {@link plane} as synced for this account. Best-effort. */
export function markDmSynced(plane: DmPlane, pubkey: string | undefined): void {
  if (!pubkey || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey(plane, pubkey), "1");
  } catch {
    // Quota/unavailable — the only cost is awaiting the network again.
  }
}
