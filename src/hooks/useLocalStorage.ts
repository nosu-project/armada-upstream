import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Generic hook for managing localStorage state.
 *
 * The returned setter is REFERENCE-STABLE for the life of the hook (as long as
 * `key` doesn't change). That is load-bearing rather than cosmetic: this hook
 * backs `AppProvider`'s config, whose setter is handed to 67 files as
 * `updateConfig` and appears in ~15 `useEffect`/`useCallback` dependency
 * arrays. A setter recreated per render put a fresh identity in every one of
 * those, so effects that read as "run when the relay list changes" re-ran on
 * every render of their component instead.
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  serializer?: {
    serialize: (value: T) => string;
    deserialize: (value: string) => T;
  }
) {
  const serialize = serializer?.serialize || JSON.stringify;
  const deserialize = serializer?.deserialize || JSON.parse;

  const [state, setState] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? deserialize(item) : defaultValue;
    } catch (error) {
      console.warn(`Failed to load ${key} from localStorage:`, error);
      return defaultValue;
    }
  });

  // The serializer, read by the stable `setValue` below without becoming a
  // dependency of it — callers commonly pass a fresh `{ serialize, deserialize }`
  // literal per render, which would otherwise make the setter unstable again.
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;

  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    // Still React's functional setState, for the reason it always was: the
    // updater receives the latest state even when several `setValue` calls are
    // batched before a re-render, and even when the state was last moved by
    // something other than this setter (the key-change re-read and the
    // cross-tab `storage` listener below both call `setState` directly).
    // Reading a ref here instead would miss those.
    setState((prev) => {
      const next = value instanceof Function ? value(prev) : value;
      // Nothing changed — an updater that returned its input, or a direct
      // write of the value already held.
      if (next === prev) return prev;
      try {
        localStorage.setItem(key, serializeRef.current(next));
      } catch (error) {
        console.warn(`Failed to save ${key} to localStorage:`, error);
      }
      return next;
    });
  }, [key]);

  // Re-read from localStorage when the key changes (e.g. user-scoped keys
  // switching to a different user). The useState initializer only runs once,
  // so changing the key prop requires an explicit re-sync.
  useEffect(() => {
    try {
      const item = localStorage.getItem(key);
      setState(item ? deserialize(item) : defaultValue);
    } catch (error) {
      console.warn(`Failed to load ${key} from localStorage:`, error);
      setState(defaultValue);
    }
  // defaultValue is intentionally excluded — we only want to re-read when
  // the key identity changes, not when a new default reference is passed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Sync with localStorage changes from other tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        try {
          setState(deserialize(e.newValue));
        } catch (error) {
          console.warn(`Failed to sync ${key} from localStorage:`, error);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [key, deserialize]);

  return [state, setValue] as const;
}