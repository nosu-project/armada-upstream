import { useEffect, useRef, useState } from "react";

import { encode, readFolded, writeFolded } from "@/lib/concord/foldedCache";

/**
 * Persist + restore a DECRYPTED/folded Concord value (roster, metadata) across
 * reloads. On mount it loads the last-folded value from IndexedDB so the UI
 * paints from cache (a frame or two after first render) instead of waiting for
 * the raw control events to be re-read + re-decrypted + re-folded; once the live
 * fold — recomputed from the freshly re-read control events — is available it
 * takes over and is written back for next time.
 *
 * `live` is the freshly-folded value (or undefined until the control events
 * load/fold). `key` namespaces the cache entry (e.g. `roster:<cid>`). Returns
 * the value to render: the live fold when present, else the persisted snapshot.
 */
export function usePersistedFold<T>(key: string | null, live: T | undefined): T | undefined {
  const [restored, setRestored] = useState<T | undefined>(undefined);
  // Last-written serialization, so a 30s refetch that re-folds an IDENTICAL
  // value (new object, same content) doesn't churn an IndexedDB write.
  const lastWritten = useRef<string | undefined>(undefined);

  // Reset synchronously (during render) when the key changes: if the NEW key's
  // IndexedDB read misses (first visit), `restored` must not keep serving the
  // PREVIOUS key's value — that leaks one community's fold into another.
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setRestored(undefined);
    lastWritten.current = undefined;
  }

  // Load the persisted snapshot from IndexedDB once per key.
  useEffect(() => {
    if (!key) {
      setRestored(undefined);
      return;
    }
    let cancelled = false;
    void readFolded<T>(key).then((v) => {
      if (!cancelled && v !== undefined) setRestored(v);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Persist the live fold whenever its CONTENT changes (best-effort).
  useEffect(() => {
    if (!key || live === undefined) return;
    const serialized = encode(live);
    if (serialized === lastWritten.current) return;
    lastWritten.current = serialized;
    void writeFolded(key, live);
  }, [key, live]);

  return live ?? restored;
}
