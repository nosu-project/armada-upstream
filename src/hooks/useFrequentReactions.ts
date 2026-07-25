import { useMemo, useSyncExternalStore } from "react";

/** A reaction the user has picked before, with how often and how recently. */
export interface FrequentReaction {
  /** The display key (emoji, 👍/👎, or `:shortcode:`). */
  key: string;
  /** Custom emoji image URL when the key is a `:shortcode:`. */
  url?: string;
  /** How many times the user has reacted with this key. */
  count: number;
  /** Unix seconds of the most recent use, as a tie-breaker. */
  usedAt: number;
}

const STORAGE_PREFIX = "armada:frequent-reactions:";

/** Cap on stored entries — the tail is pruned lowest-score-first on write. */
const MAX_STORED = 32;

/**
 * Seeds the quick row until the user has picked enough of their own. A fresh
 * account still gets a one-tap row rather than an empty gap next to the picker,
 * which is what makes the shortcut discoverable in the first place.
 */
const DEFAULT_KEYS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

const EMPTY: FrequentReaction[] = [];

/**
 * Per-pubkey frequency table, cached in memory so `getSnapshot` returns a
 * referentially stable array (required by `useSyncExternalStore` — re-parsing
 * localStorage on every call would loop forever).
 */
const cache = new Map<string, FrequentReaction[]>();
const listeners = new Set<() => void>();

function load(pubkey: string): FrequentReaction[] {
  const hit = cache.get(pubkey);
  if (hit) return hit;
  let parsed: FrequentReaction[] = EMPTY;
  try {
    const raw = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${pubkey}`) ?? "");
    if (Array.isArray(raw)) {
      parsed = raw.filter(
        (e): e is FrequentReaction => !!e && typeof e.key === "string" && typeof e.count === "number",
      );
    }
  } catch {
    // Unset or corrupt — start empty; the defaults still fill the row.
  }
  cache.set(pubkey, parsed);
  return parsed;
}

function save(pubkey: string, entries: FrequentReaction[]): void {
  cache.set(pubkey, entries);
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${pubkey}`, JSON.stringify(entries));
  } catch {
    // localStorage full/unavailable — the in-memory table still stands.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Most-used first, ties broken by most-recent. */
function byScore(a: FrequentReaction, b: FrequentReaction): number {
  return b.count - a.count || b.usedAt - a.usedAt;
}

/**
 * Record that the user reacted with `key`. Call this only when ADDING a
 * reaction — retracting one shouldn't promote it up the row.
 */
export function recordReaction(pubkey: string | undefined, key: string, url?: string): void {
  if (!pubkey || !key) return;
  const now = Math.floor(Date.now() / 1000);
  const prev = load(pubkey);
  const existing = prev.find((e) => e.key === key);
  const next = existing
    ? prev.map((e) => (e.key === key ? { ...e, url: url ?? e.url, count: e.count + 1, usedAt: now } : e))
    : [...prev, { key, url, count: 1, usedAt: now }];
  next.sort(byScore);
  save(pubkey, next.slice(0, MAX_STORED));
}

/**
 * The user's most-used reactions, padded with defaults, for the quick-reaction
 * row on a message's action toolbar (the Discord/Slack shortcut that skips the
 * picker for the common case).
 */
export function useFrequentReactions(pubkey: string | undefined, limit = 3): FrequentReaction[] {
  const stored = useSyncExternalStore(
    subscribe,
    () => (pubkey ? load(pubkey) : EMPTY),
    () => EMPTY,
  );

  return useMemo(() => {
    const top = [...stored].sort(byScore).slice(0, limit);
    if (top.length >= limit) return top;
    // Pad with defaults the user hasn't already earned a slot for, so the row
    // is always full-width and its buttons don't shift position as it fills in.
    const seen = new Set(top.map((e) => e.key));
    for (const key of DEFAULT_KEYS) {
      if (top.length >= limit) break;
      if (seen.has(key)) continue;
      seen.add(key);
      top.push({ key, count: 0, usedAt: 0 });
    }
    return top;
  }, [stored, limit]);
}

/** Test seam: drops the in-memory table so a fresh read hits localStorage. */
export function resetFrequentReactionsCache(): void {
  cache.clear();
}
