import { useEffect, useRef, useState } from "react";

import { readFoldSync, writeFoldSync } from "@/lib/concord/foldSnapshot";
import { encode, readFolded, writeFolded } from "@/lib/concord/foldedCache";

/**
 * Persist + restore a DECRYPTED/folded Concord value (roster, metadata) across
 * reloads. The restore is SYNCHRONOUS on the first render: it reads the last
 * fold from an in-memory mirror (hydrated from localStorage at module load), so
 * the member list / server name / channel names paint on frame 1 after a hard
 * refresh instead of cascading in behind a chain of async IndexedDB reads. A
 * deeper IndexedDB copy backs it up (larger budget); once the live fold —
 * recomputed from the freshly re-read control events — is available it takes
 * over and is written back to both for next time.
 *
 * `live` is the freshly-folded value (or undefined until the control events
 * load/fold). `key` namespaces the cache entry (e.g. `roster:<cid>`). Returns
 * the value to render: the live fold when present, else the persisted snapshot.
 */
export function usePersistedFold<T>(key: string | null, live: T | undefined): T | undefined {
  // Synchronous first-paint value from the localStorage-backed mirror.
  const [restored, setRestored] = useState<T | undefined>(() =>
    key ? readFoldSync<T>(key) : undefined,
  );
  // Last-written serialization, so a 30s refetch that re-folds an IDENTICAL
  // value (new object, same content) doesn't churn a write.
  const lastWritten = useRef<string | undefined>(undefined);

  // Re-read synchronously when the key changes (community switch), then fall
  // back to the deeper IndexedDB copy if the sync mirror missed it.
  useEffect(() => {
    if (!key) {
      setRestored(undefined);
      return;
    }
    const sync = readFoldSync<T>(key);
    if (sync !== undefined) {
      setRestored(sync);
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

  // Persist the live fold whenever its CONTENT changes (best-effort), to both
  // the synchronous mirror (frame-1 next time) and the IndexedDB backup.
  useEffect(() => {
    if (!key || live === undefined) return;
    const serialized = encode(live);
    if (serialized === lastWritten.current) return;
    lastWritten.current = serialized;
    writeFoldSync(key, serialized);
    void writeFolded(key, live);
  }, [key, live]);

  return live ?? restored;
}
