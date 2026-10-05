import { replaceEqualDeep } from "@tanstack/react-query";

/**
 * `structuralSharing` for a cached array of rows, pairing old and new rows by
 * KEY. TanStack's default pairs by INDEX, so merging a page of older history
 * shifts every position and rebuilds every row as a new object, defeating every
 * memoized row and per-row WeakMap cache (the flood fold re-normalized the whole
 * window per page). Unchanged rows keep their identity; an unchanged array keeps its own.
 */
export function shareRowsBy<T extends object>(keyOf: (row: T) => string): (oldData: unknown, newData: unknown) => unknown {
  return (oldData, newData) => {
    if (oldData === newData) return oldData;
    if (!Array.isArray(oldData) || !Array.isArray(newData)) return replaceEqualDeep(oldData, newData);
    const prev = new Map<string, T>();
    for (const row of oldData as T[]) prev.set(keyOf(row), row);
    let same = oldData.length === newData.length;
    const out = new Array<T>(newData.length);
    for (let i = 0; i < newData.length; i++) {
      const row = newData[i] as T;
      const old = prev.get(keyOf(row));
      const shared = old === undefined ? row : (replaceEqualDeep(old, row) as T);
      out[i] = shared;
      if (same && shared !== oldData[i]) same = false;
    }
    return same ? oldData : out;
  };
}

/** Rows keyed by NIP-01 event / rumor `id`. */
export const shareById = shareRowsBy<{ id: string }>((row) => row.id);
/** Rows keyed by `rumorId` (opened Concord / NIP-17 rumors). */
export const shareByRumorId = shareRowsBy<{ rumorId: string }>((row) => row.rumorId);
