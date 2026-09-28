import { useEffect, useState } from "react";

/**
 * A per-session memo of something derived from an attachment's bytes, keyed by
 * attachment URL. May hold plaintext-derived data, so it's cleared on purge.
 */
export interface AttachmentCache<T> {
  /** Seed with a value already computed elsewhere (the composer's local file). */
  prime(key: string, value: T): void;
  clear(): void;
  /** The value for `key`, computed from `src` if given and unknown; else only a known value. */
  useValue(key: string, src?: string): T | undefined;
}

export function createAttachmentCache<T>(options: {
  /** Entries kept; the oldest goes first. */
  max: number;
  read: (src: string) => Promise<T>;
  /** Frees what an evicted value holds (an object URL). */
  dispose?: (value: T) => void;
}): AttachmentCache<T> {
  const settled = new Map<string, T>();
  const pending = new Map<string, Promise<T | undefined>>();

  const settle = (key: string, value: T) => {
    const previous = settled.get(key);
    if (previous !== undefined && previous !== value) options.dispose?.(previous);
    settled.delete(key);
    settled.set(key, value);
    while (settled.size > options.max) {
      const [oldest, entry] = settled.entries().next().value!;
      options.dispose?.(entry);
      settled.delete(oldest);
    }
  };

  const load = (key: string, src: string): Promise<T | undefined> => {
    let promise = pending.get(key);
    if (!promise) {
      const p: Promise<T | undefined> = options.read(src).then((value) => {
        // A purge while the read was in flight dropped this entry; don't refill.
        if (pending.get(key) !== p) return undefined;
        pending.delete(key);
        settle(key, value);
        return value;
      });
      promise = p;
      pending.set(key, promise);
    }
    return promise;
  };

  return {
    prime: settle,
    clear() {
      if (options.dispose) for (const value of settled.values()) options.dispose(value);
      settled.clear();
      pending.clear();
    },
    useValue(key, src) {
      const [value, setValue] = useState<T | undefined>(() => settled.get(key));
      useEffect(() => {
        const done = settled.get(key);
        if (done !== undefined) {
          setValue(done);
          return;
        }
        setValue(undefined);
        if (!src) return;
        let live = true;
        void load(key, src).then((result) => {
          if (live) setValue(result);
        });
        return () => {
          live = false;
        };
      }, [key, src]);
      return value;
    },
  };
}
