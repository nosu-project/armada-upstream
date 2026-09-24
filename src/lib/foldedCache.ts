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
import { perfCount, perfTime } from "@/lib/perf";

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
// Table-driven: a control fold's decode revives megabytes of hex on the boot
// path, where per-byte `slice`+`parseInt`/`padStart` dominated the profile.

const BYTE_HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
// Char code → nibble value. Out-of-range indexes read undefined, which the
// bit-ops below coerce to 0 — same result the old parseInt NaN produced for
// malformed hex once assigned into the Uint8Array.
const HEX_NIBBLE = new Uint8Array(103); // 'f' (102) is the highest hex char
for (let i = 0; i < 10; i++) HEX_NIBBLE[48 + i] = i; // '0'-'9'
for (let i = 0; i < 6; i++) {
  HEX_NIBBLE[97 + i] = 10 + i; // 'a'-'f'
  HEX_NIBBLE[65 + i] = 10 + i; // 'A'-'F'
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += BYTE_HEX[b];
  return s;
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (HEX_NIBBLE[hex.charCodeAt(i * 2)] << 4) | HEX_NIBBLE[hex.charCodeAt(i * 2 + 1)];
  }
  return out;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { __t: "bigint", v: value.toString() };
  if (value instanceof Uint8Array) return { __t: "u8", v: toHex(value) };
  if (value instanceof Map) return { __t: "map", v: [...value.entries()] };
  if (value instanceof Set) return { __t: "set", v: [...value.values()] };
  return value;
}

/**
 * Rebuild the tagged wrappers bottom-up, in place, over a plain parse result.
 *
 * A `JSON.parse` reviver is called for EVERY node — every string and number in
 * a multi-megabyte fold, almost none of which carry a tag. Walking only the
 * objects measured 5.2x faster on identical bytes (9.1 MB fold: 160ms → 31ms);
 * see foldedCache.perf.test.ts.
 *
 * In-place assignment is safe because the input is always a fresh `JSON.parse`
 * result and every key assigned was just enumerated on it: a `"__proto__"` key
 * is therefore an OWN data property (which is what `JSON.parse` creates, unlike
 * an object literal), shadowing `Object.prototype`'s accessor.
 */
function revive(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;

  if (Array.isArray(node)) {
    const array = node as unknown[];
    for (let i = 0; i < array.length; i++) {
      const child = array[i];
      if (child !== null && typeof child === "object") array[i] = revive(child);
    }
    return array;
  }

  const object = node as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    const child = object[key];
    if (child !== null && typeof child === "object") object[key] = revive(child);
  }

  // Children first, so a Map's entries and a Set's values are already live
  // shapes when the wrapper is unwrapped — the order a reviver imposes.
  const tag = object.__t;
  if (tag !== undefined) {
    switch (tag) {
      case "bigint": return BigInt(object.v as string);
      case "u8": return fromHex(object.v as string);
      case "map": return new Map(object.v as [unknown, unknown][]);
      case "set": return new Set(object.v as unknown[]);
    }
  }
  return object;
}

/** Serialize a folded value (with bigint/Uint8Array/Map/Set) to a string. */
export function encode(value: unknown): string {
  return JSON.stringify(value, replacer);
}

/**
 * Deserialize a string produced by {@link encode}, or undefined on failure.
 * The walk starts at the parse result itself: the ROOT may be a tagged value
 * (`rekey.ts` persists a bare `Uint8Array`).
 */
export function decode<T>(json: string): T | undefined {
  try {
    return revive(JSON.parse(json)) as T;
  } catch {
    return undefined;
  }
}

// ── store ──────────────────────────────────────────────────────────────────────

/**
 * The serialized value last read from or written to each key this session.
 *
 * A write whose encoding matches is skipped outright — no KV write, no
 * listeners. Folds are recomputed far more often than they change, and every
 * `useControlFold` instance (a community's page, its rail button, its mention
 * probe…) persists the same fold independently; on Android each of those
 * writes was a ~180 KB string through the single Capacitor plugin thread, and
 * each re-woke every `onFoldedWrite` listener into re-reading every fold.
 * Measured on a Pixel: 38 identical writes (6.9 MB) in 15 s, with every other
 * bridge call — the UI's reads included — queued ~8 s behind them.
 */
const knownEncoding = new Map<string, string>();

/** Read a cached folded value by key, or undefined on miss / error. */
export async function readFolded<T>(key: string): Promise<T | undefined> {
  try {
    await migrateLegacyFolded();
    if (import.meta.env.VITE_PROFILE === "1") {
      // Profiling builds: who reads each fold family, by call site.
      const site = new Error().stack?.split("\n").slice(2, 4).join(" < ").replace(/https?:\/\/[^/]+/g, "") ?? "?";
      perfCount(`readFolded ${key.split(":")[0]} @ ${site}`, 0);
    }
    const json = await getArmadaDB().kv.get<string>(foldedKey(key));
    if (typeof json === "string") knownEncoding.set(key, json);
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

/**
 * Decoded values handed out by {@link readFoldedShared}, with the encoding
 * they were decoded from. Replaced on every write of the key.
 */
const sharedDecoded = new Map<string, { json: string; value: unknown }>();

/**
 * {@link readFolded}, but ONE decoded object per key for the session: repeat
 * reads cost neither a KV round trip nor a decode. For values every reader
 * treats as immutable — the control folds, which `useDeferredFold` already
 * shares between instances in memory.
 *
 * The plain read is per-call on purpose (a reader may mutate what it gets);
 * this one exists because the control folds are read constantly — the wire
 * spec, stream auth, the switcher and every fold hook mounting, ~5 reads a
 * second on a 25-community account — and on Android each read of a ~200 KB
 * fold crossed the Capacitor bridge as a JavaScript string (measured: 16.8 MB
 * in a minute, 43 s of the database thread's time) and was then decoded again
 * on the UI thread, ~100 ms apiece.
 */
export async function readFoldedShared<T>(key: string): Promise<T | undefined> {
  const hit = sharedDecoded.get(key);
  if (hit && knownEncoding.get(key) === hit.json) return hit.value as T;
  // A key found EMPTY stays empty until something writes it (writeFolded
  // clears this): a channel with no sync cursor yet was otherwise re-read on
  // every open, by every reader.
  if (sharedMissing.has(key)) return undefined;
  // Readers that arrive while the first read is in flight share it: a boot
  // mounts dozens of fold hooks at once, and each missing the cache on its own
  // was a bridge crossing apiece.
  let pending = sharedInFlight.get(key);
  if (!pending) {
    pending = readFolded<unknown>(key).then((value) => {
      const json = knownEncoding.get(key);
      if (value !== undefined && json !== undefined) sharedDecoded.set(key, { json, value });
      else if (value === undefined && json === undefined) sharedMissing.add(key);
      return value;
    });
    sharedInFlight.set(key, pending);
    void pending.finally(() => {
      if (sharedInFlight.get(key) === pending) sharedInFlight.delete(key);
    });
  }
  return (await pending) as T | undefined;
}

const sharedInFlight = new Map<string, Promise<unknown>>();
/** Keys a shared read found empty, until the next write of the key. */
const sharedMissing = new Set<string>();

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

/**
 * Persist a folded value by key (best-effort; failures are swallowed). A value
 * whose encoding matches what the key already holds is not written again (see
 * {@link knownEncoding}). `encoded` is the caller's own {@link encode} of
 * `value`, when it already has one — encoding a large fold is not free.
 */
export async function writeFolded(key: string, value: unknown, encoded?: string): Promise<void> {
  try {
    const json = encoded ?? encode(value);
    if (knownEncoding.get(key) === json) return;
    // Before the write, not just before reads: a write that landed first would
    // be clobbered by the drain copying the stale legacy value over it.
    await migrateLegacyFolded();
    // Recorded before the await, so concurrent writers of the same content
    // (every instance persisting one fold at once) collapse to one.
    knownEncoding.set(key, json);
    sharedMissing.delete(key);
    // The written object IS the decoded value of `json`; shared readers get it
    // without a round trip.
    if (value !== undefined) sharedDecoded.set(key, { json, value });
    else sharedDecoded.delete(key);
    try {
      await getArmadaDB().kv.set(foldedKey(key), json);
    } catch (error) {
      // Not on disk after all: let the next write try again.
      if (knownEncoding.get(key) === json) knownEncoding.delete(key);
      throw error;
    }
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
  knownEncoding.clear();
  sharedDecoded.clear();
  sharedInFlight.clear();
  sharedMissing.clear();
}
