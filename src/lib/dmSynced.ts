/**
 * Whether this account has completed a DM sync on this device, per plane. An
 * empty local read can mean "no DMs" or "never synced"; only the FIRST sync
 * awaits the network before painting. Set only after a pass that completed
 * (timeouts must not latch it, or the next load shows a false empty state).
 * `armada:` prefix → purged on logout.
 */

export type DmPlane = "nip04" | "nip17";

function storageKey(plane: DmPlane, pubkey: string): string {
  return `armada:dm-synced:${plane}:${pubkey}`;
}

/** Whether {@link plane} has completed a network sync here. Synchronous (localStorage). */
export function isDmSynced(plane: DmPlane, pubkey: string | undefined): boolean {
  if (!pubkey || typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(storageKey(plane, pubkey)) === "1";
  } catch {
    // No storage: treat every load as a first sync (slower, never falsely empty).
    return false;
  }
}

export function markDmSynced(plane: DmPlane, pubkey: string | undefined): void {
  if (!pubkey || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey(plane, pubkey), "1");
  } catch {
    // Only cost: awaiting the network again.
  }
}
