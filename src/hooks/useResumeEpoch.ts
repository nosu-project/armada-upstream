/**
 * Increments when the app returns after being away at least `minAwayMs` (a RESUME, not an
 * alt-tab). Driven by React Query's `focusManager` (visibility on web, Capacitor `appStateChange`
 * on native — see App.tsx) so there's one definition of "came back".
 */
import { focusManager } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function useResumeEpoch(minAwayMs: number): number {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    // Mounting while hidden starts the away clock now.
    let awayAt: number | undefined = focusManager.isFocused() ? undefined : Date.now();

    // `setFocused` notifies only on real transitions.
    return focusManager.subscribe(() => {
      if (!focusManager.isFocused()) {
        awayAt ??= Date.now();
        return;
      }
      const wasAway = awayAt !== undefined && Date.now() - awayAt >= minAwayMs;
      awayAt = undefined;
      if (wasAway) setEpoch((n) => n + 1);
    });
  }, [minAwayMs]);

  return epoch;
}
