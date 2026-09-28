/**
 * Process-wide registry of mounted chat audio players: starting one pauses the
 * others, and a finished one auto-advances to the next in document order.
 */

interface AudioEntry {
  readonly el: HTMLAudioElement | null;
  play: () => void;
}

const entries = new Set<AudioEntry>();

export function registerAudioPlayer(entry: AudioEntry): () => void {
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}

/** Pause every registered player except `except`. */
export function pauseOthers(except: HTMLAudioElement): void {
  for (const entry of entries) {
    if (entry.el && entry.el !== except && !entry.el.paused) {
      entry.el.pause();
    }
  }
}

/** Start the closest player following `current` in document order, if any. */
export function playNextAfter(current: HTMLAudioElement): void {
  let next: AudioEntry | undefined;
  for (const entry of entries) {
    if (!entry.el || entry.el === current) continue;
    const following =
      (current.compareDocumentPosition(entry.el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (!following) continue;
    if (
      !next ||
      !next.el ||
      (entry.el.compareDocumentPosition(next.el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    ) {
      next = entry;
    }
  }
  next?.play();
}
