import type { ReadStateMap } from "@/contexts/ReadStateContext";

/**
 * Past this much JSON the recent delta is folded into the base document. A
 * read republishes the delta, so this bounds what every other device downloads
 * per read; the base (the whole map, ~76 KB on a long-lived account) is then
 * rewritten only when the delta outgrows it.
 */
export const READ_STATE_ROLLOVER_BYTES = 8 * 1024;

export type ReadStatePublish =
  | { kind: "none" }
  /** Publish `readState` as `read-state-recent`. */
  | { kind: "recent"; readState: ReadStateMap }
  /** Publish the whole local map as `read-state`, then an empty `read-state-recent`. */
  | { kind: "rollover" };

/** The entries of `local` newer than `base`'s. */
export function readStateDelta(local: ReadStateMap, base: ReadStateMap): ReadStateMap {
  const out: ReadStateMap = {};
  for (const [key, ts] of Object.entries(local)) {
    if (ts > (base[key] ?? 0)) out[key] = ts;
  }
  return out;
}

/**
 * What a flush of `local` must publish, given the newest `base` and `recent`
 * documents this device holds. Both documents merge max-per-key, so the delta
 * against `base` is self-contained: it replaces `recent` without losing an
 * entry another device put there, because `local` has already absorbed it.
 */
export function planReadStatePublish(
  local: ReadStateMap,
  base: ReadStateMap,
  recent: ReadStateMap,
): ReadStatePublish {
  const delta = readStateDelta(local, base);
  const entries = Object.entries(delta);
  if (entries.length === 0) return { kind: "none" };
  if (entries.every(([key, ts]) => (recent[key] ?? 0) >= ts)) return { kind: "none" };
  if (JSON.stringify(delta).length > READ_STATE_ROLLOVER_BYTES) return { kind: "rollover" };
  return { kind: "recent", readState: delta };
}
