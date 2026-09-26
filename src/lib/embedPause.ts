import { useEffect, useState } from "react";

import { onDesktopWindowHidden } from "@/lib/desktop";

/**
 * Stops playing media when the desktop window is closed to the tray.
 *
 * Closing the window only hides it, and the renderer keeps running (its relay
 * subscriptions have to), so anything audible carries on with no window left
 * to stop it from. Two kinds of player need stopping:
 *
 * - `<video>`/`<audio>` elements in the page, which are paused directly. Only
 *   those playing from a `src` — a call's LiveKit tracks are attached through
 *   `srcObject` and must keep playing, since a call survives closing to the
 *   tray. Muted elements are left alone too: a looping GIF-video makes no
 *   sound, and pausing it would leave it frozen when the window comes back.
 * - Cross-origin embed iframes (YouTube, Spotify, Streamable), which expose no
 *   pause the page can call without loading each provider's player API. They
 *   subscribe with `useEmbedPauseEpoch` and remount their player instead.
 */

const listeners = new Set<() => void>();

export function pausePlayingMedia(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLMediaElement>("video, audio")) {
    if (el.paused || el.muted || el.srcObject) continue;
    try {
      el.pause();
    } catch {
      // A detached element; nothing is playing through it.
    }
  }
  for (const listener of listeners) listener();
}

let installed = false;

/** Wire the pause to the desktop shell's close-to-tray signal (once). */
export function installEmbedPause(): void {
  if (installed) return;
  installed = true;
  onDesktopWindowHidden(() => pausePlayingMedia());
}

/**
 * A number that changes each time playing media is paused. An embed keys its
 * iframe on it (or resets its state when it changes) so the provider's player
 * is torn down and playback stops.
 */
export function useEmbedPauseEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const listener = () => setEpoch((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return epoch;
}
