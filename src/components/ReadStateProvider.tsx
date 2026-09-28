import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ReadStateContext,
  type ReadStateMap,
} from "@/contexts/ReadStateContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEncryptedSettings } from "@/hooks/useEncryptedSettings";
import { useSettingsDoc } from "@/hooks/useSettingsDoc";

const EMPTY: ReadStateMap = {};

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
  } catch { /* ignore */ }
}

function mergeReadState(a: ReadStateMap, b: ReadStateMap): ReadStateMap {
  const out: ReadStateMap = { ...a };
  for (const [key, ts] of Object.entries(b)) {
    if (!out[key] || ts > out[key]) out[key] = ts;
  }
  return out;
}

const SYNC_DEBOUNCE_MS = 4000;

/**
 * Per-conversation last-read timestamps: localStorage cache plus the debounced
 * `${APP_ID}/read-state` NIP-78 document for cross-device sync. Its own
 * document because it's unbounded (never pruned).
 */
export function ReadStateProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const automaticSettingsSync = config.automaticSettingsSync !== false;
  const { doc, isFetched, update, hasNip44Support } = useSettingsDoc("read-state");
  // Legacy home of this map, merged in as a second source (max-per-key is commutative).
  const { doc: metadata } = useEncryptedSettings();
  const pubkey = user?.pubkey;

  const isFetchedRef = useRef(false);
  useEffect(() => {
    isFetchedRef.current = isFetched;
  }, [isFetched]);

  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSync = useRef<ReadStateMap | null>(null);

  const [readState, setReadState] = useState<ReadStateMap>(() =>
    pubkey ? loadLocal(pubkey) : EMPTY,
  );

  useEffect(() => {
    setReadState(pubkey ? loadLocal(pubkey) : EMPTY);
    // Never publish one account's read-state into another's settings.
    pendingSync.current = null;
    if (flushTimer.current) clearTimeout(flushTimer.current);
  }, [pubkey]);

  const scheduleSync = useCallback(
    (map: ReadStateMap) => {
      pendingSync.current = map;
      if (!automaticSettingsSync || !hasNip44Support) return;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => {
        const next = pendingSync.current;
        if (!next) return;
        // Never publish before the stored doc is read: this map replaces it wholesale,
        // which is only safe once hydration has folded it in.
        if (!isFetchedRef.current) return;
        pendingSync.current = null;
        update({ readState: next }).catch((err) =>
          console.warn("Read-state sync failed:", err),
        );
      }, SYNC_DEBOUNCE_MS);
    },
    [automaticSettingsSync, hasNip44Support, update],
  );

  // Opt-out stops the debounce but keeps the local map for later re-enable.
  useEffect(() => {
    if (automaticSettingsSync) return;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
  }, [automaticSettingsSync]);

  useEffect(() => {
    if (!automaticSettingsSync || !isFetched || !pendingSync.current) return;
    scheduleSync(pendingSync.current);
  }, [automaticSettingsSync, isFetched, scheduleSync]);

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
        const changed = Object.keys(merged).some((k) => merged[k] !== prev[k]);
        if (!changed) return prev;
        saveLocal(pubkey, merged);
        return merged;
      });
    },
    [pubkey],
  );

  // Merge-hydrate here (not NostrSync) so it's ordered against the flush above.
  useEffect(() => {
    if (!automaticSettingsSync || !pubkey) return;
    const absorb = (incoming: ReadStateMap) => {
      if (pendingSync.current) {
        pendingSync.current = mergeReadState(pendingSync.current, incoming);
      }
      hydrate(incoming);
    };
    if (doc?.readState) absorb(doc.readState);
    if (metadata?.readState) absorb(metadata.readState);
  }, [
    automaticSettingsSync,
    pubkey,
    doc?.readState,
    metadata?.readState,
    hydrate,
  ]);

  const value = useMemo(
    () => ({ readState, getLastRead, markRead, hydrate }),
    [readState, getLastRead, markRead, hydrate],
  );

  return <ReadStateContext.Provider value={value}>{children}</ReadStateContext.Provider>;
}
