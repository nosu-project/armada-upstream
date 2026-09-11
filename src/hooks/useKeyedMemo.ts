import { useRef } from "react";

/**
 * A `useMemo` that remembers its last value PER KEY, not just the last render.
 *
 * `useMemo` holds exactly one cached value, so oscillating inputs — cycling
 * between two Concord channels/communities — recompute every time even when
 * returning to a key whose inputs are unchanged. That recompute produces a
 * fresh array/object identity, which cascades a rebuild through every
 * downstream `useMemo` keyed on it (the whole `useTransport` derivation), all
 * abandoned as garbage on the next switch — the allocation pressure a profile
 * showed feeding a major GC on a Concord→Concord switch.
 *
 * This keeps a small bounded (LRU) cache keyed by `key`, so switching back to a
 * recently-seen key returns the SAME reference when its `deps` are unchanged,
 * letting the downstream memo chain bail instead of reallocating. Semantics are
 * otherwise identical to `useMemo`: a dep change recomputes, so a stale value is
 * never returned — the cache only ever extends memoization across key
 * oscillation, never past a real input change.
 *
 * NOTE: eslint's exhaustive-deps does not lint this hook's `deps`, so callers
 * must pass exactly what a `useMemo` would.
 */
export function useKeyedMemo<T>(key: string | null, factory: () => T, deps: readonly unknown[], cap = 8): T {
  const cacheRef = useRef<Map<string, { deps: readonly unknown[]; value: T }>>(undefined);
  cacheRef.current ??= new Map();
  const cache = cacheRef.current;
  const k = key ?? "\u0000null";

  const hit = cache.get(k);
  if (hit && depsEqual(hit.deps, deps)) {
    // Refresh LRU recency.
    cache.delete(k);
    cache.set(k, hit);
    return hit.value;
  }

  const value = factory();
  cache.delete(k);
  cache.set(k, { deps, value });
  // Evict oldest beyond the cap — a bounded working set of recent keys, so the
  // cache itself never becomes the unbounded retention it exists to reduce.
  while (cache.size > cap) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return value;
}

function depsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
