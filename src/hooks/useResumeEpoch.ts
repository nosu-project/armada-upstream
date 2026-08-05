/**
 * A counter that increments when the app comes back after being away long
 * enough to have missed something.
 *
 * The seam is React Query's `focusManager`, which is already driven from both
 * platforms: the browser's `visibilitychange` by default, and Capacitor's
 * `appStateChange` on native (see App.tsx — the WebView's own visibility events
 * are unreliable there). Subscribing to it means one definition of "the app
 * came back" rather than a second listener that can disagree with the first.
 *
 * The `minAwayMs` floor is what separates a RESUME from an alt-tab. A standing
 * subscription is expensive to tear down and rebuild, and a two-second glance at
 * another window missed nothing; an hour in the background missed everything.
 */
import { focusManager } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function useResumeEpoch(minAwayMs: number): number {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    // If we mount while already hidden, the clock starts now — a mount in the
    // background still counts its away time from the moment we could observe it.
    let awayAt: number | undefined = focusManager.isFocused() ? undefined : Date.now();

    // `setFocused` only notifies on an actual change, so this fires on real
    // blur/focus transitions rather than on every event.
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
