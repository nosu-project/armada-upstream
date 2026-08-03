import { useEffect, useRef, useState } from "react";

import { encode, readFolded, writeFolded } from "@/lib/foldedCache";

/**
 * Process-lifetime memory of the last live fold per key. Seeds `restored`
 * SYNCHRONOUSLY when a key comes back into view (e.g. cycling between
 * communities), so the panel repaints the correct, already-computed fold in the
 * same frame instead of blanking to `undefined` while the IndexedDB snapshot
 * reloads after paint — which reads as a flash of empty channels. Keyed by the
 * community-scoped fold key, so it can only ever return THIS key's own value
 * (no cross-community leak). Untyped by necessity (one cache across all fold
 * types); each caller only ever reads back the type it wrote for its key.
 */
const memCache = new Map<string, unknown>();

/**
 * How long a fold may be deferred, measured from the moment it became owed —
 * NOT from the latest reschedule.
 *
 * Deferring is a trade against a frame that is already painted, so it has to be
 * bounded by something a dependency burst cannot push back. See the scheduling
 * effect for what happens when it isn't.
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
 * the two rules below are what keep it that trade instead of an open-ended
 * delay — see the scheduling effect.
 *
 * `key` namespaces the persisted snapshot (e.g. `roster:<cid>`). `compute`
 * returns the freshly-folded value (or `undefined` when inputs aren't ready).
 * `deps` is the dependency list that should trigger a recompute (the shared
 * control events, the community, any upstream fold). Returns the value to
 * render: the live fold when computed, else the persisted snapshot.
 *
 * `accept` vets a snapshot RESTORED FROM DISK, which arrives as `JSON.parse`
 * behind an unchecked cast and may therefore have been written by a build whose
 * shape differed (see `isCurrentFoldedControl`). One it rejects is treated as a
 * miss: `compute` fills in, and the next persist replaces it. The in-memory
 * cache is not vetted — this process wrote those, so they are this shape by
 * construction.
 */
export function useDeferredFold<T>(
  key: string | null,
  compute: () => T | undefined,
  deps: unknown[],
  accept?: (value: unknown) => boolean,
): T | undefined {
  const [live, setLive] = useState<T | undefined>(undefined);
  // Seed the initial snapshot from the in-memory cache so a fresh mount of a
  // key we've folded before this session (e.g. a cross-pattern remount back
  // into a community) paints its channels/title immediately, not blank.
  const [restored, setRestored] = useState<T | undefined>(() =>
    key ? (memCache.get(key) as T | undefined) : undefined,
  );
  const lastWritten = useRef<string | undefined>(undefined);
  // Keep the latest `compute` without making it a scheduling dependency.
  const computeRef = useRef(compute);
  computeRef.current = compute;
  // Same, for the snapshot check: a caller passing an inline predicate must not
  // re-run the restore (and re-read IndexedDB) on every render.
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  // Whether there is anything on screen for a deferral to protect. Read (not
  // depended on) by the scheduling effect, so a `live`/`restored` change never
  // by itself reschedules a fold.
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
  //
  // Seed `restored` from the in-memory cache for the NEW key (not the old one)
  // so a key we've already folded this session repaints its own channels/title
  // in the same frame — no empty flash while its IndexedDB snapshot reloads.
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setLive(undefined);
    setRestored(key ? (memCache.get(key) as T | undefined) : undefined);
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
      if (cancelled || v === undefined) return;
      // A snapshot this build can't read is a miss, not something to render.
      if (acceptRef.current && !acceptRef.current(v)) return;
      setRestored(v);
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
  // Both bounds exist because the plain "cancel on every dep change, re-arm an
  // idle callback" schedule is unbounded in exactly the case that needs it most.
  // A cold boot ingests a replay over the wire, whose `c2ctl:<id>` bus ring
  // (coalesced at 50ms) re-seeds the control events; each re-seed cancelled the
  // pending idle callback — its own `timeout` and all — and armed a fresh one,
  // so the fold was re-armed faster than any idle slot arrived and did not run
  // for the length of the burst. Downstream that is `channels === []`, hence no
  // ChannelV2, hence a channel timeline query that stays DISABLED: an empty chat
  // pane for as long as the wire is busy, with the messages already on disk.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      deadlineRef.current = undefined;
      setLive(computeRef.current());
    };

    // Nothing is painted, so there is nothing to defer FOR: on a first-ever open
    // there is no persisted snapshot and no memo entry, and everything
    // downstream is blocked on this fold. Deferring work the whole view waits on
    // only lengthens the empty frame. Run it here — still post-commit, so the
    // shell has been handed to the browser first.
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
    // Keep the in-memory cache hot so cycling back to this key repaints
    // synchronously (see the key-change seed above).
    memCache.set(key, live);
    const serialized = encode(live);
    if (serialized === lastWritten.current) return;
    lastWritten.current = serialized;
    void writeFolded(key, live);
  }, [key, live]);

  return live ?? restored;
}
