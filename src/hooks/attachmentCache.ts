import { useEffect, useState } from "react";

/**
 * A per-session memo of something derived from an attachment's bytes, keyed
 * by the attachment's URL rather than the per-decrypt object URL it resolved
 * to. What it holds may be derived from decrypted plaintext, so every cache
 * made here is cleared with the purge (`purgeClientStorage`).
 */
export interface AttachmentCache<T> {
  /** Seed with a value already computed elsewhere (the composer's local file). */
  prime(key: string, value: T): void;
  clear(): void;
  /**
   * The value for `key`. Computed from `src` when given and not already
   * known; without one only a known value is returned.
   */
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
