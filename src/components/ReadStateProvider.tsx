import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ReadStateContext,
  type ReadStateMap,
} from "@/contexts/ReadStateContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useSettingsDoc } from "@/hooks/useSettingsDoc";

const EMPTY: ReadStateMap = {};

/** Per-user localStorage key for the read-state cache. */
function storageKey(pubkey: string): string {
  return `armada:read-state:${pubkey}`;
}

function loadLocal(pubkey: string): ReadStateMap {
  try {
    const raw = localStorage.getItem(storageKey(pubkey));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ReadStateMap) : {};
  } catch {
    return {};
  }
}

function saveLocal(pubkey: string, map: ReadStateMap): void {
  try {
    localStorage.setItem(storageKey(pubkey), JSON.stringify(map));
  } catch {
    // localStorage unavailable — ignore.
  }
}

/** Merge two read-state maps, keeping the newer (max) timestamp per key. */
function mergeReadState(a: ReadStateMap, b: ReadStateMap): ReadStateMap {
  const out: ReadStateMap = { ...a };
  for (const [key, ts] of Object.entries(b)) {
    if (!out[key] || ts > out[key]) out[key] = ts;
  }
  return out;
}

/** Debounce window (ms) before flushing read-state to encrypted settings. */
const SYNC_DEBOUNCE_MS = 4000;

/**
 * Provides per-conversation read-state (last-read timestamps) for unread and
 * mention badges. Backed by a per-user localStorage cache for instant/offline
 * reads and mirrored into the user's `${APP_ID}/read-state` NIP-78 document
 * (debounced) so unread carries across devices.
 *
 * This is the largest and only genuinely unbounded settings document — an
 * entry per conversation ever opened, never pruned — which is most of why it
 * has one of its own rather than riding along with the theme.
 */
export function ReadStateProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const { doc, isFetched, update, hasNip44Support } = useSettingsDoc("read-state");
  // The pre-split home of this map, for the migration window. Merged in as a
  // second source rather than arbitrated against: "max timestamp per key" is
  // commutative, so the union of the two is simply the right answer.
  const { doc: metadata } = useEncryptedSettings();
  const pubkey = user?.pubkey;

  // Whether the document has been read from the store, readable from the
  // debounced flush without restarting the debounce every time the query
  // re-resolves.
  const isFetchedRef = useRef(false);
  useEffect(() => {
    isFetchedRef.current = isFetched;
  }, [isFetched]);

  // Debounced sync of dirty keys to encrypted settings.
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSync = useRef<ReadStateMap | null>(null);

  const [readState, setReadState] = useState<ReadStateMap>(() =>
    pubkey ? loadLocal(pubkey) : EMPTY,
  );

  // Re-load the cache when the account changes.
  useEffect(() => {
    setReadState(pubkey ? loadLocal(pubkey) : EMPTY);
    // Drop anything still queued for the previous account — publishing one
    // user's read-state into another's settings event would be worse than
    // losing it, and it's already durable in that account's localStorage.
    pendingSync.current = null;
    if (flushTimer.current) clearTimeout(flushTimer.current);
  }, [pubkey]);

  const scheduleSync = useCallback(
    (map: ReadStateMap) => {
      if (!hasNip44Support) return;
      pendingSync.current = map;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => {
        const next = pendingSync.current;
        if (!next) return;
        // Never publish before the stored document has been read. This map is
        // replaced wholesale, and what makes that safe is that hydration has
        // already folded the stored map into this one — so publishing off a
        // not-yet-resolved read would drop every read cut made on another
        // device. Keep the pending map and let the effect below retry.
        if (!isFetchedRef.current) return;
        pendingSync.current = null;
        update({ readState: next }).catch((err) =>
          console.warn("Read-state sync failed:", err),
        );
      }, SYNC_DEBOUNCE_MS);
    },
    [hasNip44Support, update],
  );

  // Retry a sync that was held back for want of a base, once one has been
  // read. Reads stay in localStorage meanwhile, so nothing is lost — they just
  // haven't reached the user's other devices yet.
  useEffect(() => {
    if (!isFetched || !pendingSync.current) return;
    scheduleSync(pendingSync.current);
  }, [isFetched, scheduleSync]);

  // Flush any pending sync on unmount.
  useEffect(() => {
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, []);

  const getLastRead = useCallback(
    (key: string) => readState[key] ?? 0,
    [readState],
  );

  const markRead = useCallback(
    (key: string, timestamp: number) => {
      if (!pubkey) return;
      setReadState((prev) => {
        if ((prev[key] ?? 0) >= timestamp) return prev;
        const next = { ...prev, [key]: timestamp };
        saveLocal(pubkey, next);
        scheduleSync(next);
        return next;
      });
    },
    [pubkey, scheduleSync],
  );

  const hydrate = useCallback(
    (map: ReadStateMap) => {
      if (!pubkey) return;
      setReadState((prev) => {
        const merged = mergeReadState(prev, map);
        // Avoid a write/re-render when nothing changed.
        const changed = Object.keys(merged).some((k) => merged[k] !== prev[k]);
        if (!changed) return prev;
        saveLocal(pubkey, merged);
        return merged;
      });
    },
    [pubkey],
  );

  // Merge-hydrate (max timestamp wins) so reads made on another device mark
  // conversations read here too. Lives here rather than in NostrSync so it is
  // ordered against the flush above by construction: the map a flush publishes
  // is always one that has already absorbed the stored document.
  useEffect(() => {
    if (!pubkey) return;
    if (doc?.readState) hydrate(doc.readState);
    if (metadata?.readState) hydrate(metadata.readState);
  }, [pubkey, doc?.readState, metadata?.readState, hydrate]);

  const value = useMemo(
    () => ({ readState, getLastRead, markRead, hydrate }),
    [readState, getLastRead, markRead, hydrate],
  );

  return <ReadStateContext.Provider value={value}>{children}</ReadStateContext.Provider>;
}
