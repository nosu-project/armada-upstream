/**
 * A key→value cache of DECRYPTED / folded Concord results (community metadata,
 * roster) held across reloads, so the rail icon, the community name/banner, and
 * the admin roster paint instantly on refresh instead of waiting for the raw
 * events to be re-read + re-decrypted + re-folded.
 *
 * Stored in ArmadaDB's KV under a `folded:` prefix. KV takes only
 * JSON-serializable values, and folded shapes contain `bigint`, `Uint8Array`,
 * `Map`, and `Set` — so {@link encode}/{@link decode} wrap them in tagged
 * objects and what actually reaches KV is a string. Callers still hand this
 * module the live shapes; the codec is not their problem.
 *
 * Trust note: this persists DECRYPTED community data at rest. That is the same
 * device-trust level as the raw community keys already in the event store /
 * membership list — anyone with local storage access already has the keys.
 */
import { openDB } from "idb";

import { getArmadaDB } from "@/lib/db/armadaDB";
import { legacyMigrationsComplete, skipLegacyDrain } from "@/lib/db/legacyDatabases";
import { perfTime } from "@/lib/perf";

/** Legacy standalone database, drained by {@link migrateLegacyFolded}. */
export const LEGACY_FOLDED_DB_NAME = "armada-concord-cache";

const STORE = "kv";
const KEY_PREFIX = "folded:";
const DONE_KEY = "folded:migrated";

/** Namespace a caller's key inside the shared KV keyspace. */
function foldedKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

// ── codec ─────────────────────────────────────────────────────────────────────
// Tagged wrappers for types JSON drops. Hex is used for bytes (compact, stable).

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { __t: "bigint", v: value.toString() };
  if (value instanceof Uint8Array) return { __t: "u8", v: toHex(value) };
  if (value instanceof Map) return { __t: "map", v: [...value.entries()] };
  if (value instanceof Set) return { __t: "set", v: [...value.values()] };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__t" in (value as Record<string, unknown>)) {
    const tagged = value as { __t: string; v: unknown };
    switch (tagged.__t) {
      case "bigint": return BigInt(tagged.v as string);
      case "u8": return fromHex(tagged.v as string);
      case "map": return new Map(tagged.v as [unknown, unknown][]);
      case "set": return new Set(tagged.v as unknown[]);
    }
  }
  return value;
}

/** Serialize a folded value (with bigint/Uint8Array/Map/Set) to a string. */
export function encode(value: unknown): string {
  return JSON.stringify(value, replacer);
}

/** Deserialize a string produced by {@link encode}, or undefined on failure. */
export function decode<T>(json: string): T | undefined {
  try {
    return JSON.parse(json, reviver) as T;
  } catch {
    return undefined;
  }
}

// ── store ──────────────────────────────────────────────────────────────────────

/** Read a cached folded value by key, or undefined on miss / error. */
export async function readFolded<T>(key: string): Promise<T | undefined> {
  try {
    await migrateLegacyFolded();
    const json = await getArmadaDB().kv.get<string>(foldedKey(key));
    // A non-string is a value written as `undefined` (KV normalizes that to
    // null), which reads back as a miss — the pre-KV behavior.
    // Counted apart from the KV read: the reviver rebuilds Map/Set/Uint8Array
    // from a string that, for a control fold, can be megabytes.
    return typeof json === "string"
      ? await perfTime("fold.decode", async () => decode<T>(json), () => json.length, "chars")
      : undefined;
  } catch {
    return undefined;
  }
}

type FoldedWriteListener = (key: string) => void;
const foldedWriteListeners = new Set<FoldedWriteListener>();

/**
 * Observe fold-snapshot writes. Consumers that build state from PERSISTED folds
 * rather than a live one — the wire's subscription spec — have no other signal
 * that a fold changed, so a control edition altering neither the epoch nor the
 * channel count would go unnoticed until their next poll. Returns an
 * unsubscribe.
 */
export function onFoldedWrite(listener: FoldedWriteListener): () => void {
  foldedWriteListeners.add(listener);
  return () => {
    foldedWriteListeners.delete(listener);
  };
}

/** Persist a folded value by key (best-effort; failures are swallowed). */
export async function writeFolded(key: string, value: unknown): Promise<void> {
  try {
    // Before the write, not just before reads: a write that landed first would
    // be clobbered by the drain copying the stale legacy value over it.
    await migrateLegacyFolded();
    await getArmadaDB().kv.set(foldedKey(key), encode(value));
    for (const listener of foldedWriteListeners) {
      try {
        // Listeners match on the caller's key, so the prefix stays internal.
        listener(key);
      } catch {
        // A listener must never break the write path.
      }
    }
  } catch {
    // Best-effort cache.
  }
}

// ── migration ─────────────────────────────────────────────────────────────────

let drain: Promise<void> | undefined;

/**
 * Copy the standalone fold cache into KV. Idempotent; runs at most once per
 * session.
 *
 * Awaited by BOTH accessors above rather than left to the startup gate, which
 * is what keeps the drain ordering honest: `rumorMigration`'s own drain reads
 * folds (the cached community list and control fold are how it attributes
 * rumors to communities), and it reaches them only through `readFolded`. So it
 * cannot observe a pre-drain state no matter which drain the gate runs first,
 * or whether it was triggered lazily outside the gate at all.
 *
 * REJECTS when the copy fails. The startup gate deletes the legacy databases
 * only if every drain resolved, so a drain that swallowed its own error and
 * resolved anyway would hand the gate a green light to delete data it never
 * copied. Both accessors above already guard the call.
 */
export function migrateLegacyFolded(): Promise<void> {
  drain ??= drainLegacyFolded().catch((err: unknown) => {
    // Retry next call rather than caching the rejection, then re-report so the
    // gate keeps its hands off the legacy database.
    drain = undefined;
    throw err;
  });
  return drain;
}

async function drainLegacyFolded(): Promise<void> {
  // Ask the SHARED flag before this drain's own marker. `migrations:complete` is
  // strictly stronger ("every drain finished and the legacy databases are gone")
  // and is memoised process-wide, so on a warm boot this whole function costs
  // nothing rather than one KV read per session in front of the first — and
  // therefore boot-critical — fold read. `skipLegacyDrain` consults it first
  // anyway; this only stops the private marker from being read ahead of it.
  if (await legacyMigrationsComplete()) return;
  const db = getArmadaDB();
  if (await db.kv.get<boolean>(DONE_KEY)) return;
  if (typeof indexedDB === "undefined") return;
  // `openDB` CREATES the database when it is absent, so a device that never
  // had one would end up with an empty database named exactly like the thing
  // the startup gate looks for.
  if (await skipLegacyDrain(LEGACY_FOLDED_DB_NAME)) return;

  const legacy = await openDB(LEGACY_FOLDED_DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  });
  try {
    // The legacy store held the SAME encoded strings, so this is a copy, not a
    // re-encode: nothing is decoded and re-serialized on the way through.
    const [keys, values] = await Promise.all([
      legacy.getAllKeys(STORE),
      legacy.getAll(STORE),
    ]);
    for (const [i, key] of keys.entries()) {
      const value: unknown = values[i];
      if (typeof key === "string" && typeof value === "string") {
        await db.kv.set(foldedKey(key), value);
      }
    }
  } finally {
    legacy.close();
  }

  await db.kv.set(DONE_KEY, true);
}

/** Test seam: forget the memoised drain so the next access runs it again. */
export function __resetFoldedForTests(): void {
  drain = undefined;
}
