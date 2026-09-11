import { useEffect, useRef, useState } from "react";

const DEFAULT_DEADLINE_MS = 250;

/**
 * A `useMemo` whose compute runs after paint, in an idle callback, no later
 * than `deadlineMs` after it became due (a burst of dep changes does not push
 * the deadline back). Returns `undefined` until the first compute for `key`
 * lands and resets to `undefined` synchronously when `key` changes.
 *
 * eslint's exhaustive-deps does not check `deps`.
 */
export function useIdleMemo<T>(
  key: string | null,
  compute: () => T,
  deps: readonly unknown[],
  deadlineMs = DEFAULT_DEADLINE_MS,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const deadlineRef = useRef<number | undefined>(undefined);

  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setValue(undefined);
    deadlineRef.current = undefined;
  }

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      deadlineRef.current = undefined;
      setValue(computeRef.current());
    };
    const now = Date.now();
    deadlineRef.current ??= now + deadlineMs;
    if (now >= deadlineRef.current) {
      run();
      return;
    }
    const handle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(run, { timeout: deadlineRef.current - now })
        : (setTimeout(run, 0) as unknown as number);
    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
      else clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, deadlineMs, ...deps]);

  return value;
}
