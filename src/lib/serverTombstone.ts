import { normalizeRelayUrl } from "@/lib/platform";

/**
 * Local "removed servers" tombstones.
 *
 * Removing a server writes two things: the local `addedRelays` cache, and a
 * diff-publish to the kind 10009 list. Neither is enough on its own, because
 * every path that hydrates `addedRelays` from the network is a UNION — it can
 * only ever add. A union is the right call (a transient empty/partial read must
 * never wipe the rail), but it means a re-add signal always wins over a removal
 * unless something explicitly vetoes it. Two such signals exist:
 *
 *   • the kind 10009 server list (NostrSync 1b), and
 *   • the kind 30078 encrypted settings blob, which carries `addedRelays`
 *     itself (NostrSync 1) and is union-merged on the way in.
 *
 * Plus a third, purely local one: visiting `/s/<relay>/<group>` re-adds the
 * server to the rail so back-navigation works (`GroupPage`).
 *
 * A tombstone records "the user removed this server at time T" and vetoes any
 * re-add that reflects state OLDER than T. That makes removal durable against
 * stale relay copies and stale settings blobs, which is the whole point.
 *
 * A tombstone is cleared only by evidence of a genuine re-add:
 *
 *   • an explicit user action on this device (Settings/Add/invite/join), or
 *   • a synced event created AFTER the removal that still carries the server —
 *     i.e. another device added it back since.
 *
 * Note what does NOT clear a tombstone: merely observing a list that omits the
 * server. That was the original rule, and it defeated the mechanism — the
 * tombstone evaporated the moment one read confirmed the removal, leaving
 * nothing to veto the next stale read that still carried it. Absence is not
 * evidence of a re-add, so absence must not clear.
 *
 * Keyed per pubkey so tombstones from one account never leak into another.
 * Persisted to localStorage so a removal survives a reload. This is
 * device-local intent, not synced state — the 10009 list remains the
 * cross-device source of truth.
 */

const STORAGE_PREFIX = "armada-removed-servers:";

/** Normalized server url → removal time (ms since epoch). */
export type ServerTombstones = Map<string, number>;

function storageKey(pubkey: string): string {
  return `${STORAGE_PREFIX}${pubkey}`;
}

/** Normalize for stable comparison; fall back to the raw url if unparseable. */
function norm(url: string): string {
  return normalizeRelayUrl(url) ?? url;
}

function read(pubkey: string): ServerTombstones {
  try {
    const raw = localStorage.getItem(storageKey(pubkey));
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    // Current format: { [url]: removedAtMs }.
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      const out: ServerTombstones = new Map();
      for (const [url, at] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof at === "number" && Number.isFinite(at)) out.set(url, at);
      }
      return out;
    }
    // Legacy format: a bare array of urls with no removal time. We can't know
    // when these were removed, so stamp them NOW — conservative, since the
    // whole purpose is to veto re-adds that predate the removal, and treating
    // an unknown time as "long ago" would veto nothing.
    if (Array.isArray(parsed)) {
      const now = Date.now();
      const out: ServerTombstones = new Map(
        parsed.filter((u): u is string => typeof u === "string").map((u) => [u, now]),
      );
      write(pubkey, out);
      return out;
    }
  } catch {
    /* corrupt / unavailable storage → treat as empty */
  }
  return new Map();
}

function write(pubkey: string, entries: ServerTombstones): void {
  try {
    if (entries.size === 0) {
      localStorage.removeItem(storageKey(pubkey));
    } else {
      localStorage.setItem(storageKey(pubkey), JSON.stringify(Object.fromEntries(entries)));
    }
  } catch {
    /* storage unavailable → tombstone is best-effort, in-memory only for this call */
  }
}

/** Record that the user removed `url` for `pubkey` (normalized) at `at`. */
export function addServerTombstone(pubkey: string, url: string, at: number = Date.now()): void {
  const entries = read(pubkey);
  entries.set(norm(url), at);
  write(pubkey, entries);
}

/**
 * Drop a tombstone because the user explicitly (re)added the server on this
 * device — adding it in Settings/Add, accepting an invite to it, or joining a
 * channel on it. Explicit intent always beats a recorded removal.
 */
export function clearServerTombstone(pubkey: string, url: string): void {
  const entries = read(pubkey);
  if (entries.delete(norm(url))) write(pubkey, entries);
}

/** The tombstones currently in force for `pubkey` (normalized url → removedAt). */
export function getServerTombstones(pubkey: string): ServerTombstones {
  return read(pubkey);
}

/** True if `url` is currently tombstoned for `pubkey`. */
export function isServerTombstoned(pubkey: string, url: string): boolean {
  return read(pubkey).has(norm(url));
}

/**
 * Reconcile tombstones against a synced list of servers that is about to be
 * merged into the local cache.
 *
 * `signalAtMs` is when the source event was created (ms since epoch). A
 * tombstoned server that the list still carries, from an event created AFTER
 * the removal, is a genuine cross-device re-add — clear that tombstone and let
 * it through. Everything else keeps its tombstone: an older event is a stale
 * echo of the pre-removal state, and an event of unknown age (`undefined`) is
 * not evidence of anything.
 *
 * Returns the still-active tombstone set for the caller to filter its merge
 * with, without needing a second read.
 */
export function reconcileServerTombstones(
  pubkey: string,
  listServers: readonly string[],
  signalAtMs?: number,
): Set<string> {
  const entries = read(pubkey);
  if (entries.size === 0) return new Set();

  if (signalAtMs !== undefined) {
    const listed = new Set(listServers.map(norm));
    let changed = false;
    for (const [url, removedAt] of [...entries]) {
      // The server is back in the list, per an event newer than the removal →
      // another device re-added it → the removal has been superseded.
      if (listed.has(url) && signalAtMs > removedAt) {
        entries.delete(url);
        changed = true;
      }
    }
    if (changed) write(pubkey, entries);
  }

  return new Set(entries.keys());
}
