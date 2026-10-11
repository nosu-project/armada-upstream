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

function floorKey(pubkey: string, relayKey: string): string {
  return `armada:dm-pull-floor:nip04:${pubkey}:${relayKey}`;
}

/** Short stable fingerprint of the established-peer set a floor was pulled with. */
function peersTag(peerKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < peerKey.length; i++) h = Math.imul(h ^ peerKey.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * Start (secs) of the last COMPLETED kind-4 relay pull for this account, relay set and
 * peer set, so a cold start tops up with `since` instead of re-reading the first page.
 * A new relay or a newly established peer has no floor, so its history is fetched.
 */
export function readDmPullFloor(pubkey: string, relayKey: string, peerKey: string): number | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const [at, tag] = (localStorage.getItem(floorKey(pubkey, relayKey)) ?? "").split(":");
    const n = Number(at);
    return tag === peersTag(peerKey) && Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeDmPullFloor(pubkey: string, relayKey: string, peerKey: string, secs: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(floorKey(pubkey, relayKey), `${secs}:${peersTag(peerKey)}`);
  } catch {
    // Only cost: the next cold start re-reads the first page.
  }
}
