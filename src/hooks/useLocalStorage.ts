import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Generic localStorage state. The setter is REFERENCE-STABLE per `key`: it backs
 * `AppProvider`'s `updateConfig`, which sits in many effect dependency arrays.
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

  // Via a ref: callers often pass a fresh `{ serialize, deserialize }` literal per render.
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;

  // The value the next update builds on: committed state plus any update not yet rendered.
  const latestRef = useRef(state);
  const assign = useCallback((next: T) => {
    latestRef.current = next;
    setState(next);
  }, []);

  // A no-op returns before reaching React: an eagerly bailed-out update stays queued on the
  // fiber until it next renders, and this one (AppProvider's config) rarely does, so every
  // unchanged write would keep its caller's closures — and their render — alive.
  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    const prev = latestRef.current;
    const next = value instanceof Function ? value(prev) : value;
    if (Object.is(next, prev)) return;
    try {
      localStorage.setItem(key, serializeRef.current(next));
    } catch (error) {
      console.warn(`Failed to save ${key} to localStorage:`, error);
    }
    assign(next);
  }, [key, assign]);

  // The useState initializer runs once, so a key change (e.g. user-scoped keys) needs a re-read.
  useEffect(() => {
    try {
      const item = localStorage.getItem(key);
      assign(item ? deserialize(item) : defaultValue);
    } catch (error) {
      console.warn(`Failed to load ${key} from localStorage:`, error);
      assign(defaultValue);
    }
  // defaultValue is excluded: re-read only when the key changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Sync with localStorage changes from other tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        try {
          assign(deserialize(e.newValue));
        } catch (error) {
          console.warn(`Failed to sync ${key} from localStorage:`, error);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [key, deserialize, assign]);

  return [state, setValue] as const;
}