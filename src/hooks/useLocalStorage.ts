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

  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    // Functional setState so batched calls and non-setter updates (key re-read, `storage`
    // listener) are seen.
    setState((prev) => {
      const next = value instanceof Function ? value(prev) : value;
      if (next === prev) return prev;
      try {
        localStorage.setItem(key, serializeRef.current(next));
      } catch (error) {
        console.warn(`Failed to save ${key} to localStorage:`, error);
      }
      return next;
    });
  }, [key]);

  // The useState initializer runs once, so a key change (e.g. user-scoped keys) needs a re-read.
  useEffect(() => {
    try {
      const item = localStorage.getItem(key);
      setState(item ? deserialize(item) : defaultValue);
    } catch (error) {
      console.warn(`Failed to load ${key} from localStorage:`, error);
      setState(defaultValue);
    }
  // defaultValue is excluded: re-read only when the key changes.
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