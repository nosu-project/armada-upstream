import { useEffect, useState } from "react";

import { onDesktopWindowHidden } from "@/lib/desktop";

/**
 * Stops playing media when the desktop window closes to the tray (the renderer
 * keeps running). Pauses `src`-backed `<video>`/`<audio>` — not `srcObject`
 * (calls survive) or muted (GIF-videos) ones — and remounts cross-origin
 * embeds via `useEmbedPauseEpoch`.
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

/** Changes on each pause; embeds key their iframe on it to tear the player down. */
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
