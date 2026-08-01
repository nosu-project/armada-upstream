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
import { getArmadaDB } from "@/lib/db/armadaDB";

const KEY_PREFIX = "folded:";

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
    const json = await getArmadaDB().kv.get<string>(foldedKey(key));
    // A non-string is a value written as `undefined` (KV normalizes that to
    // null), which reads back as a miss — the pre-KV behavior.
    return typeof json === "string" ? decode<T>(json) : undefined;
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
