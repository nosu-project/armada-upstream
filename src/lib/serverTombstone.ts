import { normalizeRelayUrl } from "@/lib/platform";

/**
 * Local "removed servers" tombstones.
 *
 * When a user removes a server in Settings, we diff-publish the removal to the
 * kind 10009 list. But the sync-driven hydration (NostrSync 1b) merges the
 * server list from whatever 10009 event a relay returns — and a slow relay can
 * hand back the STALE pre-removal event before the updated one propagates,
 * re-adding the just-removed server to `addedRelays`. The rail then "un-removes"
 * the server under the user.
 *
 * A tombstone records "the user removed this server locally" so the hydration
 * can filter it back out until the network confirms the removal (a 10009 read
 * that no longer contains the server). This is device-local intent, not synced
 * state — the 10009 list remains the cross-device source of truth.
 *
 * Keyed per pubkey so tombstones from one account never leak into another.
 * Persisted to localStorage so a removal survives a reload while stale relays
 * are still catching up.
 */

const STORAGE_PREFIX = "armada-removed-servers:";

function storageKey(pubkey: string): string {
  return `${STORAGE_PREFIX}${pubkey}`;
}

/** Normalize for stable comparison; fall back to the raw url if unparseable. */
function norm(url: string): string {
  return normalizeRelayUrl(url) ?? url;
}

function read(pubkey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(pubkey));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((u): u is string => typeof u === "string"));
  } catch {
    /* corrupt / unavailable storage → treat as empty */
  }
  return new Set();
}

function write(pubkey: string, urls: Set<string>): void {
  try {
    if (urls.size === 0) {
      localStorage.removeItem(storageKey(pubkey));
    } else {
      localStorage.setItem(storageKey(pubkey), JSON.stringify([...urls]));
    }
  } catch {
    /* storage unavailable → tombstone is best-effort, in-memory only for this call */
  }
}

/** Record that the user removed `url` for `pubkey` (normalized). */
export function addServerTombstone(pubkey: string, url: string): void {
  const set = read(pubkey);
  set.add(norm(url));
  write(pubkey, set);
}

/** Remove a single tombstone entry (e.g. the server was re-added by the user). */
export function clearServerTombstone(pubkey: string, url: string): void {
  const set = read(pubkey);
  if (set.delete(norm(url))) write(pubkey, set);
}

/** The set of normalized server urls the user has removed locally. */
export function getServerTombstones(pubkey: string): Set<string> {
  return read(pubkey);
}

/** True if `url` is currently tombstoned for `pubkey`. */
export function isServerTombstoned(pubkey: string, url: string): boolean {
  return read(pubkey).has(norm(url));
}

/**
 * Reconcile tombstones against a freshly-read 10009 server list. Any tombstoned
 * server that the list NO LONGER contains has propagated — the removal is
 * confirmed, so drop its tombstone. Returns the still-pending tombstone set
 * (servers the (possibly stale) list still contains) for immediate use by the
 * caller without a second read.
 */
export function reconcileServerTombstones(
  pubkey: string,
  listServers: readonly string[],
): Set<string> {
  const tombstones = read(pubkey);
  if (tombstones.size === 0) return tombstones;

  const listed = new Set(listServers.map(norm));
  let changed = false;
  for (const url of [...tombstones]) {
    // The list no longer carries this server → removal has propagated → clear.
    if (!listed.has(url)) {
      tombstones.delete(url);
      changed = true;
    }
  }
  if (changed) write(pubkey, tombstones);
  return tombstones;
}
