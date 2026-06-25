/**
 * A tiny SYNCHRONOUS snapshot of folded Concord community state, so the member
 * list, server name/icon, and channel names paint on the FIRST frame after a
 * hard refresh — not after a chain of async IndexedDB reads.
 *
 * Why this exists: IndexedDB has no synchronous read API, so every cached read
 * resolves a frame or more after render. The folded roster/metadata path is a
 * chain of such reads (membership list → control events → fold), so on refresh
 * the user watches it cascade in. localStorage is the only browser storage that
 * is BOTH synchronous AND survives a refresh, so it's the only way to supply a
 * value on the very first render. We keep an in-memory mirror hydrated once at
 * module load; reads are then a plain Map lookup (no await, no IndexedDB).
 *
 * Scope is deliberately narrow: ONLY the small folded community shapes (roster,
 * metadata) go here — bounded, a few KB each. Messages/profiles stay on the
 * IndexedDB path (they're larger and already local-first). IndexedDB remains the
 * durable source of truth; this is just a hot first-paint cache that the live
 * fold overwrites the moment it's ready.
 *
 * Trust note: persists DECRYPTED folded community data (member/role graph, names)
 * at rest — the same device-trust level as the room keys already on disk.
 */

import { decode, encode } from "@/lib/concord/foldedCache";

const PREFIX = "armada:fold:";
/** Skip persisting anything larger than this, so one community can't hog the budget. */
const MAX_BYTES = 256 * 1024;

/** In-memory mirror, hydrated synchronously at module load. The source of sync reads. */
const mirror = new Map<string, string>();

function available(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

// Hydrate the mirror once, synchronously, at import.
if (available()) {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (raw != null) mirror.set(k.slice(PREFIX.length), raw);
    }
  } catch {
    // Degrade to an empty mirror.
  }
}

/** Read a folded value SYNCHRONOUSLY (for a useState initializer). Undefined on miss. */
export function readFoldSync<T>(key: string): T | undefined {
  const raw = mirror.get(key);
  return raw === undefined ? undefined : decode<T>(raw);
}

/** Persist a folded value. `serialized` is the caller's already-`encode`d string (dedup-friendly). */
export function writeFoldSync(key: string, serialized: string): void {
  if (serialized.length > MAX_BYTES) return;
  mirror.set(key, serialized);
  if (!available()) return;
  try {
    localStorage.setItem(PREFIX + key, serialized);
  } catch {
    // Quota/blocked — the in-memory mirror still serves this session.
  }
}

export { encode };
