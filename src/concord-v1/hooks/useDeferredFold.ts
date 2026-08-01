import { useEffect, useRef, useState } from "react";

import { encode, readFolded, writeFolded } from "@/lib/foldedCache";

/**
 * How long a fold may be deferred, measured from the moment it became owed —
 * NOT from the latest reschedule. See {@link useDeferredFold}'s scheduling
 * effect, and its V2 twin in `concord-v2/hooks/useDeferredFold2.ts`.
 */
const FOLD_DEADLINE_MS = 250;

/**
 * Compute a heavy synchronous Concord fold (roster / metadata / banlist) WITHOUT
 * blocking the render-critical path, and persist/restore it across reloads.
 *
 * The folds (`foldRoster`/`foldMetadata`/`foldBanlist`) decrypt + Schnorr-verify
 * every control edition (up to 500) and were previously run inside a `useMemo`,
 * i.e. synchronously DURING render on every mount/refresh. On a community with a
 * large control history that synchronous burst starves the first paint — the
 * channel's loading skeleton sits while the main thread verifies the whole
 * control plane.
 *
 * This hook moves the fold OFF the render path: it schedules the `compute` thunk
 * after paint (idle callback, deadline-bounded) so React can commit and the
 * browser can paint the cached UI first, then the fold runs and updates state.
 * Combined with the persisted snapshot (painted immediately on reload), the
 * heavy work never gates the first frame. The decode/verify itself is already
 * memoized per edition id (see `control.ts`), so subsequent recomputes are cheap.
 *
 * Deferring is only ever a trade against a frame that is ALREADY PAINTED, and
 * the scheduling effect below is what keeps it that trade instead of an
 * open-ended delay.
 *
 * `key` namespaces the persisted snapshot (e.g. `roster:<cid>`). `compute`
 * returns the freshly-folded value (or `undefined` when inputs aren't ready).
 * `deps` is the dependency list that should trigger a recompute (the shared
 * control events, the community, any upstream fold). Returns the value to
 * render: the live fold when computed, else the persisted snapshot.
 */
export function useDeferredFold<T>(
  key: string | null,
  compute: () => T | undefined,
  deps: unknown[],
): T | undefined {
  const [live, setLive] = useState<T | undefined>(undefined);
  const [restored, setRestored] = useState<T | undefined>(undefined);
  const lastWritten = useRef<string | undefined>(undefined);
  // Keep the latest `compute` without making it a scheduling dependency.
  const computeRef = useRef(compute);
  computeRef.current = compute;
  // Whether there is anything on screen for a deferral to protect. Read (not
  // depended on) by the scheduling effect.
  const paintableRef = useRef(false);
  paintableRef.current = live !== undefined || restored !== undefined;
  // When the currently-owed fold is DUE. Set once per "fold is owed" period and
  // deliberately NOT reset by a reschedule.
  const deadlineRef = useRef<number | undefined>(undefined);

  // Reset synchronously (during render) the moment the key changes, so one
  // community's fold can NEVER render — or persist — under another community's
  // key. Without this, switching A → B keeps A's `live` fold on screen until
  // B's deferred recompute lands, and if B's compute returns undefined (its
  // control events haven't loaded) while B has no persisted snapshot, the hook
  // would fall back to A's stale `restored` — leaking A's roster/metadata/
  // banlist into B (and letting A's ban set moderate B's messages).
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setLive(undefined);
    setRestored(undefined);
    lastWritten.current = undefined;
    deadlineRef.current = undefined;
  }

  // Restore the persisted snapshot once per key so the UI paints from cache.
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

  // Recompute the live fold AFTER commit, not during render — but never later
  // than a deadline a dependency burst cannot move, and never at all when there
  // is no painted frame to protect. `key` is included so a key change always
  // reschedules a compute even if the caller's deps happen to be referentially
  // stable across the switch.
  //
  // Cancelling on every dep change and re-arming an idle callback is unbounded
  // in the case that needs it most: while the app is ingesting a burst, the fold
  // is re-armed (its `timeout` reset with it) faster than an idle slot arrives,
  // so it never runs and everything derived from it stays empty. See the V2
  // twin's comment for the concrete symptom.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      deadlineRef.current = undefined;
      setLive(computeRef.current());
    };

    // Nothing painted, so nothing to defer FOR — deferring work the whole view
    // is blocked on only lengthens the empty frame.
    if (!paintableRef.current) {
      run();
      return;
    }

    const now = Date.now();
    deadlineRef.current ??= now + FOLD_DEADLINE_MS;
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
  }, [key, ...deps]);

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
