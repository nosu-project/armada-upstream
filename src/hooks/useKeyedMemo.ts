import { useRef } from "react";

/**
 * A `useMemo` that remembers its last value PER KEY (bounded LRU), so oscillating between
 * keys (e.g. Concord channels) returns the SAME reference when deps are unchanged and downstream
 * memos bail. A dep change still recomputes. eslint's exhaustive-deps does not lint `deps`.
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
